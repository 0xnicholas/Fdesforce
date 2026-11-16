import { dirname, join } from 'node:path';

import { normalizeText, parseSolutionLock, sha256, type Digest, type SolutionLock } from '@fde/spec';
import { stringify } from 'yaml';

import { isFile, readText } from './fsutil.js';
import type { Project } from './project.js';
import type { Diagnostic } from './types.js';

export interface BuildLockOptions {
  /** `name@version` materialized by `fde spec init`; recorded as provenance. */
  solutionTemplate?: { name: string; version: string };
}

export interface BuildLockResult {
  lock?: SolutionLock;
  errors: Diagnostic[];
}

/** Build the complete, purely generated lock from the resolved inputs. */
export function buildLock(project: Project, options: BuildLockOptions = {}): BuildLockResult {
  const errors: Diagnostic[] = [
    ...project.errors,
    ...project.specErrors,
    ...project.fileErrors,
    ...project.artifacts.errors,
    ...project.toolchainErrors,
  ];

  if (project.spec === undefined || project.fileSet === undefined) {
    return { errors };
  }

  const runtime = project.artifacts.runtimeProfile;
  if (runtime === undefined) {
    errors.push({
      code: 'runtime_profile_missing',
      message: 'no Runtime Profile could be resolved from spec.build.runtimeProfile',
      path: 'spec.build.runtimeProfile',
      remediation: 'vendor the profile under platform/runtime-profiles or fix the reference',
    });
  }
  const toolchain = project.toolchain;
  if (toolchain === undefined) return { errors };

  const profilePackages = runtime?.document.spec.packages ?? {};
  const mastra = profilePackages['@mastra/core'];
  const node = profilePackages['node'];
  if (runtime !== undefined && (mastra === undefined || node === undefined)) {
    errors.push({
      code: 'runtime_profile_incomplete',
      message: `Runtime Profile ${runtime.document.metadata.name} must pin @mastra/core and node in spec.packages`,
      path: 'runtime.packages',
    });
  }
  if (node !== undefined && node !== toolchain.versions.node) {
    errors.push({
      code: 'toolchain_mismatch',
      message: `Runtime Profile pins node ${node}, toolchain pins ${toolchain.versions.node}`,
      path: 'toolchain.versions.node',
      remediation: 'align the Runtime Profile and the toolchain before locking',
    });
  }

  const image = toolchain.image;
  if (image.includes('@')) {
    errors.push({
      code: 'toolchain_invalid',
      message: `toolchain image ${image} already carries a digest; declare the repository only`,
      path: 'spec.image',
      remediation: 'write `spec.image: ghcr.io/<org>/toolchain`; the lock folds in the Dockerfile digest',
    });
  }
  const dockerfile = join(dirname(toolchain.file), toolchain.dockerfile);
  if (!isFile(dockerfile)) {
    errors.push({
      code: 'toolchain_missing',
      message: `toolchain Dockerfile ${dockerfile} does not exist`,
      path: toolchain.dockerfile,
      remediation: 'vendor the toolchain Dockerfile with the toolchain manifest',
    });
  }

  const solutionTemplates = solutionTemplatePins(project, options, errors);

  if (errors.length > 0 || runtime === undefined || mastra === undefined || node === undefined) {
    return { errors };
  }

  const templates: NonNullable<SolutionLock['templates']> = {
    ...(Object.keys(solutionTemplates).length === 0 ? {} : { solution: solutionTemplates }),
    ...(Object.keys(project.artifacts.templates.capability).length === 0
      ? {}
      : { capability: templatePins(project.artifacts.templates.capability) }),
    ...(Object.keys(project.artifacts.templates.policy).length === 0
      ? {}
      : { policy: templatePins(project.artifacts.templates.policy) }),
    ...(Object.keys(project.artifacts.evalTemplates).length === 0
      ? {}
      : { eval: templatePins(project.artifacts.evalTemplates) }),
    ...(Object.keys(project.artifacts.templates.ontology).length === 0
      ? {}
      : { ontology: templatePins(project.artifacts.templates.ontology) }),
    ...(Object.keys(project.artifacts.templates['deployment-profile']).length === 0
      ? {}
      : { deploymentProfile: templatePins(project.artifacts.templates['deployment-profile']) }),
  };

  const assets: NonNullable<SolutionLock['assets']> = {
    ...(Object.keys(project.artifacts.policyAssets).length === 0
      ? {}
      : {
          policies: sorted(
            Object.fromEntries(
              Object.entries(project.artifacts.policyAssets).map(([name, asset]) => [
                name,
                { version: asset.version, digest: asset.digest, files: sorted(asset.files) },
              ]),
            ),
          ),
        }),
    ...(Object.keys(project.artifacts.evalSuites).length === 0
      ? {}
      : {
          evalSuites: sorted(
            Object.fromEntries(
              Object.entries(project.artifacts.evalSuites).map(([name, asset]) => [
                name,
                { version: asset.version, digest: asset.digest, files: sorted(asset.files) },
              ]),
            ),
          ),
        }),
    ...(Object.keys(project.artifacts.connectors).length === 0
      ? {}
      : {
          connectors: sorted(
            Object.fromEntries(
              Object.entries(project.artifacts.connectors).map(([name, asset]) => [
                name,
                { digest: asset.digest, files: sorted(asset.files) },
              ]),
            ),
          ),
        }),
    ...(project.artifacts.contextPackage === undefined
      ? {}
      : {
          customerContextPackage: {
            [project.artifacts.contextPackage.name]: `${project.artifacts.contextPackage.version}@${project.artifacts.contextPackage.digest}`,
          },
        }),
  };

  const lock: SolutionLock = {
    lockVersion: 1,
    spec: { digest: project.fileSet.digest, files: sorted(project.fileSet.files) },
    templates,
    ...(Object.keys(assets).length === 0 ? {} : { assets }),
    ...(Object.keys(project.artifacts.overlays).length === 0
      ? {}
      : { overlays: templatePins(project.artifacts.overlays) }),
    ...(Object.keys(project.artifacts.extensions).length === 0
      ? {}
      : { extensions: templatePins(project.artifacts.extensions) }),
    ...(Object.keys(project.artifacts.models).length === 0
      ? {}
      : {
          modelProfiles: sorted(
            Object.fromEntries(
              Object.entries(project.artifacts.models).map(([name, model]) => [name, model.pin]),
            ),
          ),
        }),
    ...(Object.keys(project.artifacts.evalDatasets).length === 0
      ? {}
      : { evalDatasets: sorted(project.artifacts.evalDatasets) }),
    runtime: {
      profile: runtime.pin,
      contractVersion: runtime.document.spec.contractVersion,
      graphSchema: toolchain.schemas.graph,
      auditSchema: toolchain.schemas.audit,
      mastra,
      node,
      python: toolchain.versions.python,
      semantica: toolchain.versions.semantica,
      contextService: toolchain.versions.contextService,
    },
    toolchain: {
      generator: toolchain.generator,
      image: `${image}@${sha256(normalizeText(readText(dockerfile)))}`,
    },
  };

  // Never write a lock the schema does not accept: a bad pin would otherwise
  // surface only as an obscure failure inside `fde build`.
  const validated = parseSolutionLock(lock);
  if (!validated.ok) {
    return {
      errors: validated.errors.map((error) => ({ ...error, code: 'generated_lock_invalid' })),
    };
  }

  return { lock: validated.value, errors };
}

