import { lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  contextPackageFiles,
  digestFiles,
  digestOf,
  normalizeText,
  parseModelProfile,
  parseRuntimeProfile,
  parseSolutionLock,
  parseSolutionSpec,
  sha256,
  type Digest,
  type ModelProfile,
  type RuntimeProfile,
  type SolutionLock,
  type ContextServiceTopology,
  type SolutionSpec,
} from '@fde/spec';
import {
  pinnedProfileDigest,
  pinnedProfileRef,
  profileDigest,
  profileRef,
  type RuntimeConnectorOperationView,
  type RuntimeConnectorView,
  type RuntimeEnvironmentView,
  type RuntimeExtensionView,
  type RuntimeLanguage,
} from '@fde/runtime-generator';

import { loadContextServiceTopology } from '@fde/bundle';

import { buildCatalogues, type Catalogues, type ContextPackageArtifact, type DocArtifact } from './artifacts.js';
import { asArray, asRecord, asString, isFile, readDocument, readText, walkTree } from './fsutil.js';
import { loadLicenseCatalog, type LicenseCatalog } from './license.js';
import { loadToolchain, type Toolchain } from './project.js';
import { diagnostic, type Diagnostic } from './types.js';
import type { Workspace } from './workspace.js';

/**
 * The build's inputs, resolved from the lock — never from the Spec's ranges.
 *
 * `fde build` is the one command that may not re-resolve anything
 * (`docs/domain-model.md` §7, `docs/runtime-adapter.md` §4.4 step 1): a range
 * that picked a newer vendored Template after the lock was written would make
 * the bundle a different artifact than the one that was reviewed. So every
 * reference here is an exact `name@version` read out of `solution.lock`, and its
 * digest is verified against the bytes on disk. A missing or moved input is a
 * build failure, not a quiet re-resolution.
 *
 * The loader is deliberately separate from `Project`: `Project` resolves the
 * Spec's ranges for `validate`/`lock`, while a build must not look at them at all.
 */

export interface LockedBuildInput {
  specDir: string;
  platformRoot: string;
  spec: SolutionSpec;
  lock: SolutionLock;
  /** Canonical digest of the parsed lock document, for provenance. */
  lockDigest: Digest;
  /** Exactly the files `solution.lock.spec.files` pins, path → content. */
  specFiles: Record<string, string>;
  toolchain: Toolchain;
  profile: RuntimeProfile;
  profileRef: string;
  profileDigest: Digest;
  environment: RuntimeEnvironmentView;
  extensions: RuntimeExtensionView[];
  connectors: Record<string, RuntimeConnectorView>;
  modelProfiles: Record<string, ModelProfile>;
  contextPackage?: ContextPackageArtifact;
  /** Every file of the frozen package, package-relative, for the bundle. */
  contextPackageFiles: Record<string, string>;
  licenseCatalog: LicenseCatalog;
  /**
   * The catalog is readable but no longer the bytes the lock pinned. The build
   * runs the license gate first, so a GPL edit reports `license_blocked`; a
   * benign edit still fails before a bundle is written.
   */
  licenseCatalogMismatch?: { expected: Digest; actual: Digest };
  /** The platform fragment the composition uses, verified against its lock pin. */
  contextServiceTopology: { topology: ContextServiceTopology; version: string; digest: Digest };
  warnings: Diagnostic[];
}

export type LoadBuildInputResult =
  | { ok: true; value: LockedBuildInput }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

export interface LoadBuildInputOptions {
  specDir: string;
  workspace: Workspace;
  /** Which `spec.environments` entry this bundle is built for. */
  environment?: string;
}

const splitPin = (pin: string): { version: string; digest: Digest } => {
  const at = pin.lastIndexOf('@');
  return { version: pin.slice(0, at), digest: pin.slice(at + 1) as Digest };
};

const digestMismatch = (path: string, expected: string, actual: string, label: string): Diagnostic =>
  diagnostic('artifact_digest_mismatch', `${label} digests to ${actual}, but solution.lock pins ${expected}`, {
    path,
    remediation: 'the artifact changed after the lock was written; run `fde spec lock` and review the diff',
  });

