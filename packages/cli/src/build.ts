import { basename } from 'node:path';

import {
  canonicalJson,
  digestFiles,
  parseRuntimeTopology,
  type Digest,
  type Job,
  type RuntimeProfile,
  type RuntimeTopology,
} from '@fde/spec';
import { composeTopology, deploymentInstance, renderCompose } from '@fde/bundle';
import { canonicalJsonFile, pinnedProfileDigest, sourceDigest } from '@fde/runtime-generator';
import type {
  GeneratedApp,
  RuntimeBuildContext,
  RuntimeGenerateInput,
  RuntimeGenerator,
  RuntimeMigrationPlan,
  RuntimeValidationInput,
  RuntimeValidationResult,
  TestPlan,
} from '@fde/runtime-generator';

import { mastraGenerator } from '@fde/runtime-generator-mastra';

import type { LockedBuildInput } from './build-input.js';
import { checkLicenseGate, renderNotice, renderSpdx, type ResolvedComponent } from './license.js';
import { SMOKE_SCRIPT_MODE, smokeScript } from './smoke.js';
import { diagnostic, type Diagnostic } from './types.js';

/**
 * `fde build` — the orchestration (`docs/runtime-adapter.md` §4.4, #33).
 *
 * The order is fixed and fail-closed:
 *
 * 1. read the Spec + lock and verify every digest (in `build-input.ts`)
 * 2. resolve the Runtime Profile by its exact pin and verify the digest
 * 3. `capabilities()` normalizes the declaration
 * 4. `validate()` derives requirements; an error stops the build, warnings are
 *    carried into provenance
 * 5. generate app / topology / migrations / contract tests — twice, because A11
 *    is a check on the generator, not a promise in its README
 * 6. compose `BundleTopology`, render the Compose target, compose migrations
 * 7. run the static conformance checks and compute the bundle digest
 *
 * The build is a pure function of the locked inputs, a deployment id and an
 * injected clock. The clock reaches build provenance and the SPDX `created`
 * field only; neither is part of the bundle digest, so two builds of the same
 * inputs have the same address even when they happen at different times.
 */

export const BUILD_TARGETS = ['compose'] as const;
export type BuildTarget = (typeof BUILD_TARGETS)[number];

/** What produced a bundle. One copy: provenance and the smoke script both name it. */
export const BUILDER_VERSION = '0.1.0';

/** Bundle-root-relative file; mode is explicit so the umask never reaches an artifact. */
export interface BuildFile {
  path: string;
  content: string;
  mode: number;
}

export interface BundleManifest {
  bundleVersion: 1;
  /**
   * `deploymentId` is present only when the build was bound to a deployment. A
   * bundle is normally built before a Deployment exists, so an unbound build
   * renders the Compose target with the reserved placeholder instance and says
   * so (`deploymentBound: false`) instead of inventing a deployment identity.
   */
  solution: {
    customer: string;
    solution: string;
    environment: string;
    deploymentId?: string;
    deploymentBound: boolean;
  };
  specDigest: Digest;
  lockDigest: Digest;
  profile: { ref: string; digest: Digest };
  generator: { family: string; version: string };
  sourceDigest: Digest;
  /** Content address of the deployable payload (see `payloadDigestOf`). */
  digest: Digest;
  artifacts: string[];
  /** Per-file digests of the payload; `bundle.json`, the SBOM and provenance are evidence. */
  files: Record<string, Digest>;
  evidence: { buildProvenance: string; sbom: string };
  licenseGate: { ok: boolean; components: ResolvedComponent[] };
  conformance: {
    cases: Array<{ caseId: string; tier: 'static'; status: 'passed'; checks: string[] }>;
  };
}

