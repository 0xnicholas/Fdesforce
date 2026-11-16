import { join, resolve, sep } from 'node:path';

import {
  digestFiles,
  parseSolutionLock,
  parseSolutionSpec,
  type FileSetDigest,
  type SolutionLock,
  type SolutionSpec,
} from '@fde/spec';
import { parse as parseYaml } from 'yaml';

import { buildCatalogues, type Catalogues } from './artifacts.js';
import {
  asArray,
  asRecord,
  asString,
  isFile,
  isRecord,
  readDocument,
  readText,
  walkFiles,
} from './fsutil.js';
import { resolveArtifacts, type ResolvedArtifacts } from './resolve.js';
import type { Diagnostic } from './types.js';
import type { Workspace } from './workspace.js';

export interface Toolchain {
  file: string;
  generator: string;
  image: string;
  dockerfile: string;
  versions: { node: string; python: string; semantica: string; contextService: string };
  schemas: { graph: number | string; audit: number | string };
}

export interface Project {
  specDir: string;
  rawSpec?: Record<string, unknown>;
  spec?: SolutionSpec;
  /** Schema diagnostics; cross-document checks only run when this is empty. */
  specErrors: Diagnostic[];
  specFiles: Record<string, string>;
  fileSet?: FileSetDigest;
  fileErrors: Diagnostic[];
  lockPresent: boolean;
  lock?: SolutionLock;
  lockErrors: Diagnostic[];
  catalogues: Catalogues;
  artifacts: ResolvedArtifacts;
  catalogProblems: Diagnostic[];
  toolchain?: Toolchain;
  toolchainErrors: Diagnostic[];
  /** Problems reading `solution.yaml` itself. */
  errors: Diagnostic[];
}