export function loadLockedBuildInput(options: LoadBuildInputOptions): LoadBuildInputResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const specDir = resolve(options.specDir);

  const specDocument = readDocument(join(specDir, 'solution.yaml'), 'solution.yaml');
  if (!specDocument.ok) {
    return { ok: false, errors: [{ ...specDocument.error, code: 'spec_missing' }], warnings };
  }
  const specParsed = parseSolutionSpec(specDocument.value);
  if (!specParsed.ok) return { ok: false, errors: specParsed.errors, warnings };
  const spec = specParsed.value;

  const lockDocument = readDocument(join(specDir, 'solution.lock'), 'solution.lock');
  if (!lockDocument.ok) {
    return {
      ok: false,
      errors: [
        diagnostic('solution_lock_missing', 'the Solution has no solution.lock; a build may only read pinned inputs', {
          path: join(specDir, 'solution.lock'),
          remediation: 'run `fde spec lock`, review the diff, then build',
        }),
      ],
      warnings,
    };
  }
  const lockParsed = parseSolutionLock(lockDocument.value);
  if (!lockParsed.ok) {
    return { ok: false, errors: lockParsed.errors.map((error) => ({ ...error, code: 'solution_lock_invalid' })), warnings };
  }
  const lock = lockParsed.value;

  // 1. The Spec's file set is the lock's file set. Files outside the lock are
  //    outside the build, even when they exist on disk.
  const specFiles: Record<string, string> = {};
  for (const path of Object.keys(lock.spec.files).sort()) {
    const full = join(specDir, path);
    if (!isFile(full)) {
      errors.push(
        diagnostic('spec_file_missing', `solution.lock pins ${path}, which does not exist in the Solution`, {
          path,
          remediation: 'restore the file, or regenerate the lock from the files that exist',
        }),
      );
      continue;
    }
    if (lstatSync(full).isSymbolicLink()) {
      errors.push(
        diagnostic('spec_file_invalid', `${path} is a symlink; a build may not read outside the locked file set`, {
          path,
          remediation: 'copy the file into the Solution directory; `fde spec lock` rejects links for the same reason',
        }),
      );
      continue;
    }
    specFiles[path] = readText(full);
  }
  if (errors.length === 0) {
    const fileSet = digestFiles(Object.entries(specFiles).map(([path, content]) => ({ path, content })));
    if (fileSet.digest !== lock.spec.digest) {
      errors.push(
        diagnostic('spec_digest_mismatch', `the Spec file set digests to ${fileSet.digest}, but solution.lock pins ${lock.spec.digest}`, {
          path: 'spec.digest',
          remediation: 'run `fde spec lock` and review the diff; a build never re-reads a moved Spec file',
        }),
      );
    }
    for (const [path, pinned] of Object.entries(lock.spec.files)) {
      const actual = fileSet.files[path];
      if (actual !== undefined && actual !== pinned) {
        errors.push(digestMismatch(path, pinned, actual, path));
      }
    }
  }

  // 2. The toolchain, and the cross-runtime schema versions it owns.
  const toolchain = loadToolchain(options.workspace.platformRoot);
  if (toolchain.toolchain === undefined) {
    return { ok: false, errors: toolchain.errors, warnings };
  }
  const tool = toolchain.toolchain;
  const dockerfilePath = join(dirname(tool.file), tool.dockerfile);
  const computedImage = isFile(dockerfilePath)
    ? `${tool.image}@${sha256(normalizeText(readText(dockerfilePath)))}`
    : undefined;
  if (computedImage === undefined) {
    errors.push(
      diagnostic('toolchain_missing', `the toolchain Dockerfile ${tool.dockerfile} does not exist`, {
        path: tool.dockerfile,
        remediation: 'vendor the toolchain Dockerfile with the toolchain manifest',
      }),
    );
  } else if (computedImage !== lock.toolchain.image) {
    errors.push(
      diagnostic('toolchain_mismatch', `solution.lock pins ${lock.toolchain.image}, but the vendored toolchain digests to ${computedImage}`, {
        path: 'toolchain.image',
        remediation: 're-lock against the vendored toolchain, or restore the toolchain the lock pins',
      }),
    );
  }
  if (lock.toolchain.generator !== tool.generator) {
    errors.push(
      diagnostic('toolchain_mismatch', `solution.lock pins generator ${lock.toolchain.generator}, but the toolchain declares ${tool.generator}`, {
        path: 'toolchain.generator',
        remediation: 're-lock against the vendored toolchain',
      }),
    );
  }
  if (String(lock.runtime.graphSchema) !== String(tool.schemas.graph) || String(lock.runtime.auditSchema) !== String(tool.schemas.audit)) {
    errors.push(
      diagnostic(
        'runtime_schema_mismatch',
        `solution.lock pins graph/audit schema ${String(lock.runtime.graphSchema)}/${String(lock.runtime.auditSchema)}, but the toolchain compiles ${String(tool.schemas.graph)}/${String(tool.schemas.audit)}`,
        {
          path: 'runtime.graphSchema',
          remediation: 're-lock against the toolchain the deployment compiles, or fix the toolchain pin',
        },
      ),
    );
  }

  // 3. Every artifact the lock pins, including the ones this build does not
  //    consume: a bundle whose reviewed input moved is not the reviewed bundle.
  const catalogues = buildCatalogues({
    platformRoot: options.workspace.platformRoot,
    assets: options.workspace.assets,
  });
  warnings.push(...catalogues.problems);

  const profile = resolveRuntimeProfilePin(lock, catalogues, errors);
  if (profile === undefined) return { ok: false, errors, warnings };

  verifyTemplatePins(lock, catalogues, errors);
  verifyAssetPins(lock, catalogues, errors);

  // 4. The artifacts the generator consumes, resolved by exact pin.
  const extensions = resolveExtensions(lock, catalogues.extensions, errors);
  const modelProfiles = resolveModelProfiles(lock, catalogues.modelProfiles, errors);
  const connectors = resolveConnectors(lock, catalogues.connectors, errors);
  const contextPackage = resolveContextPackage(lock, catalogues.contextPackages, errors);

  const licenseCatalog = loadLicenseCatalog(options.workspace.platformRoot);
  errors.push(...licenseCatalog.errors);

  const fragmentPin = lock.toolchain.contextServiceTopology;
  const licensePin = lock.toolchain.licenseCatalog;
  let contextServiceTopology: LockedBuildInput['contextServiceTopology'] | undefined;
  if (fragmentPin === undefined) {
    errors.push(
      diagnostic('lock_incomplete', 'solution.lock pins no context-service topology fragment', {
        path: 'toolchain.contextServiceTopology',
        remediation: 'run `fde spec lock`; the composed payload is not addressable without its platform half',
      }),
    );
  } else {
    const fragment = loadContextServiceTopology({
      platformRoot: options.workspace.platformRoot,
      version: fragmentPin.version,
    });
    if (!fragment.ok) {
      errors.push(...fragment.errors);
    } else {
      const digest = digestOf(fragment.topology);
      if (digest !== fragmentPin.digest) {
        errors.push(
          diagnostic(
            'platform_fragment_mismatch',
            `the context-service fragment ${fragmentPin.version} digests to ${digest}, but solution.lock pins ${fragmentPin.digest}`,
            {
              path: 'toolchain.contextServiceTopology',
              remediation: 'the fragment changed after the lock was written; re-lock and review the diff',
            },
          ),
        );
      } else {
        contextServiceTopology = { topology: fragment.topology, version: fragmentPin.version, digest };
      }
    }
  }

  if (licensePin === undefined) {
    errors.push(
      diagnostic('lock_incomplete', 'solution.lock pins no license catalog', {
        path: 'toolchain.licenseCatalog',
        remediation: 'run `fde spec lock`; the license gate needs a pinned catalog',
      }),
    );
  }

  const environment = resolveEnvironment(spec, lock, options.environment, errors);

  if (
    errors.length > 0 ||
    profile === undefined ||
    licenseCatalog.catalog === undefined ||
    environment === undefined ||
    contextServiceTopology === undefined
  ) {
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    value: {
      specDir,
      platformRoot: options.workspace.platformRoot,
      spec,
      lock,
      lockDigest: digestOf(lock),
      specFiles,
      toolchain: tool,
      profile,
      profileRef: profileRef(profile),
      profileDigest: profileDigest(profile),
      environment,
      extensions,
      connectors,
      modelProfiles,
      ...(contextPackage === undefined ? {} : { contextPackage }),
      contextPackageFiles:
        contextPackage === undefined ? {} : readContextPackage(contextPackage.dir, contextPackage.version),
      licenseCatalog: licenseCatalog.catalog,
      ...(licensePin === undefined || licenseCatalog.catalog.digest === licensePin.digest
        ? {}
        : { licenseCatalogMismatch: { expected: licensePin.digest as Digest, actual: licenseCatalog.catalog.digest } }),
      contextServiceTopology,
      warnings,
    },
  };
}

