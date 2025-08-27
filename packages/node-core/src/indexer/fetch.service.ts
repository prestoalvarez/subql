// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import {Inject, Injectable, OnApplicationShutdown} from '@nestjs/common';
import {EventEmitter2} from '@nestjs/event-emitter';
import {SchedulerRegistry} from '@nestjs/schedule';
import {BaseDataSource} from '@subql/types-core';
import {range} from 'lodash';
import {IBlockchainService} from '../blockchain.service';
import {NodeConfig} from '../configure';
import {IndexerEvent} from '../events';
import {getLogger} from '../logger';
import {delay, filterBypassBlocks, getModulos} from '../utils';
import {IBlockDispatcher} from './blockDispatcher';
import {mergeNumAndBlocksToNums} from './dictionary';
import {DictionaryService} from './dictionary/dictionary.service';
import {mergeNumAndBlocks} from './dictionary/utils';
import {MultiChainRewindStatus} from './entities';
import {MultiChainRewindService} from './multiChainRewind.service';
import {IStoreModelProvider} from './storeModelProvider';
import {BypassBlocks, IBlock, IProjectService} from './types';
import {IUnfinalizedBlocksServiceUtil} from './unfinalizedBlocks.service';

const logger = getLogger('FetchService');
// Unit is ms
const multiChainRewindDelay = 3;
@Injectable()
export class FetchService<DS extends BaseDataSource, B extends IBlockDispatcher<FB>, FB>
  implements OnApplicationShutdown
{
  private _latestBestHeight?: number;
  private _latestFinalizedHeight?: number;
  private isShutdown = false;

  constructor(
    private nodeConfig: NodeConfig,
    @Inject('IProjectService') protected projectService: IProjectService<DS>,
    @Inject('IBlockDispatcher') protected blockDispatcher: B,
    protected dictionaryService: DictionaryService<DS, FB>,
    private eventEmitter: EventEmitter2,
    private schedulerRegistry: SchedulerRegistry,
    @Inject('IUnfinalizedBlocksService') private unfinalizedBlocksService: IUnfinalizedBlocksServiceUtil,
    @Inject('IStoreModelProvider') private storeModelProvider: IStoreModelProvider,
    @Inject('IBlockchainService') private blockchainSevice: IBlockchainService<DS>,
    private multiChainRewindService: MultiChainRewindService
  ) {}

  private get latestBestHeight(): number {
    assert(this._latestBestHeight !== undefined, new Error('Latest Best Height is not available'));
    return this._latestBestHeight;
  }

  private get latestFinalizedHeight(): number {
    // Devnets don't always finalize blocks, in those cases we set the finalized block to be 0 and we need to specifically check for undefined here.
    assert(this._latestFinalizedHeight !== undefined, new Error('Latest Finalized Height is not available'));
    return this._latestFinalizedHeight;
  }

  protected getModulos(dataSources: DS[]): number[] {
    return getModulos(dataSources, this.blockchainSevice.isCustomDs, this.blockchainSevice.blockHandlerKind);
  }

  onApplicationShutdown(): void {
    try {
      this.schedulerRegistry.deleteInterval('getFinalizedBlockHead');
      this.schedulerRegistry.deleteInterval('getBestBlockHead');
    } catch (e) {
      //ignore if interval not exist
    }
    this.isShutdown = true;
  }

  async init(startHeight: number): Promise<void> {
    const interval = await this.blockchainSevice.getChainInterval();

    await Promise.all([this.getFinalizedBlockHead(), this.getBestBlockHead()]);

    const chainLatestHeight = this.latestHeight();
    if (startHeight > chainLatestHeight) {
      // This is at init stage, lastProcessedHeight should be always - 1 from the startHeight in this case
      // this is reverse calculated from projectService.nextProcessHeight()
      // Alternative, we can expose async function getLastProcessedHeight() to ensure accuracy.
      if (startHeight - 1 === chainLatestHeight) {
        logger.warn(
          `Project last processed height is same as current chain height (${chainLatestHeight}). Please ensure the RPC endpoint provider is behaving correctly.`
        );
      } else {
        throw new Error(
          `The startBlock of dataSources in your project manifest (${startHeight}) is higher than the current chain height (${chainLatestHeight}). Please adjust your startBlock to be less that the current chain height.`
        );
      }
    }

    this.schedulerRegistry.addInterval(
      'getFinalizedBlockHead',
      setInterval(() => void this.getFinalizedBlockHead(), interval)
    );
    this.schedulerRegistry.addInterval(
      'getBestBlockHead',
      setInterval(() => void this.getBestBlockHead(), interval)
    );

    await this.dictionaryService.initDictionaries();
    // Update all dictionaries execute before find one usable dictionary
    this.updateDictionary();
    // Find one usable dictionary at start

    await this.blockDispatcher.init(this.resetForNewDs.bind(this));

    void this.startLoop(startHeight);
  }

  private updateDictionary(): void {
    return this.dictionaryService.buildDictionaryEntryMap(this.projectService.getDataSourcesMap());
  }

  async getFinalizedBlockHead(): Promise<void> {
    try {
      const currentFinalizedHeader = await this.blockchainSevice.getFinalizedHeader();
      // Rpc could return finalized height below last finalized height due to unmatched nodes, and this could lead indexing stall
      // See how this could happen in https://gist.github.com/jiqiang90/ea640b07d298bca7cbeed4aee50776de
      if (
        this._latestFinalizedHeight === undefined ||
        currentFinalizedHeader.blockHeight > this._latestFinalizedHeight
      ) {
        this._latestFinalizedHeight = currentFinalizedHeader.blockHeight;
        this.unfinalizedBlocksService.registerFinalizedBlock(currentFinalizedHeader);
        if (!this.nodeConfig.unfinalizedBlocks) {
          this.eventEmitter.emit(IndexerEvent.BlockTarget, {
            height: this.latestFinalizedHeight,
          });
        }
      }
    } catch (e: any) {
      logger.error(e, `Having a problem when getting finalized block`);
    }
  }

  async getBestBlockHead(): Promise<void> {
    try {
      const currentBestHeight = await this.blockchainSevice.getBestHeight();
      if (this._latestBestHeight !== currentBestHeight) {
        this._latestBestHeight = currentBestHeight;
        this.eventEmitter.emit(IndexerEvent.BlockBest, {
          height: this.latestBestHeight,
        });

        if (this.nodeConfig.unfinalizedBlocks) {
          this.eventEmitter.emit(IndexerEvent.BlockTarget, {
            height: this.latestBestHeight,
          });
        }
      }
    } catch (e: any) {
      logger.error(e, `Having a problem when getting best block`);
    }
  }

  private async startLoop(initBlockHeight: number): Promise<void> {
    await this.fillNextBlockBuffer(initBlockHeight);
  }

  private latestHeight(): number {
    return this.nodeConfig.unfinalizedBlocks ? this.latestBestHeight : this.latestFinalizedHeight;
  }

  // eslint-disable-next-line complexity
  async fillNextBlockBuffer(initBlockHeight: number): Promise<void> {
    let startBlockHeight: number;
    let scaledBatchSize: number;

    const getStartBlockHeight = (): number => {
      return this.blockDispatcher.latestBufferedHeight
        ? this.blockDispatcher.latestBufferedHeight + 1
        : initBlockHeight;
    };

    while (!this.isShutdown) {
      startBlockHeight = getStartBlockHeight();

      scaledBatchSize = this.blockDispatcher.batchSize;

      const latestHeight = this.latestHeight();

      if (this.blockDispatcher.freeSize < scaledBatchSize || startBlockHeight > latestHeight) {
        if (this.blockDispatcher.freeSize < scaledBatchSize) {
          logger.debug(
            `Fetch service is waiting for free space in the block dispatcher queue, free size: ${this.blockDispatcher.freeSize}, scaledBatchSize: ${scaledBatchSize}`
          );
        }
        if (startBlockHeight > latestHeight) {
          logger.debug(
            `Fetch service is waiting for new blocks, startBlockHeight: ${startBlockHeight}, latestHeight: ${latestHeight}`
          );
        }
        await delay(1);
        continue;
      }

      // Update the target height, this happens here to stay in sync with the rest of indexing
      void this.storeModelProvider.metadata.set('targetHeight', latestHeight);

      // If we're rewinding, we should wait until it's done
      const multiChainStatus = this.multiChainRewindService.status;
      if (MultiChainRewindStatus.Complete === multiChainStatus) {
        logger.info(
          `Waiting for all chains to complete rewind, current chainId: ${this.multiChainRewindService.chainId}`
        );
        await delay(multiChainRewindDelay);
        continue;
      }

      // This could be latestBestHeight, dictionary should never include finalized blocks
      // TODO add buffer so dictionary not used when project synced
      if (startBlockHeight < this.latestBestHeight - scaledBatchSize) {
        try {
          const dictionary = await this.dictionaryService.scopedDictionaryEntries(
            startBlockHeight,
            scaledBatchSize,
            latestHeight
          );

          if (startBlockHeight !== getStartBlockHeight()) {
            logger.debug(`Queue was reset for new DS, discarding dictionary query result`);
            continue;
          }
          if (dictionary) {
            const {batchBlocks, lastBufferedHeight} = dictionary;
            // the last block returned from batch should have max height in this batch
            const mergedBlocks = mergeNumAndBlocks(
              this.getModuloBlocks(startBlockHeight, lastBufferedHeight),
              batchBlocks
            );
            if (mergedBlocks.length === 0) {
              // There we're no blocks in this query range, we can set a new height we're up to
              if (startBlockHeight <= lastBufferedHeight) {
                await this.enqueueBlocks([], lastBufferedHeight);
              } else {
                // Exceeds the dictionary search height
                await this.enqueueSequential(startBlockHeight, scaledBatchSize, latestHeight);
              }
            } else {
              const maxBlockSize = Math.min(mergedBlocks.length, this.blockDispatcher.freeSize);
              const enqueueBlocks = mergedBlocks.slice(0, maxBlockSize);
              await this.enqueueBlocks(enqueueBlocks, latestHeight);
            }
            continue; // skip nextBlockRange() way
          } else {
            await this.enqueueSequential(startBlockHeight, scaledBatchSize, latestHeight);
          }
        } catch (e: any) {
          logger.debug(`Fetch dictionary stopped: ${e.message}`);
          this.eventEmitter.emit(IndexerEvent.SkipDictionary);
          await this.enqueueSequential(startBlockHeight, scaledBatchSize, latestHeight);
        }
      } else {
        await this.enqueueSequential(startBlockHeight, scaledBatchSize, latestHeight);
      }
    }
  }

  // get all modulo numbers with a specific block ranges
  private getModuloBlocks(startHeight: number, endHeight: number): number[] {
    // Find relevant ds
    const {endHeight: rangeEndHeight, value: relevantDS} = this.getRelevantDsDetails(startHeight);
    const moduloNumbers = this.getModulos(relevantDS);
    // no modulos in the filters been found in current ds
    if (!moduloNumbers.length) return [];
    const maxModulosBlockHeight = this.nodeConfig.batchSize * Math.max(...moduloNumbers) + startHeight;
    const moduloEndHeight = Math.min(rangeEndHeight ?? Number.MAX_SAFE_INTEGER, maxModulosBlockHeight, endHeight);
    const moduloBlocks: number[] = [];
    for (let i = startHeight; i <= moduloEndHeight; i++) {
      if (moduloNumbers.find((m) => i % m === 0)) {
        moduloBlocks.push(i);
      }
    }
    return moduloBlocks;
  }

  /**
   *
   * @param startBlockHeight
   * @param endBlockHeight is either FinalizedHeight or BestHeight, ensure ModuloBlocks not greater than this number
   */
  private getEnqueuedModuloBlocks(startBlockHeight: number, endBlockHeight: number): (IBlock<FB> | number)[] {
    return this.getModuloBlocks(startBlockHeight, endBlockHeight).slice(0, this.nodeConfig.batchSize);
  }

  private useModuloHandlersOnly(relevantDS: DS[]): boolean {
    // If there are modulos handlers only, then number of moduloNumbers should be match number of with handlers
    const moduloNumbers = this.getModulos(relevantDS);
    const handlers = [...relevantDS.map((ds) => ds.mapping.handlers)].flat();
    return !!handlers.length && moduloNumbers.length === handlers.length;
  }

  private getRelevantDsDetails(startBlockHeight: number): {endHeight: number | undefined; value: DS[]} {
    const details = this.projectService.getDataSourcesMap().getDetails(startBlockHeight);
    assert(details, `Datasources not found for height ${startBlockHeight}`);
    return {endHeight: details.endHeight, value: details.value};
  }

  // Enqueue block sequentially
  private async enqueueSequential(
    startBlockHeight: number,
    scaledBatchSize: number,
    latestHeight: number
  ): Promise<void> {
    // End height from current dataSource
    const {endHeight, value: relevantDs} = this.getRelevantDsDetails(startBlockHeight);
    // Estimated range end height
    const estRangeEndHeight = Math.min(
      endHeight ?? Number.MAX_SAFE_INTEGER,
      this.nextEndBlockHeight(startBlockHeight, scaledBatchSize),
      latestHeight
    );
    const enqueuingBlocks = this.useModuloHandlersOnly(relevantDs)
      ? this.getEnqueuedModuloBlocks(startBlockHeight, latestHeight)
      : range(startBlockHeight, estRangeEndHeight + 1);

    await this.enqueueBlocks(enqueuingBlocks, estRangeEndHeight);
  }

  private async enqueueBlocks(enqueuingBlocks: (IBlock<FB> | number)[], latestHeight: number): Promise<void> {
    const cleanedBatchBlocks = filterBypassBlocks<FB>(enqueuingBlocks, [
      ...this.projectService.bypassBlocks,
      ...this.getDatasourceBypassBlocks(),
    ]);
    await this.blockDispatcher.enqueueBlocks(
      cleanedBatchBlocks,
      this.getLatestBufferHeight(enqueuingBlocks, latestHeight)
    );
  }

  /**
   *
   * @param rawBatchBlocks
   * @param latestHeight
   * @private
   */
  private getLatestBufferHeight(rawBatchBlocks: (IBlock<FB> | number)[], latestHeight: number): number {
    // When both BatchBlocks are empty, mean no blocks to enqueue and full synced,
    // we are safe to update latestBufferHeight to this number
    if (rawBatchBlocks.length === 0) {
      return latestHeight;
    }
    return Math.max(...mergeNumAndBlocksToNums([], rawBatchBlocks));
  }

  /**
   * If a projects datasources are not continuious we can add add them to the bypass blocks
   * */
  private getDatasourceBypassBlocks(): BypassBlocks {
    const datasources = this.projectService.getDataSourcesMap().getAll();

    const heights = Array.from(datasources.keys());

    const bypassBlocks: BypassBlocks = [];

    for (let i = 0; i < heights.length - 1; i++) {
      const currentHeight = heights[i];
      const nextHeight = heights[i + 1];

      const currentDS = datasources.get(currentHeight);
      // If the value for the current height is an empty array, then it's a gap
      if (currentDS?.length === 0) {
        bypassBlocks.push(`${currentHeight}-${nextHeight - 1}`);
      }
    }
    return bypassBlocks;
  }

  private nextEndBlockHeight(startBlockHeight: number, scaledBatchSize: number): number {
    let endBlockHeight = startBlockHeight + scaledBatchSize - 1;

    if (endBlockHeight > this.latestFinalizedHeight) {
      if (this.nodeConfig.unfinalizedBlocks) {
        if (endBlockHeight >= this.latestBestHeight) {
          endBlockHeight = this.latestBestHeight;
        }
      } else {
        endBlockHeight = this.latestFinalizedHeight;
      }
    }
    return endBlockHeight;
  }

  resetForNewDs(blockHeight: number): void {
    this.updateDictionary();
    this.blockDispatcher.flushQueue(blockHeight);
  }

  getLatestFinalizedHeight(): number {
    return this.latestFinalizedHeight;
  }
}
