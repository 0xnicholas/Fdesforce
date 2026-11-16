import type { Digest } from '@fde/spec';
import type { RuntimeGenerator, RuntimeGeneratorIdentity } from '../../src/index.js';
import { profileDigest, resolveRuntimeProfile, validateRuntime } from '../../src/index.js';

export const SOURCE_DIGEST = `sha256:${'c'.repeat(64)}` as Digest;

/**
 * A minimal generator that satisfies the port, used to prove the port's shape and
 * the JSON-serializability of everything crossing it. It is deliberately not a
 * Mastra implementation: that is
 * [`@fde/runtime-generator-mastra`](../../../runtime-generator-mastra/README.md),
 * and this file is a conformance harness, not an adapter.
 */
export const fakeGenerator = (
  identity: RuntimeGeneratorIdentity = { family: 'mastra', version: '1.0.0' },
): RuntimeGenerator => ({
  family: identity.family,
  version: identity.version,
  capabilities: (profile) => resolveRuntimeProfile(profile).capabilities,
  validate: (input) => validateRuntime({ ...input, generator: identity }),
  generateApp: (input) => ({
    files: [
      { path: 'runtime-app/Dockerfile', content: 'FROM node:22.13.0\n', mode: 0o644 },
      { path: 'runtime-app/src/index.ts', content: 'export const app = {};\n', mode: 0o644 },
    ],
    dockerfile: { path: 'runtime-app/Dockerfile', content: 'FROM node:22.13.0\n' },
    entrypoint: ['node', 'dist/index.js'],
    buildArgs: { RUNTIME_PROFILE: `${input.profile.metadata.name}@${input.profile.metadata.version}` },
    components: [
      {
        name: 'runtime-app',
        role: 'runtime-app',
        image: { build: { context: 'runtime-app', dockerfile: 'Dockerfile' } },
        ports: [{ name: 'http', containerPort: 4111, expose: true }],
        healthCheck: { path: '/readyz', port: 4111 },
      },
    ],
    sourceDigest: SOURCE_DIGEST,
  }),
  generateTopology: (input) => ({
    apiVersion: 'fde.dev/v0',
    kind: 'RuntimeTopology',
    metadata: {
      profile: `${input.profile.metadata.name}@${input.profile.metadata.version}`,
      profileDigest: profileDigest(input.profile),
      generatorVersion: input.profile.spec.generator.version,
    },
    spec: {
      components: [
        {
          name: 'runtime-app',
          role: 'runtime-app',
          image: { build: { context: `generated/${input.build.buildId}/runtime-app`, dockerfile: 'Dockerfile' } },
          ports: [{ name: 'http', containerPort: 4111, expose: true }],
        },
      ],
      volumes: [],
      jobs: [],
      startupOrder: ['runtime-app'],
      secretBindings: [],
      deploymentNaming: { componentNameTemplate: 'fde-{{deployment_id}}-{{component}}' },
    },
  }),
  generateMigrations: (input) => ({
    steps: [
      {
        id: 'runtime-state',
        owner: 'runtime',
        phase: 'runtime-state',
        reversible: false,
        command: ['node', 'dist/migrate.js'],
        dependsOn: [],
        schemaVersion: input.profile.spec.capabilities.stateStore.schemaVersion,
      },
    ],
  }),
  generateContractTests: () => ({
    cases: [
      { caseId: 'A1', tier: 'static', command: ['node', 'dist/contract-tests/a1.js'], fixtures: [] },
      { caseId: 'A11', tier: 'static', command: ['node', 'dist/contract-tests/a11.js'], fixtures: [] },
    ],
    generatedFiles: [],
  }),
});