/**
 * Every Template pin is verified, not only the ones this generator reads.
 *
 * A build that silently ignored a moved capability Template would ship a bundle
 * whose review covered different inputs. Templates are platform assets with exact
 * version directories, so verification is `exact(name, version).digest === pin`.
 */
function verifyTemplatePins(lock: SolutionLock, catalogues: Catalogues, errors: Diagnostic[]): void {
  const groups: Array<{
    pins: Record<string, string> | undefined;
    path: string;
    catalogue: ReturnType<typeof buildCatalogues>['templates']['solution'];
    label: string;
  }> = [
    { pins: lock.templates.solution, path: 'templates.solution', catalogue: catalogues.templates.solution, label: 'Solution Template' },
    { pins: lock.templates.capability, path: 'templates.capability', catalogue: catalogues.templates.capability, label: 'Capability Template' },
    { pins: lock.templates.policy, path: 'templates.policy', catalogue: catalogues.templates.policy, label: 'Policy Template' },
    { pins: lock.templates.eval, path: 'templates.eval', catalogue: catalogues.templates.eval, label: 'Eval Template' },
    { pins: lock.templates.ontology, path: 'templates.ontology', catalogue: catalogues.templates.ontology, label: 'Ontology Template' },
    {
      pins: lock.templates.deploymentProfile,
      path: 'templates.deploymentProfile',
      catalogue: catalogues.templates['deployment-profile'],
      label: 'Deployment Profile Template',
    },
    { pins: lock.overlays, path: 'overlays', catalogue: catalogues.overlays, label: 'Overlay' },
  ];

  for (const group of groups) {
    for (const [name, pin] of Object.entries(group.pins ?? {})) {
      const { version, digest } = splitPin(pin);
      const path = `${group.path}.${name}`;
      const resolved = group.catalogue.exact(name, version, path);
      if (!resolved.ok) {
        errors.push(resolved.error);
        continue;
      }
      if (resolved.value.digest !== digest) {
        errors.push(digestMismatch(path, digest, resolved.value.digest, `${group.label} ${name}@${version}`));
      }
    }
  }

  // The legacy `templates.modelProfile` namespace names the same documents as the
  // typed `modelProfiles` block, which `resolveModelProfiles` verifies.
  for (const [name, pin] of Object.entries(lock.templates.modelProfile ?? {})) {
    const { version, digest } = splitPin(pin);
    const resolved = catalogues.modelProfiles.resolve(`${name}@${version}`, `templates.modelProfile.${name}`);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (resolved.value.digest !== digest) {
      errors.push(digestMismatch(`templates.modelProfile.${name}`, digest, resolved.value.digest, `Model Profile ${name}@${version}`));
    }
  }
}

