import { profileDigest, resolveRuntimeProfile, sourceDigest, validateRuntime } from '@fde/runtime-generator';
import type {
  GeneratedApp,
  RuntimeGenerateInput,
  RuntimeGenerator,
  RuntimeValidationInput,
  RuntimeValidationResult,
} from '@fde/runtime-generator';

import { APP_DIR, APP_PORT, DOCKERFILE_PATH, entrypoint, generateAppFiles } from './app.js';
import { generateContractTests } from './contract-tests.js';
import { unsupportedGrammar, unsupportedStateStore } from './grammar.js';
import { generateMigrations, generateTopology } from './topology.js';

/**
 * The v0 Mastra generator (`docs/runtime-adapter.md` §12).
 *
 * `capabilities` and `validate` are the shared gate plus the grammar this
 * generator alone understands; the four `generate*` methods emit the source tree,
 * the runtime-owned topology fragment, the state store migration and the A-case
 * plan. Each one re-checks the gate and throws rather than emitting an empty
 * artifact: an empty topology renders a deployment that silently has no runtime
 * in it, and an empty migration plan starts a store with no schema.
 */

export const MASTRA_FAMILY = 'mastra';

/**
 * The generator's `validate`: the shared capability gate, then the grammar gate.
 *
 * `version` is the *running* generator's version, so the shared gate can catch a
 * profile written for a different one. Both halves are diagnostics and never
 * exceptions: the build prints them and stops, and there is no `--force`.
 */
export function validateMastra(input: RuntimeValidationInput, version: string): RuntimeValidationResult {
  const shared = validateRuntime({ ...input, generator: { ...input.generator, family: MASTRA_FAMILY, version } });
  const grammar = [...unsupportedGrammar(input.spec, input.extensions ?? []), ...unsupportedStateStore(input.environment)];

  return { requirements: shared.requirements, errors: [...shared.errors, ...grammar], warnings: shared.warnings };
}

export function createMastraGenerator(version: string): RuntimeGenerator {
  const generate = <T>(input: RuntimeGenerateInput, emit: (gated: RuntimeGenerateInput) => T): T => {
    gated(input, version);
    return emit(input);
  };

  return {
    family: MASTRA_FAMILY,
    version,

    capabilities: (profile) => resolveRuntimeProfile(profile).capabilities,

    validate: (input) => validateMastra(input, version),

    generateApp: (input) => generate(input, (valid) => generateApp(valid, version)),
    generateTopology: (input) => generate(input, generateTopology),
    generateMigrations: (input) => generate(input, generateMigrations),
    generateContractTests: (input) => generate(input, generateContractTests),
  };
}

/**
 * Generation only runs after a clean gate. Re-checking here is not redundant: it
 * is the difference between "the CLI is supposed to call validate first" and "a
 * caller that skipped validate cannot get a tree with an approval gate silently
 * dropped out of it".
 *
 * The check drops `build`: build ids and toolchain images are provenance, not
 * validation input, and a generator that validated them would fail on a field it
 * does not judge.
 */
function gated(input: RuntimeGenerateInput, version: string): void {
  const { build: _build, ...validation } = input;
  const gate = validateMastra(validation, version);
  if (gate.errors.length === 0) return;

  const reasons = gate.errors.map(
    (error) => `${error.code}${error.path === undefined ? '' : ` at ${error.path}`}: ${error.message}`,
  );
  throw new Error(`refusing to generate for a Spec that fails the gate:\n- ${reasons.join('\n- ')}`);
}

function generateApp(input: RuntimeGenerateInput, version: string): GeneratedApp {
  const files = generateAppFiles(input, version);
  const dockerfile = files.find((file) => file.path === DOCKERFILE_PATH);
  if (dockerfile === undefined) throw new Error('the generated tree has no Dockerfile');

  return {
    files,
    dockerfile: { path: dockerfile.path, content: dockerfile.content },
    entrypoint: entrypoint(),
    buildArgs: buildArgs(input),
    components: [
      {
        name: APP_DIR,
        role: 'runtime-app',
        image: { build: { context: APP_DIR, dockerfile: 'Dockerfile' } },
        ports: [{ name: 'http', containerPort: APP_PORT, expose: true }],
        healthCheck: { path: '/healthz', port: APP_PORT },
      },
    ],
    sourceDigest: sourceDigest(files),
  };
}

/** The identity the runtime-info handshake re-checks at startup (#30). Every value is pinned input. */
function buildArgs(input: RuntimeGenerateInput): Record<string, string> {
  return {
    FDE_CONTRACT_VERSION: input.lock.runtime.contractVersion,
    FDE_GENERATOR_VERSION: input.profile.spec.generator.version,
    FDE_PROFILE_DIGEST: profileDigest(input.profile),
    FDE_RUNTIME_PROFILE: `${input.profile.metadata.name}@${input.profile.metadata.version}`,
  };
}
