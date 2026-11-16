/**
 * The deployment shape the generated app and the topology fragment must agree on.
 *
 * These constants are the join between two artifacts the build emits separately
 * (`generateApp` and `generateTopology`): the port the app listens on, the volume
 * it persists to, the file inside that volume, and the command that migrates it
 * before the app starts. A value that appears in one artifact and is re-typed in
 * the other is a deployment that comes up and then cannot serve.
 */

/** Container port the runtime app listens on. The ingress mapping is the renderer's (#32). */
export const APP_PORT = 4111;

/** Bundle-relative directory of the generated tree; also the image build context. */
export const APP_DIR = 'mastra-app';

/** The runtime state store volume and where it is mounted inside the app. */
export const STATE_VOLUME = 'mastra-state';
export const STATE_MOUNT_PATH = '/app/state';
export const STATE_DB_PATH = `${STATE_MOUNT_PATH}/mastra.db`;

/** The job that migrates the state store before the app starts (contract §9.2). */
export const MIGRATE_JOB = 'runtime-migrate';
export const STATE_MIGRATION_STEP = 'runtime-state';
export const MIGRATE_ENTRYPOINT: ReadonlyArray<string> = ['node', '--experimental-strip-types', 'src/migrate.ts'];

/** The platform-owned component the runtime app depends on. Composed by the platform (#32). */
export const CONTEXT_SERVICE_COMPONENT = 'context-service';

/** Liveness probe: the process is alive. `/readyz` (readiness + handshake) is #30. */
export const PROBE_PATH = '/healthz';

/**
 * Environment variables the generated app owns, with the values the topology sets.
 * One table, so the guard against an Environment redefining one of them and the
 * `env` entries the topology emits cannot disagree.
 */
export const RESERVED_ENV = {
  FDE_STATE_STORE_PATH: STATE_DB_PATH,
  NODE_ENV: 'production',
} as const;