/** Concrete Customer assets: the document digest is the pin; the file manifest rides with it. */
function verifyAssetPins(lock: SolutionLock, catalogues: Catalogues, errors: Diagnostic[]): void {
  for (const [name, asset] of Object.entries(lock.assets?.policies ?? {})) {
    const resolved = catalogues.policyAssets.resolve(`${name}@${asset.version}`, `assets.policies.${name}`);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (resolved.value.digest !== asset.digest) {
      errors.push(digestMismatch(`assets.policies.${name}`, asset.digest, resolved.value.digest, `Policy asset ${name}@${asset.version}`));
    }
  }

  for (const [name, asset] of Object.entries(lock.assets?.evalSuites ?? {})) {
    const resolved = catalogues.evalSuites.resolve(`${name}@${asset.version}`, `assets.evalSuites.${name}`);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (resolved.value.digest !== asset.digest) {
      errors.push(digestMismatch(`assets.evalSuites.${name}`, asset.digest, resolved.value.digest, `Eval Suite ${name}@${asset.version}`));
    }
  }
}

function resolveRuntimeProfilePin(
  lock: SolutionLock,
  catalogues: Catalogues,
  errors: Diagnostic[],
): RuntimeProfile | undefined {
  const pinnedDigest = pinnedProfileDigest(lock.runtime);
  const pinnedRef = pinnedProfileRef(lock.runtime);
  if (pinnedDigest === undefined) {
    errors.push(
      diagnostic('runtime_profile_missing', 'solution.lock pins the Runtime Profile without a digest', {
        path: 'runtime.profile',
        remediation: 'regenerate the lock so the profile is content-addressed',
      }),
    );
    return undefined;
  }

  const resolved = catalogues.runtimeProfiles.resolve(`${pinnedRef.name}@${pinnedRef.version}`, 'runtime.profile');
  if (!resolved.ok) {
    errors.push({
      ...resolved.error,
      code: 'runtime_profile_missing',
      remediation: 'vendor the profile version solution.lock pins, or re-lock against a vendored profile',
    });
    return undefined;
  }

  const parsed = parseRuntimeProfile(resolved.value.document);
  if (!parsed.ok) return pushProfileErrors(parsed.errors, errors);

  const actual = profileDigest(parsed.value);
  if (actual !== pinnedDigest) {
    errors.push(
      diagnostic('runtime_profile_missing', `the vendored Runtime Profile digests to ${actual}, but solution.lock pins ${pinnedDigest}`, {
        path: 'runtime.profile',
        remediation: 'the profile changed without a lock refresh; a build only trusts the locked bytes',
      }),
    );
    return undefined;
  }
  return parsed.value;
}

