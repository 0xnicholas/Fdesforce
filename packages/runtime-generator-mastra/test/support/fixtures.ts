import {
  digestOf,
  parseIdentityProfile,
  parseModelProfile,
  parseRuntimeProfile,
  parseSolutionLock,
  parseSolutionSpec,
} from '@fde/spec';
import type { IdentityProfile, ModelProfile, ProfileSpec, RuntimeProfile, SolutionLock, SolutionSpec } from '@fde/spec';
import type { RuntimeGenerateInput } from '@fde/runtime-generator';

import { paths, readTree, readYaml } from './repo.js';

/**
 * Fixtures for this package's seams.
 *
 * Deliberately a separate copy of `@fde/runtime-generator`'s test support rather
 * than an import of it: a test fixture that reaches into another package's test
 * fixtures makes both suites change whenever either one does, and these fixtures
 * carry different emphases — the gate suite feeds `validate`, this one feeds
 * generation, so it also carries the Spec's `files/**` and the Model Profiles.
 */

/** Test mutations are intentionally loose; the Spec is re-parsed after each one. */
export type Mutable = Record<string, any>;

const parseOrThrow = <T>(parsed: { ok: true; value: T } | { ok: false; errors: unknown }): T => {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
  return parsed.value;
};

export const exampleSpecDocument = (): Mutable => readYaml<Mutable>(paths.exampleSpec);

export const parseSpec = (document: Mutable): SolutionSpec => parseOrThrow(parseSolutionSpec(document));

export const exampleSpec = (): SolutionSpec => parseSpec(exampleSpecDocument());

export const exampleProfile = (): RuntimeProfile =>
  parseOrThrow(parseRuntimeProfile(readYaml(paths.exampleRuntimeProfile)));

export const exampleLock = (): SolutionLock => parseOrThrow(parseSolutionLock(readYaml(paths.exampleLock)));

const modelProfile = (path: string): ModelProfile => parseOrThrow(parseModelProfile(readYaml(path)));

/** The `acme-prod` identity source a dev build is given (#29). Not a Bundle artifact. */
export const exampleIdentity = (): IdentityProfile => parseOrThrow(parseIdentityProfile(readYaml(paths.exampleIdentity)));

/**
 * The Spec's local file set, exactly as `solution.lock.spec.files` describes it:
 * the CLI resolves this from the Spec directory and hands it over, because
 * generation may not read the disk (A11).
 */
export const exampleSpecFiles = (): Record<string, string> => readTree(paths.exampleSpecDir);

/**
 * The build input for the reference path: the Acme read-only Spec, its lock, the
 * Mastra Runtime Profile, the `acme-prod` Environment and the Model Profile the
 * triage agent pins. The Connector Extension is resolved and compatible, which
 * is exactly the case the grammar gate still has to judge: a connector artifact
 * is loaded by context-service, never by the generated app.
 */
export const generateInput = (): RuntimeGenerateInput => ({
  spec: exampleSpec(),
  lock: exampleLock(),
  profile: exampleProfile(),
  environment: {
    name: 'acme-prod',
    kind: 'prod',
    networkClass: 'restricted',
    stateStore: { kind: 'sqlite', schemaVersion: '1' },
  },
  generator: { family: 'mastra', version: '1.0.0', language: 'typescript' },
  extensions: [
    { name: 'acme-claims-connector', version: '1.0.0', artifactKind: 'ts-package', interface: 'connector' },
  ],
  connectors: {
    'claims-db': {
      name: 'claims-db',
      operations: {
        lookupClaim: {
          inputSchema: 'files/schemas/claims-lookup.input.json',
          outputSchema: 'files/schemas/claims-lookup.output.json',
          sideEffects: 'read',
          scopes: ['claims:read'],
        },
        recordDecision: { sideEffects: 'write', scopes: ['claims:write'] },
      },
    },
  },
  identity: exampleIdentity(),
  files: exampleSpecFiles(),
  modelProfiles: {
    standard: modelProfile(paths.modelProfile),
    'standard-fallback': modelProfile(paths.fallbackModelProfile),
  },
  build: {
    buildId: 'acme-claims-triage@1',
    toolchain: { generator: '0.1.0', image: 'ghcr.io/fde-workbench/toolchain' },
  },
});

/**
 * Apply a mutation to a fresh copy of the reference build input.
 *
 * The Spec is re-parsed, so a mutation that broke the document grammar fails
 * here with the schema's own diagnostic instead of a confusing generator result,
 * and the lock is re-pinned to the (possibly mutated) Profile, so every test
 * starts from a build whose pins are honest and only the construct under test is
 * wrong.
 */
export const mutatedGenerateInput = (change: (input: Mutable) => void): RuntimeGenerateInput => {
  const input = structuredClone(generateInput()) as unknown as Mutable;
  change(input);

  const profile = input['profile'] as RuntimeProfile;
  const lock = input['lock'] as SolutionLock;
  lock.runtime.profile = `${profile.metadata.name}@${profile.metadata.version}@${digestOf(profile)}`;
  delete lock.runtime.profileDigest;

  input['spec'] = parseSpec(input['spec'] as Mutable);
  return input as unknown as RuntimeGenerateInput;
};

export const specBody = (input: Mutable): Mutable => input['spec']['spec'] as Mutable;

/** The Profile's capability block, for the tests that mutate a declaration. */
export const capabilities = (input: Mutable): Mutable =>
  (input['profile'] as RuntimeProfile).spec.capabilities as unknown as Mutable;

/** A capability group's contents, as a loose record. */
export const group = (input: Mutable, name: keyof ProfileSpec['capabilities']): Mutable =>
  capabilities(input)[name] as Mutable;