function solutionTemplatePins(
  project: Project,
  options: BuildLockOptions,
  errors: Diagnostic[],
): Record<string, string> {
  const pins: Record<string, string> = {};

  if (options.solutionTemplate !== undefined) {
    const { name, version } = options.solutionTemplate;
    const result = project.catalogues.templates.solution.exact(name, version, 'templates.solution');
    if (!result.ok) errors.push(result.error);
    else pins[name] = `${version}@${result.value.digest}`;
    return pins;
  }

  // Provenance is recorded at materialization time; re-derive its digest so a
  // vendored template change is visible in `lock --check`.
  for (const [name, pin] of Object.entries(project.lock?.templates.solution ?? {})) {
    const version = pin.split('@')[0] ?? '';
    const result = project.catalogues.templates.solution.exact(name, version, `templates.solution.${name}`);
    if (!result.ok) errors.push(result.error);
    else pins[name] = `${version}@${result.value.digest}`;
  }
  return pins;
}

interface PinSource {
  name: string;
  version: string;
  digest: Digest;
}

function templatePins(artifacts: Record<string, PinSource>): Record<string, string> {
  return sorted(
    Object.fromEntries(
      Object.entries(artifacts).map(([name, artifact]) => [name, `${artifact.version}@${artifact.digest}`]),
    ),
  );
}

function sorted<T>(value: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

const LOCK_HEADER = [
  '# Generated by `fde spec lock` — do not hand-edit.',
  '# Every pin is an exact version plus a content digest; `fde spec lock --check` fails on drift.',
  '',
].join('\n');

export function renderLock(lock: SolutionLock): string {
  return LOCK_HEADER + stringify(lock, { lineWidth: 0, aliasDuplicateObjects: false });
}

export interface LockDiff {
  path: string;
  expected?: string;
  actual?: string;
}

/** Leaf-by-leaf comparison: every pin and every digest is named individually. */
export function diffLock(expected: unknown, actual: unknown, path = ''): LockDiff[] {
  if (isPlainObject(expected) || isPlainObject(actual)) {
    const expectedRecord = isPlainObject(expected) ? expected : {};
    const actualRecord = isPlainObject(actual) ? actual : {};
    const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
    return keys.flatMap((key) => {
      const child = path === '' ? key : `${path}.${key}`;
      if (!(key in actualRecord)) return [{ path: child, expected: display(expectedRecord[key]) }];
      if (!(key in expectedRecord)) return [{ path: child, actual: display(actualRecord[key]) }];
      return diffLock(expectedRecord[key], actualRecord[key], child);
    });
  }

  if (display(expected) === display(actual)) return [];
  const diff: LockDiff = { path };
  if (expected !== undefined) diff.expected = display(expected);
  if (actual !== undefined) diff.actual = display(actual);
  return [diff];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  const rendered = JSON.stringify(value);
  return rendered === undefined ? String(value) : rendered;
}

/** `lock --check` diagnostics: one per drifted item, all actionable. */
export function driftDiagnostics(diff: ReadonlyArray<LockDiff>): Diagnostic[] {
  return diff.map((item) => {
    if (item.actual === undefined) {
      return {
        code: 'lock_stale',
        path: item.path,
        message: `solution.lock has no entry; the inputs pin ${String(item.expected)}`,
        remediation: 'run `fde spec lock` to regenerate the lock',
      };
    }
    if (item.expected === undefined) {
      return {
        code: 'lock_stale',
        path: item.path,
        message: `solution.lock pins ${item.actual}, which no build input produces`,
        remediation: 'run `fde spec lock` to regenerate the lock',
      };
    }
    return {
      code: 'lock_stale',
      path: item.path,
      message: `solution.lock pins ${item.actual}; the inputs digest to ${item.expected}`,
      remediation: 'run `fde spec lock` to regenerate the lock',
    };
  });
}