function pushProfileErrors(profileErrors: ReadonlyArray<Diagnostic>, errors: Diagnostic[]): undefined {
  errors.push(...profileErrors.map((error) => ({ ...error, code: 'runtime_profile_missing' })));
  return undefined;
}

function resolveExtensions(
  lock: SolutionLock,
  catalogue: ReturnType<typeof buildCatalogues>['extensions'],
  errors: Diagnostic[],
): RuntimeExtensionView[] {
  const views: RuntimeExtensionView[] = [];
  for (const [name, pin] of Object.entries(lock.extensions ?? {})) {
    const { version, digest } = splitPin(pin);
    const resolved = catalogue.exact(name, version, `extensions.${name}`);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (resolved.value.digest !== digest) {
      errors.push(digestMismatch(`extensions.${name}`, digest, resolved.value.digest, `Extension ${name}@${version}`));
      continue;
    }
    const spec = asRecord(resolved.value.document['spec']);
    const interfaceKind = asString(spec['interface']);
    const artifactKind = asString(spec['artifactKind']);
    if (!isExtensionInterface(interfaceKind)) {
      errors.push(
        diagnostic('runtime_extension_unsupported', `Extension ${name}@${version} declares interface ${String(interfaceKind)}`, {
          path: `extensions.${name}.interface`,
          remediation: 'declare tool | connector | recipe | scorer in extension.yaml',
        }),
      );
      continue;
    }
    if (!isExtensionArtifactKind(artifactKind)) {
      errors.push(
        diagnostic('runtime_extension_unsupported', `Extension ${name}@${version} declares artifactKind ${String(artifactKind)}`, {
          path: `extensions.${name}.artifactKind`,
          remediation: 'declare ts-package | python-wheel | http in extension.yaml',
        }),
      );
      continue;
    }
    const compatibility = asArray(spec['runtimeCompatibility']).flatMap((entry) => {
      const family = asString(asRecord(entry)['family']);
      const language = asString(asRecord(entry)['language']);
      if (family === undefined || (language !== 'typescript' && language !== 'python')) return [];
      return [{ family, language: language as RuntimeLanguage }];
    });
    views.push({
      name,
      version,
      interface: interfaceKind,
      artifactKind,
      ...(compatibility.length === 0 ? {} : { runtimeCompatibility: compatibility }),
    });
  }
  return views;
}