export interface BuildProvenance {
  provenanceVersion: 1;
  buildId: string;
  /** What ran the build. Operator identity is a Release-time sign-off, not a build input. */
  builder: { tool: 'fde'; version: string };
  solution: BundleManifest['solution'];
  spec: { digest: Digest; files: Record<string, Digest> };
  lock: { digest: Digest };
  profile: { ref: string; digest: Digest; generator: RuntimeProfile['spec']['generator']; family: string; language: string };
  generator: { family: string; version: string };
  toolchain: LockedBuildInput['lock']['toolchain'];
  platformFragment: { version: string; digest: Digest };
  runtime: LockedBuildInput['lock']['runtime'];
  capabilities: ReturnType<RuntimeGenerator['capabilities']>;
  requirements: RuntimeValidationResult['requirements'];
  warnings: Array<{ code: string; message: string; path?: string; remediation?: string }>;
  licenseGate: { ok: boolean; components: ResolvedComponent[]; catalogDigest: Digest };
  conformance: BundleManifest['conformance'];
  builtAt: string;
}

export interface BuildOutput {
  files: BuildFile[];
  manifest: BundleManifest;
  provenance: BuildProvenance;
  sourceDigest: Digest;
  digest: Digest;
  warnings: Diagnostic[];
}

export type BuildResult =
  | { ok: true; value: BuildOutput }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

export interface BuildEntropy {
  /** Injected so two builds can be compared across different wall clocks. */
  now: () => Date;
  /**
   * Accepted and deliberately unused. A build that starts reading randomness is
   * an A11 regression, and the test that varies this source is how it shows up.
   */
  random: () => string;
}

export interface BuildOptions {
  /** Bind the rendered Compose names to a deployment; omitted means the bundle is not yet deployed. */
  deploymentId?: string;
  target?: BuildTarget;
  generator?: RuntimeGenerator;
  entropy?: BuildEntropy;
}

/**
 * A deployment id has to be a real `dep_<ULID>`; a bundle built before its
 * Deployment exists renders with this reserved all-zero instance, and the
 * manifest records `deploymentBound: false` so nobody mistakes the names in
 * `deploy/compose.yaml` for a deployed instance.
 */
export const UNBOUND_DEPLOYMENT_ID = 'dep_00000000000000000000000000';

const defaultEntropy: BuildEntropy = {
  now: () => new Date(),
  random: () => Math.random().toString(16).slice(2),
};

const FILE_MODE = 0o644;

