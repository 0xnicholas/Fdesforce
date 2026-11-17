import { z } from 'zod';

import { canonicalJson } from '../canonical.js';
import { DigestSchema, NameSchema, SemverSchema } from './common.js';
import { ProfileRefSchema } from './runtime-profile.js';

/**
 * `RuntimeTopology` (generator-owned fragment) and `BundleTopology` (the single
 * composed deployment-topology source rendered to Compose, Helm and the airgap
 * bundle). Mirrors `contracts/schemas/bundle-topology.schema.json`.
 *
 * Presence-exclusive objects (`EnvVar`, `ImageSpec`) are flat shapes plus a
 * refinement instead of a union, because the contract expresses "exactly one of"
 * as `oneOf` over `required` and nothing else. `contract-drift.test.ts` strips
 * the `oneOf` node and proves the exclusivity with the differential corpus.
 */

export const ComponentRoleSchema = z.enum([
  'runtime-app',
  'context-service',
  'state-store',
  'graph-store',
  'audit-store',
  'job',
  'collector',
]);

const unique = (items: unknown[]): boolean =>
  new Set(items.map((item) => canonicalJson(item))).size === items.length;

const PortSchema = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/),
  containerPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).optional(),
  expose: z.boolean().optional(),
});

const VolumeMountSchema = z.strictObject({
  name: NameSchema,
  mountPath: z.string().regex(new RegExp('^/[A-Za-z0-9._/-]{1,200}$')),
  readOnly: z.boolean().optional(),
});

export const SecretRefSchema = z.strictObject({
  store: z.string().min(1).max(100),
  key: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
});

const EnvVarSchema = z
  .strictObject({
    name: z.string().regex(/^[A-Z_][A-Z0-9_]{0,100}$/),
    value: z.string().max(2000).optional(),
    secretRef: SecretRefSchema.optional(),
  })
  .refine((env) => (env.value === undefined) !== (env.secretRef === undefined), {
    message: 'an env var carries exactly one of value or secretRef',
  });

const HealthCheckSchema = z.strictObject({
  path: z.string().regex(new RegExp('^/[A-Za-z0-9._/-]{0,200}$')),
  port: z.number().int().min(1).max(65535),
  /**
   * Exec form of the probe, for renderers whose health gate runs a command in the
   * container (Compose's `test`). `path` + `port` stay the portable statement — a
   * renderer with native HTTP probes (Helm) uses those and ignores this.
   */
  command: z.array(z.string().min(1)).min(1).optional(),
  initialDelaySeconds: z.number().int().min(0).optional(),
  periodSeconds: z.number().int().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  failureThreshold: z.number().int().min(1).optional(),
});

const ResourceSpecSchema = z.strictObject({
  cpu: z.string().regex(/^[0-9]+(\.[0-9]+)?$/),
  memory: z.string().regex(/^[0-9]+(Mi|Gi)$/),
});

const ImageSpecSchema = z
  .strictObject({
    image: z.string().min(1).max(500).optional(),
    build: z
      .strictObject({
        context: z.string().min(1).max(500),
        dockerfile: z.string().min(1).max(500),
        target: z.string().min(1).max(100).optional(),
      })
      .optional(),
  })
  .refine((spec) => (spec.image === undefined) !== (spec.build === undefined), {
    message: 'a component image is exactly one of a pinned image or a build context',
  });

export const ComponentSchema = z.strictObject({
  name: NameSchema,
  role: ComponentRoleSchema,
  image: ImageSpecSchema,
  command: z.array(z.string().min(1)).min(1).optional(),
  args: z.array(z.string()).optional(),
  ports: z.array(PortSchema).refine(unique, { message: 'ports must be unique' }).optional(),
  volumes: z.array(VolumeMountSchema).refine(unique, { message: 'volume mounts must be unique' }).optional(),
  env: z.array(EnvVarSchema).refine(unique, { message: 'env entries must be unique' }).optional(),
  secretRefs: z.array(SecretRefSchema).refine(unique, { message: 'secret refs must be unique' }).optional(),
  healthCheck: HealthCheckSchema.optional(),
  dependsOn: z.array(NameSchema).refine(unique, { message: 'dependsOn must be unique' }).optional(),
  resources: ResourceSpecSchema.optional(),
});

export const VolumeSchema = z.strictObject({
  name: NameSchema,
  size: z.string().regex(/^[0-9]+(Mi|Gi)$/).optional(),
  backup: z.boolean().optional(),
  description: z.string().max(300).optional(),
});

const JobStepSchema = z.strictObject({
  id: NameSchema,
  command: z.array(z.string().min(1)).min(1),
  args: z.array(z.string()).optional(),
  runBefore: z.array(NameSchema).refine(unique, { message: 'runBefore must be unique' }).optional(),
  runAfter: z.array(NameSchema).refine(unique, { message: 'runAfter must be unique' }).optional(),
  timeoutSeconds: z.number().int().min(1).optional(),
  volumes: z.array(VolumeMountSchema).refine(unique, { message: 'volume mounts must be unique' }).optional(),
  secretRefs: z.array(SecretRefSchema).refine(unique, { message: 'secret refs must be unique' }).optional(),
});