function isExtensionInterface(value: string | undefined): value is RuntimeExtensionView['interface'] {
  return value === 'tool' || value === 'connector' || value === 'recipe' || value === 'scorer';
}

function isExtensionArtifactKind(value: string | undefined): value is RuntimeExtensionView['artifactKind'] {
  return value === 'ts-package' || value === 'python-wheel' || value === 'http';
}

function resolveModelProfiles(
  lock: SolutionLock,
  catalogue: ReturnType<typeof buildCatalogues>['modelProfiles'],
  errors: Diagnostic[],
): Record<string, ModelProfile> {
  const profiles: Record<string, ModelProfile> = {};
  for (const [name, pin] of Object.entries(lock.modelProfiles ?? {})) {
    const { version, digest } = splitPin(pin);
    const resolved = catalogue.resolve(`${name}@${version}`, `modelProfiles.${name}`);
    if (!resolved.ok) {
      errors.push(resolved.error);
      continue;
    }
    if (resolved.value.digest !== digest) {
      errors.push(digestMismatch(`modelProfiles.${name}`, digest, resolved.value.digest, `Model Profile ${name}@${version}`));
      continue;
    }
    const parsed = parseModelProfile(resolved.value.document);
    if (!parsed.ok) {
      errors.push(...parsed.errors);
      continue;
    }
    profiles[name] = parsed.value;
  }
  return profiles;
}

function connectorDigest(asset: DocArtifact): Digest {
  const dir = dirname(asset.path);
  const file = basename(asset.path);
  const files = [file];
  const contract = asString(asRecord(asset.document['spec'])['dataContract']);
  if (contract !== undefined) files.push(contract);
  return digestFiles(files.map((path) => ({ path, content: readText(join(dir, path)) }))).digest;
}

function resolveConnectors(
  lock: SolutionLock,
  catalogue: ReturnType<typeof buildCatalogues>['connectors'],
  errors: Diagnostic[],
): Record<string, RuntimeConnectorView> {
  const connectors: Record<string, RuntimeConnectorView> = {};
  for (const [name, asset] of Object.entries(lock.assets?.connectors ?? {})) {
    const resolved = catalogue.get(name);
    if (resolved === undefined) {
      errors.push(
        diagnostic('artifact_missing', `solution.lock pins connector ${name}, which is not in the workspace`, {
          path: `assets.connectors.${name}`,
          remediation: 'vendor the connector under the workspace asset root',
        }),
      );
      continue;
    }
    const actual = connectorDigest(resolved);
    if (actual !== asset.digest) {
      errors.push(digestMismatch(`assets.connectors.${name}`, asset.digest, actual, `Connector ${name}`));
      continue;
    }
    const operations: Record<string, RuntimeConnectorOperationView> = {};
    for (const operation of asArray(asRecord(resolved.document['spec'])['allowedOperations'])) {
      const nameOfOperation = asString(operation);
      if (nameOfOperation !== undefined) operations[nameOfOperation] = {};
    }
    connectors[name] = { name, operations };
  }
  return connectors;
}

