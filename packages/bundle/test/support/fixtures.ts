import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { parseContextServiceTopology, parseRuntimeTopology } from '@fde/spec';
import type { BundleTopology, ContextServiceTopology, ParseResult, RuntimeTopology } from '@fde/spec';

import { composeTopology } from '../../src/index.js';
import type { ComposeTopologyResult } from '../../src/index.js';
import { deploymentInstance } from '../../src/index.js';
import type { DeploymentInstance } from '../../src/index.js';

/**
 * Fixtures for this package's seams.
 *
 * The platform half is the real vendored artifact (`platform/context-service/…`),
 * not a copy: a test that used a hand-written stand-in would keep passing while the
 * artifact a build actually composes drifted. The runtime half is written out in the
 * shape `RuntimeGenerator.generateTopology` returns (`docs/runtime-adapter.md` §8.2);
 * the build composes the generator's real output (#33), and this package must not
 * import generator code to do its job (§8.1).
 */

export const repoRoot = resolve(import.meta.dirname, '../../../..');

export const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const OTHER_DEPLOYMENT_ID = 'dep_01BX5ZZKBKACTAV9WEVGEMMVRZ';

export const PLATFORM_FRAGMENT = 'platform/context-service/1.0.0/topology.yaml';

export const readYaml = <T = unknown>(path: string): T =>
  parseYaml(readFileSync(join(repoRoot, path), 'utf8')) as T;

export const parseOrThrow = <T>(parsed: ParseResult<T>): T => {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
  return parsed.value;
};

export const platformFragment = (): ContextServiceTopology =>
  parseOrThrow(parseContextServiceTopology(readYaml(PLATFORM_FRAGMENT)));

/** The runtime-owned fragment, with the values the Mastra generator emits. */
export const runtimeFragment = (): RuntimeTopology =>
  parseOrThrow(
    parseRuntimeTopology({
      apiVersion: 'fde.dev/v0',
      kind: 'RuntimeTopology',
      metadata: {
        profile: 'mastra-1.83-node22@1.0.0',
        profileDigest: `sha256:${'c'.repeat(64)}`,
        generatorVersion: '1.0.0',
      },
      spec: {
        components: [
          {
            name: 'mastra-app',
            role: 'runtime-app',
            image: { build: { context: 'mastra-app', dockerfile: 'Dockerfile' } },
            ports: [{ name: 'http', containerPort: 4111, expose: true }],
            volumes: [{ name: 'mastra-state', mountPath: '/app/state' }],
            env: [
              { name: 'FDE_SIGNING_KEY_FILE', value: '/run/secrets/execution-context-signing-key' },
              { name: 'FDE_STATE_STORE_PATH', value: '/app/state/mastra.db' },
              { name: 'NODE_ENV', value: 'production' },
            ],
            healthCheck: {
              path: '/readyz',
              port: 4111,
              command: [
                'node',
                '-e',
                "fetch('http://127.0.0.1:4111/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
              ],
            },
            dependsOn: ['context-service'],
            resources: { cpu: '1', memory: '1Gi' },
            secretRefs: [{ store: 'customer', key: 'fde/execution-context-signing-key' }],
          },
        ],
        volumes: [{ name: 'mastra-state', backup: true }],
        jobs: [
          {
            name: 'runtime-migrate',
            owner: 'runtime',
            steps: [
              {
                id: 'runtime-state',
                command: ['node', '--experimental-strip-types', 'src/migrate.ts'],
                runBefore: ['mastra-app'],
              },
            ],
            volumes: [{ name: 'mastra-state', mountPath: '/app/state' }],
            env: [{ name: 'FDE_STATE_STORE_PATH', value: '/app/state/mastra.db' }],
          },
        ],
        startupOrder: ['runtime-migrate', 'mastra-app'],
        secretBindings: [
          {
            secretRef: { store: 'customer', key: 'fde/execution-context-signing-key' },
            target: 'file',
            name: '/run/secrets/execution-context-signing-key',
            required: true,
          },
        ],
        deploymentNaming: {
          componentNameTemplate: 'fde-{{deployment_id}}-{{component}}',
          namespaceTemplate: 'fde-{{deployment_id}}',
        },
      },
    }),
  );

export const compose = (input?: { runtime?: RuntimeTopology; platform?: ContextServiceTopology }): ComposeTopologyResult =>
  composeTopology({
    solution: 'claims-triage',
    revision: 1,
    runtime: input?.runtime ?? runtimeFragment(),
    platform: input?.platform ?? platformFragment(),
  });

/** The composed bundle, for the seams that consume one. */
export const bundleTopology = (): BundleTopology => {
  const composed = compose();
  if (!composed.ok) throw new Error(JSON.stringify(composed.errors, null, 2));
  return composed.topology;
};

export const deployment = (topology: BundleTopology, deploymentId: string): DeploymentInstance =>
  deploymentInstance(topology, deploymentId);