export function loadProject(input: { specDir: string; workspace: Workspace }): Project {
  const specDir = resolve(input.specDir);
  const errors: Diagnostic[] = [];
  const specErrors: Diagnostic[] = [];
  const fileErrors: Diagnostic[] = [];
  const lockErrors: Diagnostic[] = [];
  const toolchainErrors: Diagnostic[] = [];

  const specPath = join(specDir, 'solution.yaml');
  let rawSpec: Record<string, unknown> | undefined;
  if (!isFile(specPath)) {
    errors.push({
      code: 'spec_missing',
      message: `no solution.yaml at ${specDir}`,
      path: specPath,
      remediation: 'pass --spec with a Solution directory, or run `fde spec init`',
    });
  } else {
    try {
      const parsed: unknown = parseYaml(readText(specPath));
      if (isRecord(parsed)) {
        rawSpec = parsed;
      } else {
        errors.push({ code: 'spec_unreadable', message: `${specPath} is not a YAML mapping`, path: specPath });
      }
    } catch (error) {
      errors.push({
        code: 'spec_unreadable',
        message: `${specPath} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
        path: specPath,
      });
    }
  }

  let spec: SolutionSpec | undefined;
  if (rawSpec !== undefined) {
    const parsed = parseSolutionSpec(rawSpec);
    if (parsed.ok) spec = parsed.value;
    else specErrors.push(...parsed.errors);
  }

  const files = rawSpec === undefined ? undefined : collectSpecFiles(specDir, rawSpec);
  if (files !== undefined) fileErrors.push(...files.errors);

  const lock = loadLock(specDir);
  lockErrors.push(...lock.errors);

  const catalogues = buildCatalogues({
    platformRoot: input.workspace.platformRoot,
    assets: input.workspace.assets,
  });
  const artifacts = resolveArtifacts(catalogues, rawSpec ?? {});

  const toolchain = loadToolchain(input.workspace.platformRoot);
  toolchainErrors.push(...toolchain.errors);

  return {
    specDir,
    ...(rawSpec === undefined ? {} : { rawSpec }),
    ...(spec === undefined ? {} : { spec }),
    specErrors,
    specFiles: files?.specFiles ?? {},
    ...(files?.fileSet === undefined ? {} : { fileSet: files.fileSet }),
    fileErrors,
    lockPresent: lock.present,
    ...(lock.lock === undefined ? {} : { lock: lock.lock }),
    lockErrors,
    catalogues,
    artifacts,
    catalogProblems: catalogues.problems,
    ...(toolchain.toolchain === undefined ? {} : { toolchain: toolchain.toolchain }),
    toolchainErrors,
    errors,
  };
}

function loadLock(specDir: string): { present: boolean; lock?: SolutionLock; errors: Diagnostic[] } {
  const path = join(specDir, 'solution.lock');
  const errors: Diagnostic[] = [];
  if (!isFile(path)) return { present: false, errors };

  const document = readDocument(path, 'solution.lock');
  if (!document.ok) {
    errors.push({ ...document.error, code: 'solution_lock_invalid' });
    return { present: true, errors };
  }
  const parsed = parseSolutionLock(document.value);
  if (!parsed.ok) {
    errors.push(
      ...parsed.errors.map((error) => ({ ...error, code: 'solution_lock_invalid' })),
    );
    return { present: true, errors };
  }
  return { present: true, lock: parsed.value, errors };
}

function loadToolchain(platformRoot: string): { toolchain?: Toolchain; errors: Diagnostic[] } {
  const path = join(platformRoot, 'toolchain.yaml');
  const errors: Diagnostic[] = [];
  if (!isFile(path)) {
    errors.push({
      code: 'toolchain_missing',
      message: `no toolchain.yaml in the platform store ${platformRoot}`,
      path,
      remediation: 'vendor the pinned toolchain; a build without a toolchain pin is not reproducible',
    });
    return { errors };
  }

  const document = readDocument(path, 'toolchain');
  if (!document.ok) {
    errors.push({ ...document.error, code: 'toolchain_invalid' });
    return { errors };
  }
  if (document.value['kind'] !== 'Toolchain') {
    errors.push({
      code: 'toolchain_invalid',
      message: `toolchain.yaml declares kind ${String(document.value['kind'])}, expected Toolchain`,
      path,
    });
  }

  const spec = asRecord(document.value['spec']);
  const versions = asRecord(spec['versions']);
  const schemas = asRecord(spec['schemas']);
  const field = (value: unknown, name: string): string | undefined => {
    const text = asString(value);
    if (text === undefined) {
      errors.push({ code: 'toolchain_invalid', message: `toolchain ${name} must be a string`, path: `spec.${name}` });
    }
    return text;
  };

  const toolchain: Toolchain = {
    file: path,
    generator: field(spec['generator'], 'generator') ?? '',
    image: field(spec['image'], 'image') ?? '',
    dockerfile: field(spec['dockerfile'], 'dockerfile') ?? '',
    versions: {
      node: field(versions['node'], 'versions.node') ?? '',
      python: field(versions['python'], 'versions.python') ?? '',
      semantica: field(versions['semantica'], 'versions.semantica') ?? '',
      contextService: field(versions['contextService'], 'versions.contextService') ?? '',
    },
    schemas: {
      graph: (schemas['graph'] as number | string | undefined) ?? '',
      audit: (schemas['audit'] as number | string | undefined) ?? '',
    },
  };

  if (errors.length > 0) return { errors };
  return { toolchain, errors };
}

interface SpecFileCollection {
  specFiles: Record<string, string>;
  fileSet?: FileSetDigest;
  errors: Diagnostic[];
}

/**
 * `spec.digest` covers `solution.yaml`, every file the Spec references and every
 * file under `files/` — a prompt outside the digest is outside the build.
 */
export function collectSpecFiles(specDir: string, raw: Record<string, unknown>): SpecFileCollection {
  const errors: Diagnostic[] = [];
  const spec = asRecord(raw['spec']);
  const referenced = new Set<string>(['solution.yaml']);

  const addPath = (value: unknown): void => {
    const path = asString(value);
    if (path !== undefined) referenced.add(path);
  };

  for (const agent of Object.values(asRecord(spec['agents']))) addPath(asRecord(agent)['instructions']);
  for (const workflow of Object.values(asRecord(spec['workflows']))) {
    for (const step of asArray(asRecord(workflow)['steps'])) addPath(asRecord(step)['outputSchema']);
  }
  for (const tool of Object.values(asRecord(spec['tools']))) {
    addPath(asRecord(tool)['inputSchema']);
    addPath(asRecord(tool)['outputSchema']);
  }
  for (const relative of walkFiles(join(specDir, 'files'))) referenced.add(`files/${relative}`);

  const specFiles: Record<string, string> = {};
  for (const relative of [...referenced].sort()) {
    const full = resolve(specDir, relative);
    if (full !== resolve(specDir) && !full.startsWith(resolve(specDir) + sep)) {
      errors.push({
        code: 'spec_file_invalid',
        message: `Spec file ${relative} escapes the Solution directory`,
        path: relative,
        remediation: 'Spec files are relative paths inside the Solution directory',
      });
      continue;
    }
    if (!isFile(full)) {
      if (relative !== 'solution.yaml') {
        errors.push({
          code: 'spec_file_missing',
          message: `Spec references ${relative}, which does not exist`,
          path: relative,
          remediation: `create ${relative} or fix the reference`,
        });
      }
      continue;
    }
    specFiles[relative] = readText(full);
  }

  if (errors.length > 0) return { specFiles, errors };
  const fileSet = digestFiles(Object.entries(specFiles).map(([path, content]) => ({ path, content })));
  return { specFiles, fileSet, errors };
}
