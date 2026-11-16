import type {
  Component,
  Digest,
  RuntimeCapabilities,
  RuntimeProfile,
  RuntimeTopology,
  SolutionLock,
  SolutionSpec,
} from '@fde/spec';

import type { RuntimeDiagnosticCode } from './codes.js';

/**
 * The `RuntimeGenerator` port (`docs/runtime-adapter.md` §4).
 *
 * This is a *build-time* port, not a runtime abstraction: it turns a Solution
 * Spec plus a Runtime Profile into source, migrations, a topology fragment and a
 * test plan. There is deliberately no `build`, `deploy`, `run`, `resume` or
 * `checkpoint` method — a port that grows one has silently become the runtime
 * abstraction ADR-0010 rejected.
 *
 * Everything crossing the port is JSON-serializable plain data, because a second
 * generator may be Python and speak to the workbench through a JSON/CLI shim.
 * A generator is a pure function of its input: no clock, no randomness, no
 * environment values, no network, no disk.
 */

export type RuntimeFamily = string;
export type RuntimeLanguage = 'typescript' | 'python';
export type RequirementLevel = 'must' | 'should';

/** A resolved, non-secret view of the Environment the build targets. */
export interface RuntimeEnvironmentView {
  name: string;
  kind?: 'dev' | 'staging' | 'prod';
  /** `restricted` selects the offline gate; any other value is online. */
  networkClass?: string;
  /** The runtime state store this Environment selects; absent means platform default. */
  stateStore?: { kind: 'sqlite' | 'libsql' | 'postgres'; schemaVersion?: string };
  /** Non-secret configuration the generated app may bake in. Never a secret value. */
  values?: Record<string, string>;
}

/** A resolved Extension artifact the Spec references. */
export interface RuntimeExtensionView {
  name: string;
  version: string;
  /** `ts-package` | `python-wheel` | `http` — the profile must list it. */
  artifactKind: 'ts-package' | 'python-wheel' | 'http';
  /** Runtime combinations the artifact supports; absent means no declared constraint. */
  runtimeCompatibility?: Array<{ family: RuntimeFamily; language: RuntimeLanguage }>;
}

/**
 * A Connector's typed operation (`docs/runtime-adapter.md` D6). Connector-backed
 * Tools reach the outside world only through these; the generator emits a thin
 * Tool that calls context-service. Until #29 lands the typed operation manifest
 * (GAPS.md GAP-1) the CLI supplies what the Connector declares today, and a Tool
 * that pins its own `inputSchema`/`outputSchema` is what makes the operation
 * typed.
 */
export interface RuntimeConnectorOperationView {
  inputSchema?: string;
  outputSchema?: string;
  sideEffects?: 'read' | 'write' | 'external';
  scopes?: string[];
  idempotency?: string;
}

export interface RuntimeConnectorView {
  name: string;
  /** Operations the Connector declares, keyed by operation name. */
  operations: Record<string, RuntimeConnectorOperationView>;
}

/** Which generator is asking. Optional, so the gate can run before a family is chosen. */
export interface RuntimeGeneratorIdentity {
  family: RuntimeFamily;
  version: string;
  /** The language the generator emits; `family` alone does not fix it (LangGraph has JS and Python). */
  language?: RuntimeLanguage;
}

export interface RuntimeValidationInput {
  spec: SolutionSpec;
  lock: SolutionLock;
  environment: RuntimeEnvironmentView;
  /** Absent when resolution failed; `validate` then reports `runtime_profile_missing`. */
  profile?: RuntimeProfile;
  generator?: RuntimeGeneratorIdentity;
  extensions?: RuntimeExtensionView[];
  connectors?: Record<string, RuntimeConnectorView>;
}

/** Deterministic build inputs. Nothing here may be read from a clock or an env var. */
export interface RuntimeBuildContext {
  buildId: string;
  toolchain: { generator: string; image: string };
}

export type RuntimeGenerateInput = Omit<RuntimeValidationInput, 'profile'> & {
  profile: RuntimeProfile;
  build: RuntimeBuildContext;
};

/** One derived `must`/`should`, recorded verbatim in build provenance (§7.1). */
export interface RuntimeRequirement {
  /** `hitl.consume`, `durableWorkflow`, … a path `capabilities()` can answer. */
  capability: string;
  level: RequirementLevel;
  /** Where it came from: `spec.<path>`, `contract:<ref>#<anchor>` or `build:<key>`. */
  source: string;
  note?: string;
}

export interface RuntimeDiagnostic {
  code: RuntimeDiagnosticCode;
  message: string;
  /** The capability path the diagnostic is about, when it is about one. */
  capability?: string;
  /**
   * The offending location: `spec.*` for the Spec, `profile.spec.*` for the Profile,
   * `runtime.*` for the lock, `environment.<name>.*` for the Environment view. Omitted
   * when a requirement came from the contract or a build default, which have no
   * document location to point at.
   */
  path?: string;
  remediation?: string;
}

export interface RuntimeValidationResult {
  /** Every derived requirement, including the ones that failed: this is provenance. */
  requirements: RuntimeRequirement[];
  errors: RuntimeDiagnostic[];
  warnings: RuntimeDiagnostic[];
}

export interface GeneratedFile {
  /** Build-root-relative, POSIX, deterministic. */
  path: string;
  content: string;
  /** Explicit mode; generation never depends on the umask. */
  mode?: number;
}

export interface GeneratedApp {
  /** Sorted by path; identical inputs must produce an identical list (A11). */
  files: GeneratedFile[];
  dockerfile: { path: string; content: string };
  entrypoint: string[];
  buildArgs: Record<string, string>;
  /** The runtime-owned components, in `bundle-topology.schema.json` shape. */
  components: Component[];
  /** Digest over the file contents — the reproducibility check of A11. */
  sourceDigest: Digest;
}

export interface RuntimeMigrationPlan {
  steps: Array<{
    id: string;
    owner: 'runtime';
    phase: 'runtime-state';
    reversible: boolean;
    command: string[];
    dependsOn: string[];
    schemaVersion?: string;
  }>;
}

/** A-cases the generator owns (`contracts/conformance/adapter-cases.md`). */
export type RuntimeAdapterCaseId = 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A9' | 'A10' | 'A11' | 'A12';

export interface TestPlan {
  cases: Array<{
    caseId: RuntimeAdapterCaseId;
    tier: 'static' | 'smoke' | 'release';
    command: string[];
    fixtures: string[];
    notes?: string;
  }>;
  generatedFiles: GeneratedFile[];
}

/**
 * The port. Six methods, no lifecycle: `capabilities` and `validate` decide
 * whether a build may proceed; the four `generate*` methods produce artifacts.
 */
export interface RuntimeGenerator {
  readonly family: RuntimeFamily;
  readonly version: string;

  /** Parse and normalize the Profile's ten groups. Pure; does not read the Spec. */
  capabilities(profile: RuntimeProfile): RuntimeCapabilities;
  /** Derive `must`/`should` and fail closed. Never throws for an expected failure. */
  validate(input: RuntimeValidationInput): RuntimeValidationResult;
  generateApp(input: RuntimeGenerateInput): GeneratedApp;
  generateTopology(input: RuntimeGenerateInput): RuntimeTopology;
  generateMigrations(input: RuntimeGenerateInput): RuntimeMigrationPlan;
  generateContractTests(input: RuntimeGenerateInput): TestPlan;
}