export function buildBundle(input: LockedBuildInput, options: BuildOptions): BuildResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [...input.warnings];
  const target = options.target ?? 'compose';

  if (!BUILD_TARGETS.includes(target)) {
    errors.push(
      diagnostic('build_target_unsupported', `v0 builds the compose target only (asked for ${target})`, {
        path: '--target',
        remediation: 'pass --target compose; Helm and the airgap bundle are Slice 2.6',
      }),
    );
    return { ok: false, errors, warnings };
  }

  const generator = options.generator ?? generatorFor(input, errors);
  if (generator === undefined) return { ok: false, errors, warnings };

  const entropy = options.entropy ?? defaultEntropy;
  const buildId = deterministicBuildId(input);
  const build: RuntimeBuildContext = {
    buildId,
    toolchain: { generator: input.toolchain.generator, image: input.lock.toolchain.image },
  };

  const validationInput: RuntimeValidationInput = {
    spec: input.spec,
    lock: input.lock,
    environment: input.environment,
    profile: input.profile,
    extensions: input.extensions,
    connectors: input.connectors,
    generator: { family: generator.family, version: generator.version, language: input.profile.spec.language },
  };

  // 3. capabilities() normalizes the declaration. A generator that cannot even
  //    normalize a profile has nothing to validate against.
  let capabilities: ReturnType<RuntimeGenerator['capabilities']>;
  try {
    capabilities = generator.capabilities(input.profile);
  } catch (cause) {
    errors.push(
      diagnostic('runtime_profile_missing', `the generator could not normalize the Runtime Profile: ${messageOf(cause)}`, {
        path: 'profile.spec.capabilities',
        remediation: 'fix the profile declaration and re-lock',
      }),
    );
    return { ok: false, errors, warnings };
  }

  // 4a. A1's build side: the Profile the generator is about to use is the one
  //     the lock pinned. The loader checks this too; a direct `buildBundle`
  //     caller gets the same gate.
  if (pinnedProfileDigest(input.lock.runtime) !== input.profileDigest) {
    errors.push(
      diagnostic('runtime_profile_missing', 'the resolved Runtime Profile is not the one solution.lock pins', {
        path: 'runtime.profile',
        remediation: 'resolve the profile from the lock and verify its digest before building',
      }),
    );
    return { ok: false, errors, warnings };
  }

  // 4b. A9's static half: every Extension this build can see must be an artifact
  //     kind the profile loads, for a runtime the profile is. This is the same
  //     rule the generator's validate applies; running it here makes the
  //     conformance verdict a result, not a literal.
  const extensionErrors = staticExtensionErrors(input, capabilities);
  if (extensionErrors.length > 0) return { ok: false, errors: [...errors, ...extensionErrors], warnings };

  // 4c. The gate. Warnings are provenance whether or not the build continues.
  let validation: RuntimeValidationResult;
  try {
    validation = generator.validate(validationInput);
  } catch (cause) {
    errors.push(
      diagnostic('runtime_manifest_invalid', `the generator's validate threw an internal error: ${messageOf(cause)}`, {
        path: 'spec',
        remediation: 'this is a generator bug, not a Spec diagnosis; fix the generator before building again',
      }),
    );
    return { ok: false, errors, warnings };
  }
  warnings.push(...validation.warnings);
  if (validation.errors.length > 0) return { ok: false, errors: [...errors, ...validation.errors], warnings };

  const generateInput: RuntimeGenerateInput = {
    ...validationInput,
    profile: input.profile,
    build,
    files: input.specFiles,
    modelProfiles: input.modelProfiles,
  };

  // 5. Generate. The generator re-runs its own gate and throws rather than emit a
  //    reduced tree; that throw is a build failure, never a warning.
  let generated: Generated;
  try {
    generated = generateAll(generator, generateInput);
  } catch (cause) {
    errors.push(
      diagnostic('runtime_manifest_invalid', `generation failed: ${messageOf(cause)}`, {
        path: 'spec',
        remediation: 'fix the construct named in the generator diagnostic and rebuild',
      }),
    );
    return { ok: false, errors, warnings };
  }

  // 7a. A11, part one: the same input must produce the same artifacts. This is a
  //     check on the generator, so it runs on every build rather than in a test.
  let second: Generated;
  try {
    second = generateAll(generator, generateInput);
  } catch (cause) {
    errors.push(
      diagnostic('runtime_generation_nondeterministic', `the generator failed on its second pass: ${messageOf(cause)}`, {
        path: 'spec',
        remediation: 'fix the generator so generation is a pure function of the locked inputs',
      }),
    );
    return { ok: false, errors, warnings };
  }
  const deterministic =
    firstDifferingFile(generated.app.files, second.app.files) ??
    firstDifferingFile(generated.contractTests.generatedFiles, second.contractTests.generatedFiles) ??
    firstDivergence(generated, second);
  if (deterministic !== undefined) {
    errors.push(
      diagnostic('runtime_generation_nondeterministic', `two generations of the same inputs differ at ${deterministic}`, {
        path: 'spec',
        remediation: 'remove the clock, randomness, environment read or ordering instability from the generator',
      }),
    );
    return { ok: false, errors, warnings };
  }

  const topologyParsed = parseRuntimeTopology(generated.topology);
  if (!topologyParsed.ok) {
    errors.push(
      ...topologyParsed.errors.map((error) => ({
        code: 'runtime_manifest_invalid',
        message: `generated RuntimeTopology is not schema-valid: ${error.message}`,
        ...(error.path === undefined ? {} : { path: `topology.${error.path}` }),
      })),
    );
    return { ok: false, errors, warnings };
  }

  const manifestValid = checkGeneratedManifest(generated, topologyParsed.value, errors);
  if (!manifestValid) return { ok: false, errors, warnings };

  // 6. The platform composes its half and the runtime's into the one topology a
  //    renderer consumes. The fragment was resolved and digest-verified from the
  //    lock by the loader, so this is not a second resolution.
  const fragment = input.contextServiceTopology;
  const composed = composeTopology({
    solution: input.spec.metadata.solution,
    // A v0 Spec carries no Solution Revision; the lock digest is the revision's
    // identity, and the composed document only needs a monotonic marker.
    revision: 1,
    runtime: topologyParsed.value,
    platform: fragment.topology,
  });
  warnings.push(...composed.warnings);
  if (!composed.ok) return { ok: false, errors: [...errors, ...composed.errors], warnings };

  const topology = composed.topology;
  const platformFragment = { version: fragment.version, digest: fragment.digest };
  const deploymentId = options.deploymentId;
  let instance;
  try {
    instance = deploymentInstance(topology, deploymentId ?? UNBOUND_DEPLOYMENT_ID);
  } catch (cause) {
    errors.push(
      diagnostic('deployment_invalid', messageOf(cause), {
        path: '--deployment',
        remediation: 'pass --deployment dep_<ULID>; the names in the rendered Compose file are derived from it',
      }),
    );
    return { ok: false, errors, warnings };
  }

  const rendered = renderCompose(topology, instance);
  if (!rendered.ok) return { ok: false, errors: [...errors, ...rendered.errors], warnings };

  const migrationPlan = composeMigrationPlan(fragment.topology.spec.jobs, generated.migrations);

  // 4b. The license gate. It decides whether the bundle may be redistributed, so
  //     it runs before any bytes are produced.
  const inventory = componentInventory(input);
  const mastraPackages = mastraPackagesOf(input, generated.app);
  const gate = checkLicenseGate({ catalog: input.licenseCatalog, inventory, mastraPackages });
  if (input.licenseCatalogMismatch !== undefined) {
    errors.push(
      diagnostic(
        'license_catalog_mismatch',
        `the license catalog digests to ${input.licenseCatalogMismatch.actual}, but solution.lock pins ${input.licenseCatalogMismatch.expected}`,
        {
          path: 'toolchain.licenseCatalog',
          remediation: 'the catalog changed after the lock was written; re-lock and review the diff',
        },
      ),
    );
  }
  if (!gate.ok || input.licenseCatalogMismatch !== undefined) {
    return { ok: false, errors: [...errors, ...gate.errors], warnings };
  }

  // 7b. The payload: everything the deployment reads. The SBOM, provenance and
  //     the manifest itself are evidence *about* this payload, so they are not
  //     part of its address (the same rule `fde context freeze` uses).
  const payload: BuildFile[] = [
    ...generated.app.files.map((file) => ({ path: file.path, content: file.content, mode: file.mode ?? FILE_MODE })),
    ...generated.contractTests.generatedFiles.map((file) => ({
      path: file.path,
      content: file.content,
      mode: file.mode ?? FILE_MODE,
    })),
    { path: 'deploy/bundle-topology.json', content: canonicalJsonFile(topology), mode: FILE_MODE },
    { path: rendered.file.path, content: rendered.file.content, mode: FILE_MODE },
    { path: 'deploy/migration-plan.json', content: canonicalJsonFile(migrationPlan), mode: FILE_MODE },
    {
      path: 'deploy/smoke.mjs',
      content: smokeScript({ defaultCapability: defaultSmokeCapability(input), builderVersion: BUILDER_VERSION }).content,
      mode: SMOKE_SCRIPT_MODE,
    },
    ...Object.entries(input.contextPackageFiles).map(([path, content]) => ({
      path: `context/${input.contextPackage?.name ?? 'customer-context'}/${path}`,
      content,
      mode: FILE_MODE,
    })),
    {
      path: 'NOTICE',
      content: renderNotice({
        customer: input.spec.metadata.customer,
        solution: input.spec.metadata.solution,
        components: gate.components,
        catalogDigest: input.licenseCatalog.digest,
      }),
      mode: FILE_MODE,
    },
  ];

  const payloadDigest = payloadDigestOf(payload);
  if (!payloadDigest.ok) {
    errors.push(
      diagnostic('runtime_manifest_invalid', payloadDigest.error, {
        path: 'bundle',
        remediation: 'two artifacts claimed the same bundle path; fix the generator or the package layout',
      }),
    );
    return { ok: false, errors, warnings };
  }
  const payloadSet = payloadDigest.value;

  const conformance: BundleManifest['conformance'] = {
    cases: [
      {
        caseId: 'A1',
        tier: 'static',
        status: 'passed',
        checks: ['profile_digest', 'capability_normalization', 'requirement_satisfaction'],
      },
      {
        caseId: 'A9',
        tier: 'static',
        status: 'passed',
        checks: ['extension_artifact_kind', 'extension_runtime_compatibility'],
      },
      {
        caseId: 'A11',
        tier: 'static',
        status: 'passed',
        checks: ['deterministic_generation', 'source_digest'],
      },
    ],
  };

  const manifest: BundleManifest = {
    bundleVersion: 1,
    solution: {
      customer: input.spec.metadata.customer,
      solution: input.spec.metadata.solution,
      environment: input.environment.name,
      ...(deploymentId === undefined ? {} : { deploymentId }),
      deploymentBound: deploymentId !== undefined,
    },
    specDigest: input.lock.spec.digest as Digest,
    lockDigest: input.lockDigest,
    profile: { ref: input.profileRef, digest: input.profileDigest },
    generator: { family: generator.family, version: generator.version },
    sourceDigest: generated.app.sourceDigest,
    digest: payloadSet.digest,
    artifacts: payloadSet.files.map((file) => file.path),
    files: Object.fromEntries(payloadSet.files.map((file) => [file.path, file.digest])) as Record<string, Digest>,
    evidence: { buildProvenance: 'build-provenance.json', sbom: 'sbom/spdx.json' },
    licenseGate: { ok: true, components: gate.components },
    conformance,
  };

  const builtAt = entropy.now().toISOString();
  const provenance: BuildProvenance = {
    provenanceVersion: 1,
    buildId,
    builder: { tool: 'fde', version: BUILDER_VERSION },
    solution: manifest.solution,
    spec: { digest: input.lock.spec.digest as Digest, files: input.lock.spec.files as Record<string, Digest> },
    lock: { digest: input.lockDigest },
    profile: {
      ref: input.profileRef,
      digest: input.profileDigest,
      generator: input.profile.spec.generator,
      family: input.profile.spec.family,
      language: input.profile.spec.language,
    },
    generator: manifest.generator,
    toolchain: input.lock.toolchain,
    platformFragment,
    runtime: input.lock.runtime,
    capabilities,
    requirements: validation.requirements,
    warnings: warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.path === undefined ? {} : { path: warning.path }),
      ...(warning.remediation === undefined ? {} : { remediation: warning.remediation }),
    })),
    licenseGate: { ok: true, components: gate.components, catalogDigest: input.licenseCatalog.digest },
    conformance,
    builtAt,
  };

  const sbom = renderSpdx({
    name: `fde-${input.spec.metadata.customer}-${input.spec.metadata.solution}`,
    namespace: `${input.spec.metadata.customer}/${input.spec.metadata.solution}/${manifest.digest.replace(/^sha256:/, '')}`,
    created: builtAt.replace(/\.\d{3}Z$/, 'Z'),
    components: gate.components,
  });

  const files: BuildFile[] = [
    ...payload,
    { path: 'sbom/spdx.json', content: sbom, mode: FILE_MODE },
    { path: 'build-provenance.json', content: canonicalJsonFile(provenance), mode: FILE_MODE },
    { path: 'bundle.json', content: canonicalJsonFile(manifest), mode: FILE_MODE },
  ];
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    errors.push(
      diagnostic('runtime_manifest_invalid', 'the bundle writes the same path twice', {
        path: 'bundle',
        remediation: 'fix the generator or the package layout; evidence files own their reserved names',
      }),
    );
    return { ok: false, errors, warnings };
  }

  return {
    ok: true,
    value: {
      files: sortBuildFiles(files),
      manifest,
      provenance,
      sourceDigest: generated.app.sourceDigest,
      digest: manifest.digest,
      warnings,
    },
  };
}

