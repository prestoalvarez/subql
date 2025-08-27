// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import fs from 'fs';
import os from 'os';
import path from 'path';
import {handleCreateSubqueryProjectError, IPFSReader, LocalReader, makeTempDir, ReaderFactory} from '@subql/common';
import {IEndpointConfig, Reader} from '@subql/types-core';
import {camelCase, isNil, omitBy} from 'lodash';
import {ISubqueryProject} from '../indexer';
import {getLogger, setDebugFilter} from '../logger';
import {exitWithError} from '../process';
import {defaultSubqueryName, rebaseArgsWithManifest} from '../utils';
import {IConfig, NodeConfig} from './NodeConfig';
import {IProjectUpgradeService, ProjectUpgradeService, upgradableSubqueryProject} from './ProjectUpgrade.service';

const logger = getLogger('configure');

// Check if a subquery name is a valid schema name
export function validDbSchemaName(name: string): boolean {
  if (name.length === 0) {
    return false;
  } else {
    name = name.toLowerCase();
    const regexp = new RegExp('^[a-zA-Z_][a-zA-Z0-9_\\-\\/]{0,62}$');
    const flag0 = !name.startsWith('pg_'); // Reserved identifier
    const flag1 = regexp.test(name); // <= Valid characters, less than 63 bytes
    if (!flag0) {
      logger.error(`Invalid schema name '${name}', schema name must not be prefixed with 'pg_'`);
    }
    if (!flag1) {
      logger.error(
        `Invalid schema name '${name}', schema name must start with a letter or underscore,
         be less than 63 bytes and must contain only valid alphanumeric characters (can include characters '_-/')`
      );
    }
    return flag0 && flag1;
  }
}

// Cant seem to use the inferred types, strings arent converted to unions
type Args = Record<string, any>; //ReturnType<typeof yargsBuilder>['argv']

function processEndpointConfig(raw?: string | string[]): IEndpointConfig[] {
  if (!raw) return [];
  if (typeof raw === 'string') return [JSON.parse(raw)];
  if (Array.isArray(raw)) return raw.map((raw) => JSON.parse(raw));
  throw new Error(`Unknown raw value, received: ${raw}`);
}

export function yargsToIConfig(yargs: Args, nameMapping: Record<string, string> = {}): Partial<IConfig> {
  return Object.entries(yargs).reduce((acc, [key, value]) => {
    if (['_', '$0'].includes(key)) return acc;

    const outputKey = nameMapping[key] ?? camelCase(key);

    if (outputKey === 'networkRegistry') {
      try {
        value = JSON.parse(value as string);
      } catch (e) {
        throw new Error('Argument `network-registry` is not valid JSON');
      }
    }

    // Merge network endpoints and possible endpoint configs
    if (outputKey === 'networkEndpoint') {
      const endpointConfig = processEndpointConfig(yargs['network-endpoint-config']);
      if (typeof value === 'string') {
        value = [value];
      }
      if (Array.isArray(value)) {
        value = value.reduce(
          (acc, endpoint, index) => {
            acc[endpoint] = endpointConfig[index] ?? {};
            return acc;
          },
          {} as Record<string, IEndpointConfig>
        );
      }
    }
    if (outputKey === 'primaryNetworkEndpoint') {
      const endpointConfig = processEndpointConfig(yargs['primary-network-endpoint-config']);
      value = [value, endpointConfig[0] ?? {}];
    }
    if (['networkEndpointConfig', 'primaryNetworkEndpointConfig'].includes(outputKey)) return acc;

    if (outputKey === 'disableHistorical' && value) {
      acc.historical = false;
    }
    if (outputKey === 'historical' && value === 'false') {
      value = false;
    }

    acc[outputKey] = value;
    return acc;
  }, {} as any);
}

function warnDeprecations(argv: Args) {
  if (argv['subquery-name']) {
    logger.warn('Note that argument --subquery-name has been deprecated in favour of --db-schema');
  }
}

