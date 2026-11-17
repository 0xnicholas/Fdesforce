import { profileDigest } from '@fde/runtime-generator';
import type { RuntimeGenerateInput, RuntimeMigrationPlan } from '@fde/runtime-generator';
import type { RuntimeTopology } from '@fde/spec';

import {
  APP_DIR,
  APP_PORT,
  CONTEXT_SERVICE_COMPONENT,
  INJECTED_AT_DEPLOY,
  MIGRATE_ENTRYPOINT,
  MIGRATE_JOB,
  READY_PATH,
  READY_PROBE,
  RESERVED_ENV,
  STATE_MIGRATION_STEP,
  STATE_MOUNT_PATH,
  STATE_VOLUME,
} from './deployment.js';

/**
 * `generateTopology` and `generateMigrations` (`docs/runtime-adapter.md` §8, §12.2).
 *
 * The generator owns the runtime app, its state volume and its state migration.
 * context-service, the graph and audit volumes and the ingest job are the
 * platform's fragment (#32); this file must not name them as owned components —
 * `dependsOn` is the one place the runtime is allowed to *reference* them.
 *
 * Nothing here reads a clock, an environment value or the disk: the shape is a
 * pure function of the pinned build input, like the app tree it accompanies (A11).
 */

/** The non-secret configuration the app receives. Sorted, so two builds produce the same bytes. */
function appEnvironment(input: RuntimeGenerateInput): Array<{ name: string; value: string }> {
  const byName = (left: { name: string }, right: { name: string }): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0;

  const declared = Object.entries(input.environment.values ?? {})
    .map(([name, value]) => ({ name, value }))
    .sort(byName);

  for (const { name } of declared) {
    if (Object.hasOwn(RESERVED_ENV, name)) {
      throw new Error(
        `Environment ${input.environment.name} declares ${name}, which the generated app owns: the state store path and NODE_ENV are derived from the topology, not configured`,
      );
    }
    if (INJECTED_AT_DEPLOY.includes(name)) {
      throw new Error(
        `Environment ${input.environment.name} declares ${name} in values, but the identity settings are injected at deploy time (§5.4), not rendered into the topology: FDE_SIGNING_KEY/FDE_IDENTITY_CONFIG_JSON would write the key or the subjects into a signed artifact`,
      );
    }
  }

  const owned = Object.entries(RESERVED_ENV).map(([name, value]) => ({ name, value }));

  return [...declared, ...owned].sort(byName);
}

/**
 * The runtime-owned fragment of `BundleTopology` (§8.2).
 *
 * `metadata` carries the Profile's content address, not just its name, so the
 * renderer can prove the topology it renders belongs to the Profile the lock
 * pinned. `dependsOn: [context-service]` is a forward reference on purpose: the
 * platform composes the component that satisfies it, and the composed bundle is
 * where reference integrity is checked (§8.3).
 */
export function generateTopology(input: RuntimeGenerateInput): RuntimeTopology {
  return {
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
          name: APP_DIR,
          role: 'runtime-app',
          image: { build: { context: APP_DIR, dockerfile: 'Dockerfile' } },
          ports: [{ name: 'http', containerPort: APP_PORT, expose: true }],
          volumes: [{ name: STATE_VOLUME, mountPath: STATE_MOUNT_PATH }],
          env: appEnvironment(input),
          healthCheck: { path: READY_PATH, port: APP_PORT, command: [...READY_PROBE] },
          dependsOn: [CONTEXT_SERVICE_COMPONENT],
          resources: { cpu: '1', memory: '1Gi' },
        },
      ],
      volumes: [
        {
          name: STATE_VOLUME,
          backup: true,
          description:
            'Runtime state store (libsql/SQLite): the Run registry, its SSE event log and the idempotency index. Never graph or audit.',
        },
      ],
      jobs: [
        {
          name: MIGRATE_JOB,
          owner: 'runtime',
          steps: [
            {
              id: STATE_MIGRATION_STEP,
              command: [...MIGRATE_ENTRYPOINT],
              runBefore: [APP_DIR],
            },
          ],
          volumes: [{ name: STATE_VOLUME, mountPath: STATE_MOUNT_PATH }],
          // The job and the app must open the same file; the app's own env is the
          // single source of that path (RESERVED_ENV), not a second literal here.
          env: [{ name: 'FDE_STATE_STORE_PATH', value: RESERVED_ENV.FDE_STATE_STORE_PATH }],
        },
      ],
      startupOrder: [MIGRATE_JOB, APP_DIR],
      secretBindings: [],
      deploymentNaming: {
        componentNameTemplate: 'fde-{{deployment_id}}-{{component}}',
        namespaceTemplate: 'fde-{{deployment_id}}',
      },
    },
  };
}

/**
 * The runtime-owned migration plan (§4.2): one forward-only step, run by the
 * `runtime-migrate` job. context-service's graph/audit migrations are the
 * platform's; a generator that emitted them would own a schema it does not use.
 *
 * `schemaVersion` is the Profile's, and `validate` has already refused a build
 * whose Environment selects a different one — so a migration that runs against a
 * store it was not written for is a build failure, not a startup surprise.
 */
export function generateMigrations(input: RuntimeGenerateInput): RuntimeMigrationPlan {
  return {
    steps: [
      {
        id: STATE_MIGRATION_STEP,
        owner: 'runtime',
        phase: 'runtime-state',
        reversible: false,
        command: [...MIGRATE_ENTRYPOINT],
        dependsOn: [],
        schemaVersion: input.profile.spec.capabilities.stateStore.schemaVersion,
      },
    ],
  };
}
