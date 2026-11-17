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
 * The environment variables the deployment injects for identity (#29). Named here
 * because two artifacts have to agree on them: the emitted `runtime/config.ts` reads
 * them, and the emitter's documentation and the A8 case describe them. A wrong name
 * in either place is a deployment that boots and then refuses every Run.
 */
export const IDENTITY_ENV = {
  /** `fde://<deployment_id>` is the `iss`; the contract schema pins `dep_<ulid>`. */
  deploymentId: 'FDE_DEPLOYMENT_ID',
  /** Path to the mounted static identity profile. */
  configPath: 'FDE_IDENTITY_CONFIG',
  /** The same profile inline, for a run with no mount. */
  configJson: 'FDE_IDENTITY_CONFIG_JSON',
  /** The `mastra-app` issuer key, PKCS#8 PEM, ES256. */
  signingKeyPem: 'FDE_SIGNING_KEY',
  /** A mounted PEM; wins over the inline key. */
  signingKeyFile: 'FDE_SIGNING_KEY_FILE',
} as const;

/**
 * Identity settings that must reach the app by injection, never through
 * `Environment.values`: `runtime/topology.ts` refuses a build that puts one there.
 *
 * The reason is §5.4 and the reason for §5.4: an `Environment.values` entry is
 * rendered into the topology artifact, which is signed and shipped — so a private
 * key there would be a key in the Bundle, and a subject list there would be deploy
 * data in a build artifact. It is also the setting `FDE_DEPLOYMENT_ID`, which the
 * renderer derives from the deployment rather than an author choosing one.
 */
export const INJECTED_AT_DEPLOY: ReadonlyArray<string> = [
  IDENTITY_ENV.deploymentId,
  IDENTITY_ENV.configPath,
  IDENTITY_ENV.configJson,
  IDENTITY_ENV.signingKeyPem,
  IDENTITY_ENV.signingKeyFile,
];

/**
 * Environment variables the generated app owns, with the values the topology sets.
 * One table, so the guard against an Environment redefining one of them and the
 * `env` entries the topology emits cannot disagree.
 */
export const RESERVED_ENV = {
  FDE_STATE_STORE_PATH: STATE_DB_PATH,
  NODE_ENV: 'production',
} as const;