function resolveContextPackage(
  lock: SolutionLock,
  catalogue: ReturnType<typeof buildCatalogues>['contextPackages'],
  errors: Diagnostic[],
): ContextPackageArtifact | undefined {
  const pins = Object.entries(lock.assets?.customerContextPackage ?? {});
  if (pins.length === 0) return undefined;
  if (pins.length > 1) {
    errors.push(
      diagnostic('context_package_invalid', 'solution.lock pins more than one Customer Context Package', {
        path: 'assets.customerContextPackage',
        remediation: 'a Solution consumes exactly one Context Package',
      }),
    );
    return undefined;
  }

  const [name, pin] = pins[0] as [string, string];
  const { version, digest } = splitPin(pin);
  const resolved = catalogue.resolve(`${name}@${version}`, `assets.customerContextPackage.${name}`);
  if (!resolved.ok) {
    errors.push(resolved.error);
    return undefined;
  }
  if (resolved.value.digest !== digest) {
    errors.push(digestMismatch(`assets.customerContextPackage.${name}`, digest, resolved.value.digest, `Context Package ${name}@${version}`));
    return undefined;
  }

  const manifest = asRecord(resolved.value.manifest);
  const status = asString(asRecord(manifest['metadata'])['status']);
  if (status !== 'frozen') {
    errors.push(
      diagnostic('context_package_not_frozen', `${name}@${version} is ${status ?? 'not marked frozen'}; a bundle only contains frozen semantics`, {
        path: `assets.customerContextPackage.${name}`,
        remediation: 'run `fde context freeze` and re-lock',
      }),
    );
    return undefined;
  }
  const revisionDigest = asString(asRecord(asRecord(resolved.value.revision)['spec'])['digest']);
  if (resolved.value.revision === undefined || revisionDigest !== digest) {
    errors.push(
      diagnostic('context_package_modified', `${name}@${version} has no frozen revision matching ${digest}`, {
        path: `assets.customerContextPackage.${name}`,
        remediation: 'the package moved after it was frozen; freeze a new version and re-lock',
      }),
    );
    return undefined;
  }
  return resolved.value;
}

function readContextPackage(dir: string, version: string): Record<string, string> {
  const tree = walkTree(dir);
  // The content set, exactly as `fde context freeze` addressed it, plus the
  // revision record that names the address. Hidden debris stays out of both.
  const files = contextPackageFiles(tree.files);
  const revision = tree.files.find((path) => path === `revisions/${version}.yaml`);
  if (revision !== undefined) files.push(revision);
  const contents: Record<string, string> = {};
  for (const path of files.sort()) contents[path] = readText(join(dir, path));
  return contents;
}

function resolveEnvironment(
  spec: SolutionSpec,
  lock: SolutionLock,
  requested: string | undefined,
  errors: Diagnostic[],
): RuntimeEnvironmentView | undefined {
  const environments = spec.spec.environments ?? {};
  const names = Object.keys(environments).sort();
  const name = requested ?? (names.length === 1 ? names[0] : undefined);

  if (name === undefined) {
    errors.push(
      diagnostic(
        names.length === 0 ? 'environment_missing' : 'environment_required',
        names.length === 0
          ? 'the Spec declares no environments, so a build has no target'
          : `the Spec declares ${names.join(', ')}; pass --environment to choose the one this bundle is for`,
        {
          path: 'spec.environments',
          remediation: 'declare the Environment in the Spec, and pass --environment when there is more than one',
        },
      ),
    );
    return undefined;
  }

  const declared = environments[name];
  if (declared === undefined) {
    errors.push(
      diagnostic('environment_unknown', `the Spec declares no environment ${name}`, {
        path: `spec.environments.${name}`,
        remediation: `use one of ${names.join(', ')}`,
      }),
    );
    return undefined;
  }

  const stateStore = lock.runtime.stateStore;
  return {
    name,
    kind: declared.kind,
    ...(declared.networkClass === undefined ? {} : { networkClass: declared.networkClass }),
    ...(stateStore === undefined
      ? {}
      : {
          stateStore: {
            kind: stateStore.kind,
            ...(stateStore.schemaVersion === undefined ? {} : { schemaVersion: String(stateStore.schemaVersion) }),
          },
        }),
  };
}