interface Generated {
  app: GeneratedApp;
  topology: RuntimeTopology;
  migrations: RuntimeMigrationPlan;
  contractTests: TestPlan;
}

function generateAll(generator: RuntimeGenerator, input: RuntimeGenerateInput): Generated {
  return {
    app: generator.generateApp(input),
    topology: generator.generateTopology(input),
    migrations: generator.generateMigrations(input),
    contractTests: generator.generateContractTests(input),
  };
}

function generatorFor(input: LockedBuildInput, errors: Diagnostic[]): RuntimeGenerator | undefined {
  if (input.profile.spec.family === 'mastra') return mastraGenerator;
  errors.push(
    diagnostic('runtime_generator_missing', `no generator implements the ${input.profile.spec.family} runtime family`, {
      path: 'profile.spec.family',
      remediation: 'choose a Runtime Profile this workbench ships a generator for, or add the generator',
    }),
  );
  return undefined;
}

/** A9 static: an Extension artifact must load in the app this profile generates. */
function staticExtensionErrors(
  input: LockedBuildInput,
  capabilities: ReturnType<RuntimeGenerator['capabilities']>,
): Diagnostic[] {
  const errors: Diagnostic[] = [];
  const kinds = capabilities.extensions.artifactKinds;
  for (const extension of input.extensions) {
    const artifact = `${extension.name}@${extension.version}`;
    if (!kinds.includes(extension.artifactKind)) {
      errors.push(
        diagnostic(
          'runtime_extension_unsupported',
          `Extension ${artifact} is a ${extension.artifactKind} artifact, and the profile loads ${kinds.join(', ')}`,
          {
            path: 'spec.extensions',
            remediation: 'publish the artifact in a kind the profile loads, or choose a Runtime Profile that loads it',
          },
        ),
      );
      continue;
    }
    if (
      extension.runtimeCompatibility !== undefined &&
      !extension.runtimeCompatibility.some(
        (combination) =>
          combination.family === input.profile.spec.family &&
          combination.language === input.profile.spec.language,
      )
    ) {
      errors.push(
        diagnostic(
          'runtime_extension_unsupported',
          `Extension ${artifact} declares no runtimeCompatibility for ${input.profile.spec.family}/${input.profile.spec.language}`,
          {
            path: 'spec.extensions',
            remediation: 'publish a build for this runtime, or choose a Runtime Profile the Extension supports',
          },
        ),
      );
    }
  }
  return errors;
}

