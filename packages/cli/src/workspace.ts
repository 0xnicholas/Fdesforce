import { dirname, resolve } from 'node:path';

import { asRecord, asString, exists, isDirectory, isFile, readDocument } from './fsutil.js';
import type { Diagnostic } from './types.js';

/**
 * A Customer workspace: the directory that owns `fde.workspace.yaml`, the
 * vendored platform store it points at, and the Customer asset roots. This is
 * tooling configuration, not a domain document — a Customer repo can commit it
 * next to `customer/` and `solutions/`.
 */
export interface Workspace {
  root: string;
  platformRoot: string;
  assets: {
    connectors?: string;
    contextPackages?: string;
    evalSuites?: string;
    datasets?: string;
    policies?: string;
  };
}

export interface WorkspaceResult {
  workspace?: Workspace;
  errors: Diagnostic[];
}

const WORKSPACE_FILE = 'fde.workspace.yaml';

const ASSET_KEYS = ['connectors', 'contextPackages', 'evalSuites', 'datasets', 'policies'] as const;

export interface WorkspaceOptions {
  /** Explicit `--workspace`; otherwise discovered by walking up from `startDir`. */
  workspaceDir?: string;
  /** Explicit `--platform`; overrides the manifest's `platform` path. */
  platformDir?: string;
  startDir: string;
}

export function loadWorkspace(options: WorkspaceOptions): WorkspaceResult {
  const errors: Diagnostic[] = [];
  const start = resolve(options.startDir);
  const manifestDir =
    options.workspaceDir !== undefined ? resolve(options.workspaceDir) : findWorkspace(start);

  if (manifestDir === undefined) {
    if (options.platformDir === undefined) {
      errors.push({
        code: 'workspace_missing',
        message: `no ${WORKSPACE_FILE} found from ${start} upward, and no --platform was given`,
        remediation: `pass --workspace <dir> or --platform <dir>`,
      });
      return { errors };
    }
    return finish({ root: start, assetsRoot: undefined, platformDir: options.platformDir, errors });
  }

  const manifestPath = resolve(manifestDir, WORKSPACE_FILE);
  if (!isFile(manifestPath)) {
    errors.push({
      code: 'workspace_missing',
      message: `${WORKSPACE_FILE} does not exist in ${manifestDir}`,
      path: manifestPath,
      remediation: 'pass --workspace with the directory that contains the workspace manifest',
    });
    return { errors };
  }

  const document = readDocument(manifestPath, 'workspace manifest');
  if (!document.ok) {
    errors.push({ ...document.error, code: 'workspace_invalid' });
    return { errors };
  }

  const platforms = document.value['platform'];
  const platformFromManifest = asString(platforms);
  if (platforms !== undefined && platformFromManifest === undefined) {
    errors.push({
      code: 'workspace_invalid',
      message: '`platform` must be a path relative to the workspace manifest',
      path: 'platform',
      remediation: 'write `platform: ../../../platform` (the vendored platform store)',
    });
  }

  const assets = asRecord(document.value['assets']);
  if (document.value['assets'] !== undefined && Object.keys(assets).length === 0) {
    errors.push({
      code: 'workspace_invalid',
      message: '`assets` must map asset categories to directories',
      path: 'assets',
      remediation: `declare any of ${ASSET_KEYS.join(', ')}`,
    });
  }
  for (const key of Object.keys(assets)) {
    if (!(ASSET_KEYS as readonly string[]).includes(key)) {
      errors.push({
        code: 'workspace_invalid',
        message: `unknown asset root \`${key}\``,
        path: `assets.${key}`,
        remediation: `use one of ${ASSET_KEYS.join(', ')}`,
      });
    } else if (asString(assets[key]) === undefined) {
      errors.push({
        code: 'workspace_invalid',
        message: `asset root \`${key}\` must be a path`,
        path: `assets.${key}`,
      });
    }
  }
  for (const key of Object.keys(document.value)) {
    if (key !== 'platform' && key !== 'assets') {
      errors.push({
        code: 'workspace_invalid',
        message: `unknown workspace key \`${key}\``,
        path: key,
        remediation: 'the workspace manifest accepts `platform` and `assets`',
      });
    }
  }

  if (errors.length > 0) return { errors };

  const platformDir =
    options.platformDir !== undefined
      ? resolve(options.platformDir)
      : platformFromManifest !== undefined
        ? resolve(manifestDir, platformFromManifest)
        : undefined;

  return finish({ root: manifestDir, assetsRoot: manifestDir, platformDir, assets, errors });
}

function findWorkspace(start: string): string | undefined {
  let current = start;
  for (;;) {
    if (exists(resolve(current, WORKSPACE_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function finish(input: {
  root: string;
  assetsRoot: string | undefined;
  platformDir: string | undefined;
  assets?: Record<string, unknown>;
  errors: Diagnostic[];
}): WorkspaceResult {
  const errors = input.errors;

  if (input.platformDir === undefined) {
    errors.push({
      code: 'platform_missing',
      message: 'the workspace manifest does not point at a platform artifact store',
      path: 'platform',
      remediation: 'add `platform: <path to vendored platform/>` or pass --platform',
    });
    return { errors };
  }
  if (!isDirectory(input.platformDir)) {
    errors.push({
      code: 'platform_missing',
      message: `platform artifact store ${input.platformDir} does not exist`,
      path: 'platform',
      remediation: 'vendor the platform store or fix the path in the workspace manifest',
    });
    return { errors };
  }

  const assets: Workspace['assets'] = {};
  for (const key of ASSET_KEYS) {
    const value = asString(input.assets?.[key]);
    if (value === undefined) continue;
    const root = resolve(input.assetsRoot ?? input.root, value);
    if (!isDirectory(root)) {
      errors.push({
        code: 'asset_root_missing',
        message: `asset root ${root} (${key}) does not exist`,
        path: `assets.${key}`,
        remediation: 'create the directory, vendor the asset, or remove the entry',
      });
      continue;
    }
    assets[key] = root;
  }

  if (errors.length > 0) return { errors };
  return { workspace: { root: input.root, platformRoot: input.platformDir, assets }, errors };
}