export const JobSchema = z.strictObject({
  name: NameSchema,
  owner: z.enum(['context-service', 'runtime', 'platform']),
  steps: z.array(JobStepSchema).min(1),
  volumes: z.array(VolumeMountSchema).refine(unique, { message: 'volume mounts must be unique' }).optional(),
  /** Non-secret configuration the job reads; same presence-exclusive shape as a component's. */
  env: z.array(EnvVarSchema).refine(unique, { message: 'env entries must be unique' }).optional(),
  secretRefs: z.array(SecretRefSchema).refine(unique, { message: 'secret refs must be unique' }).optional(),
});

export const SecretBindingSchema = z.strictObject({
  secretRef: SecretRefSchema,
  target: z.enum(['env', 'file']),
  name: z.string().regex(new RegExp('^([A-Za-z_][A-Za-z0-9_.-]{0,100}|/[A-Za-z0-9._/-]{1,200})$')),
  required: z.boolean().optional(),
});

export const DeploymentNamingSchema = z.strictObject({
  componentNameTemplate: z.string().min(1).max(200).regex(/.*\{\{component\}\}.*/),
  namespaceTemplate: z.string().min(1).max(200).optional(),
});

export const NetworkSchema = z.strictObject({
  name: NameSchema,
  internal: z.boolean(),
});

const IngressSchema = z.strictObject({
  component: NameSchema,
  port: z.number().int().min(1).max(65535),
  hostTemplate: z.string().min(1).max(200).optional(),
  tls: z.boolean().optional(),
});

export const StartupOrderSchema = z.array(NameSchema).min(1).refine(unique, {
  message: 'startup order must name each component once',
});

const runtimeTopologySpecShape = {
  components: z.array(ComponentSchema).min(1),
  volumes: z.array(VolumeSchema).refine(unique, { message: 'volumes must be unique' }),
  jobs: z.array(JobSchema),
  startupOrder: StartupOrderSchema,
  secretBindings: z.array(SecretBindingSchema),
  deploymentNaming: DeploymentNamingSchema,
};

export const RuntimeTopologySpecSchema = z.strictObject(runtimeTopologySpecShape);

export const BundleTopologySpecSchema = z.strictObject({
  ...runtimeTopologySpecShape,
  networks: z.array(NetworkSchema).min(1),
  ingress: IngressSchema.optional(),
});

export const RuntimeTopologySchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('RuntimeTopology'),
  metadata: z.strictObject({
    profile: ProfileRefSchema,
    profileDigest: DigestSchema,
    generatorVersion: SemverSchema,
  }),
  spec: RuntimeTopologySpecSchema,
});

export const BundleTopologySchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('BundleTopology'),
  metadata: z.strictObject({
    solution: NameSchema,
    revision: z.number().int().min(1),
    profile: ProfileRefSchema,
    profileDigest: DigestSchema,
  }),
  spec: BundleTopologySpecSchema,
});

/** Either topology document; the `kind` discriminates. */
export const TopologySchema = z.union([RuntimeTopologySchema, BundleTopologySchema]);

/**
 * `ContextServiceTopology` — the platform's half of a bundle (§8.1).
 *
 * It is the counterpart of the generator's `RuntimeTopology`: components, volumes,
 * jobs, secret bindings and networks that the platform owns (context-service, the
 * graph and audit volumes, the migrate and ingest jobs), and nothing that belongs
 * to the composed bundle. `startupOrder`, `deploymentNaming` and `ingress` are
 * deliberately absent — the compose step decides those once, for the whole bundle,
 * so a fragment cannot ship a second opinion about the order.
 */
export const ContextServiceTopologySpecSchema = z.strictObject({
  components: z.array(ComponentSchema).min(1),
  volumes: z.array(VolumeSchema).refine(unique, { message: 'volumes must be unique' }),
  jobs: z.array(JobSchema),
  secretBindings: z.array(SecretBindingSchema),
  networks: z.array(NetworkSchema).min(1),
});

export const ContextServiceTopologySchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('ContextServiceTopology'),
  metadata: z.strictObject({
    name: NameSchema,
    version: SemverSchema,
    description: z.string().max(300).optional(),
  }),
  spec: ContextServiceTopologySpecSchema,
});

export type Component = z.infer<typeof ComponentSchema>;
export type Volume = z.infer<typeof VolumeSchema>;
export type Job = z.infer<typeof JobSchema>;
export type EnvVar = z.infer<typeof EnvVarSchema>;
export type SecretBinding = z.infer<typeof SecretBindingSchema>;
export type RuntimeTopology = z.infer<typeof RuntimeTopologySchema>;
export type BundleTopology = z.infer<typeof BundleTopologySchema>;
export type ContextServiceTopology = z.infer<typeof ContextServiceTopologySchema>;
export type ContextServiceTopologySpec = z.infer<typeof ContextServiceTopologySpecSchema>;
export type Topology = z.infer<typeof TopologySchema>;
export type BundleTopologySpec = z.infer<typeof BundleTopologySpecSchema>;