function deterministicBuildId(input: LockedBuildInput): string {
  return `${input.spec.metadata.customer}/${input.spec.metadata.solution}@${input.lock.spec.digest.slice('sha256:'.length, 'sha256:'.length + 12)}`;
}

/**
 * The capability the bundle's smoke starts when the operator names none: the first
 * by id, so the choice does not depend on the Spec's key order. Every capability a
 * Slice-1 build can generate is read-only — the grammar gate refuses approval steps
 * and side-effecting Tools — so "first by id" cannot pick a write path. An empty
 * Spec gets an empty default, and the smoke then asks for `--capability` instead of
 * starting a Run against a capability that does not exist.
 */
function defaultSmokeCapability(input: LockedBuildInput): string {
  return Object.keys(input.spec.spec.capabilities).sort()[0] ?? '';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The first generated path whose bytes moved between two passes, for an actionable diagnostic. */
function firstDifferingFile(
  left: ReadonlyArray<{ path: string; content: string }>,
  right: ReadonlyArray<{ path: string; content: string }>,
): string | undefined {
  const rightByPath = new Map(right.map((file) => [file.path, file.content]));
  for (const file of left) {
    if (rightByPath.get(file.path) !== file.content) return file.path;
  }
  const leftPaths = new Set(left.map((file) => file.path));
  return right.find((file) => !leftPaths.has(file.path))?.path;
}

/** The first JSON path at which two generations disagree, or `undefined` when they agree. */
function firstDivergence(left: unknown, right: unknown, path = ''): string | undefined {
  const encodedLeft = safeJson(left);
  const encodedRight = safeJson(right);
  if (encodedLeft === encodedRight) return undefined;

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      const found = firstDivergence(left[key], right[key], path === '' ? key : `${path}.${key}`);
      if (found !== undefined) return found;
    }
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const found = firstDivergence(left[index], right[index], `${path}[${index}]`);
      if (found !== undefined) return found;
    }
  }
  return path === '' ? '<root>' : path;
}