// This is used to ensure the same temp dir is used across project upgrades and workers
let rootDir: string;
async function getCachedRoot(reader: Reader, configRoot?: string): Promise<string> {
  if (reader instanceof LocalReader) return reader.root;

  // Case for in workers when the parent has decided the directory
  if (configRoot) return configRoot;

  // Allows reusing the same directory on restarts when project is run from ipfs, this can stop duplicating files in the tmp dir
  if (reader instanceof IPFSReader) {
    rootDir = path.resolve(os.tmpdir(), reader.cid);
    if (!fs.existsSync(rootDir)) {
      await fs.promises.mkdir(rootDir);
    }
    return rootDir;
  }

  if (!rootDir) {
    rootDir = await makeTempDir();
  }

  return rootDir;
}

export async function registerApp<P extends ISubqueryProject>(
  argv: Args,
  createProject: (
    path: string,
    rawManifest: unknown,
    reader: Reader,
    root: string,
    networkOverrides: Record<string, unknown>
  ) => Promise<P>,
  showHelp: () => void,
  pjson: any,
  nameMapping?: Record<string, string> // Currently only used by cosmos
): Promise<{nodeConfig: NodeConfig; project: P & IProjectUpgradeService<P>}> {
  let config: NodeConfig;
  let rawManifest: unknown;
  let reader: Reader;

  const isTest = argv._[0] === 'test';

  // Override order : Sub-command/Args/Flags > Manifest Runner options > Default configs
  // Therefore, we should rebase the manifest runner options with args first but not the config in the end
  if (argv.config) {
    // get manifest options
    config = NodeConfig.fromFile(argv.config, yargsToIConfig(argv, nameMapping), isTest);
    reader = await ReaderFactory.create(config.subquery, {
      ipfs: config.ipfs,
    });
    rawManifest = await reader.getProjectSchema();
    rebaseArgsWithManifest(argv, rawManifest);
    // use rebased argv generate config to override current config
    config = NodeConfig.rebaseWithArgs(config, yargsToIConfig(argv, nameMapping));
  } else {
    if (!argv.subquery) {
      showHelp();
      exitWithError('Subquery path is missing in both cli options and config file', logger, 1);
    }

    warnDeprecations(argv);
    reader = await ReaderFactory.create(argv.subquery, {
      ipfs: argv.ipfs,
    });
    rawManifest = await reader.getProjectSchema();
    rebaseArgsWithManifest(argv, rawManifest);
    // Create new nodeConfig with rebased argv
    config = new NodeConfig(defaultSubqueryName(yargsToIConfig(argv, nameMapping)), isTest);
  }

  if (!validDbSchemaName(config.dbSchema)) {
    exitWithError(`invalid schema name ${config.dbSchema}`, undefined, 1);
  }

  if (config.debug) {
    setDebugFilter(config.debug);
  }

  const makeNetworkOverrides = (project?: P) => {
    // Apply the network endpoint and dictionary from the source project to the parent projects if they are not defined in the config
    return omitBy(
      {
        endpoint: config.networkEndpoints ?? project?.network?.endpoint,
        dictionary: config.networkDictionaries ?? project?.network?.dictionary,
      },
      isNil
    );
  };

  const project = await createProject(
    config.subquery,
    rawManifest,
    reader,
    await getCachedRoot(reader, config.root),
    makeNetworkOverrides()
  ).catch((err: any) => {
    handleCreateSubqueryProjectError(err, pjson, rawManifest, logger);
    exitWithError(err, logger, 1);
  });

  const createParentProject = async (cid: string): Promise<P> => {
    cid = `ipfs://${cid}`;
    const reader = await ReaderFactory.create(cid, {
      ipfs: config.ipfs,
    });
    return createProject(
      cid,
      await reader.getProjectSchema(),
      reader,
      await getCachedRoot(reader, config.root),
      makeNetworkOverrides(project)
    );
  };

  const projectUpgradeService = await ProjectUpgradeService.create(project, createParentProject);

  const upgradeableProject = upgradableSubqueryProject(projectUpgradeService);

  return {project: upgradeableProject, nodeConfig: config};
}