function safeJson(value: unknown): string {
  try {
    return canonicalJson(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `runtime_manifest_invalid`: what the generator returned is not the artifact the
 * contract describes. Each check names the piece, so a second generator sees the
 * same failure without a Mastra-shaped message.
 */
function checkGeneratedManifest(generated: Generated, topology: RuntimeTopology, errors: Diagnostic[]): boolean {
  const before = errors.length;
  const app = generated.app;

  const paths = app.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    errors.push(diagnostic('runtime_manifest_invalid', 'the generated app writes the same path twice', { path: 'mastra-app' }));
  }
  if (paths.some((path, index) => index > 0 && (paths[index - 1] as string) > path)) {
    errors.push(
      diagnostic('runtime_manifest_invalid', 'the generated app files are not sorted by path', {
        path: 'mastra-app',
        remediation: 'sort generated files before returning them; bundle digests must not depend on write order',
      }),
    );
  }
  if (app.sourceDigest !== sourceDigest(app.files)) {
    errors.push(
      diagnostic('runtime_manifest_invalid', `the generated app reports sourceDigest ${app.sourceDigest}, but its files digest to ${sourceDigest(app.files)}`, {
        path: 'mastra-app',
      }),
    );
  }
  const dockerfile = app.files.find((file) => file.path === app.dockerfile.path);
  if (dockerfile === undefined || dockerfile.content !== app.dockerfile.content) {
    errors.push(
      diagnostic('runtime_manifest_invalid', `GeneratedApp.dockerfile points at ${app.dockerfile.path}, which is not in the file list`, {
        path: 'mastra-app',
      }),
    );
  }
  if (app.entrypoint.length === 0) {
    errors.push(diagnostic('runtime_manifest_invalid', 'the generated app declares no entrypoint', { path: 'mastra-app' }));
  }

  const topologyNames = new Set(topology.spec.components.map((component) => component.name));
  for (const component of app.components) {
    if (!topologyNames.has(component.name)) {
      errors.push(
        diagnostic('runtime_manifest_invalid', `the generated app declares component ${component.name}, which the RuntimeTopology does not`, {
          path: 'topology.spec.components',
        }),
      );
    }
  }

  for (const step of generated.migrations.steps) {
    if (step.owner !== 'runtime' || step.phase !== 'runtime-state') {
      errors.push(
        diagnostic('runtime_manifest_invalid', `migration ${step.id} is ${step.owner}/${step.phase}, expected runtime/runtime-state`, {
          path: 'migrations',
        }),
      );
    }
    if (step.command.length === 0) {
      errors.push(diagnostic('runtime_manifest_invalid', `migration ${step.id} has no command`, { path: 'migrations' }));
    }
  }

  const contractPaths = generated.contractTests.generatedFiles.map((file) => file.path);
  if (new Set(contractPaths).size !== contractPaths.length) {
    errors.push(diagnostic('runtime_manifest_invalid', 'the contract test plan writes the same path twice', { path: 'contract-tests' }));
  }
  if (contractPaths.some((path, index) => index > 0 && (contractPaths[index - 1] as string) > path)) {
    errors.push(
      diagnostic('runtime_manifest_invalid', 'the contract test plan files are not sorted by path', {
        path: 'contract-tests',
        remediation: 'sort generated files before returning them',
      }),
    );
  }
  if (!generated.contractTests.cases.some((testCase) => testCase.caseId === 'A11')) {
    errors.push(
      diagnostic('runtime_manifest_invalid', 'the contract test plan has no A11 case; deterministic generation is not optional', {
        path: 'contract-tests',
      }),
    );
  }

  return errors.length === before;
}

function componentInventory(input: LockedBuildInput): Array<{ name: string; version: string }> {
  const inventory = new Map<string, string>();
  const add = (name: string, version: string): void => {
    if (!inventory.has(name)) inventory.set(name, version);
  };

  for (const [name, version] of Object.entries(input.profile.spec.packages)) add(name, version);
  add('@mastra/core', input.lock.runtime.mastra);
  add('node', input.lock.runtime.node);
  add('python', input.lock.runtime.python);
  add('semantica', input.lock.runtime.semantica);
  add('context-service', input.lock.runtime.contextService);

  return [...inventory.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([name, version]) => ({ name, version }));
}

/**
 * Every Mastra package the bundle can see: the profile's pins and every
 * `package.json` in the generated tree. Scanner, not a fixed `mastra-app/`
 * path, so a second generator's app directory is covered too.
 */
function mastraPackagesOf(input: LockedBuildInput, app: GeneratedApp): string[] {
  const packages = new Set(Object.keys(input.profile.spec.packages));
  for (const manifest of app.files.filter((file) => basename(file.path) === 'package.json')) {
    try {
      const parsed = JSON.parse(manifest.content) as Record<string, unknown>;
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        const dependencies = parsed[section];
        if (!isPlainObject(dependencies)) continue;
        for (const name of Object.keys(dependencies)) packages.add(name);
      }
    } catch {
      // The generator's own schema check owns a malformed package.json; the
      // license gate simply has fewer names to look at here.
    }
  }
  return [...packages].sort();
}

function composeMigrationPlan(
  platformJobs: ReadonlyArray<Job>,
  runtime: RuntimeMigrationPlan,
): { migrationPlanVersion: 1; steps: Array<Record<string, unknown>> } {
  const platformSteps = platformJobs
    .filter((job) => job.steps.some((step) => (step.runBefore ?? []).length > 0))
    .flatMap((job) =>
      job.steps.map((step) => ({
        id: step.id,
        owner: 'context-service',
        phase: 'platform-state',
        command: [...step.command, ...(step.args ?? [])],
        dependsOn: [],
      })),
    );
  return {
    migrationPlanVersion: 1,
    steps: [...platformSteps, ...runtime.steps.map((step) => ({ ...step }))],
  };
}

interface FileDigest {
  path: string;
  digest: Digest;
}

interface PayloadDigest {
  digest: Digest;
  files: FileDigest[];
}

/**
 * The bundle's address: `digestFiles()` over the sorted payload. Evidence
 * (`bundle.json`, the SBOM, build provenance) is deliberately outside it — the
 * clock lives there, and a content address that moves between two builds of the
 * same inputs is not a content address.
 */
type PayloadDigestResult = { ok: true; value: PayloadDigest } | { ok: false; error: string };

function payloadDigestOf(payload: ReadonlyArray<BuildFile>): PayloadDigestResult {
  const seen = new Set<string>();
  for (const file of payload) {
    if (seen.has(file.path)) {
      return { ok: false, error: `two artifacts claim the bundle path ${file.path}; a bundle path is unique` };
    }
    seen.add(file.path);
  }
  const sorted = [...payload].sort(comparePaths);
  const set = digestFiles(sorted.map((file) => ({ path: file.path, content: file.content })));
  return {
    ok: true,
    value: {
      digest: set.digest,
      files: sorted.map((file) => ({ path: file.path, digest: set.files[file.path] as Digest })),
    },
  };
}

/** Stable path order for a bundle; the file order is part of A11. */
function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sortBuildFiles(files: ReadonlyArray<BuildFile>): BuildFile[] {
  return [...files].sort(comparePaths);
}
