import { z } from 'zod';

import { SchemaVersionSchema } from './common.js';

/**
 * `RuntimeCapabilities` — what the *generated* runtime app can do (runtime
 * primitive + generator adapter), not what the raw runtime library can do.
 *
 * Mirrors `contracts/schemas/runtime-capabilities.schema.json`. Group `support`
 * is the worst case of its members; this module enforces only what the contract
 * enforces (degraded requires limitations). Cross-field consistency between a
 * group and its members is `RuntimeGenerator.validate()` work (#26).
 */

export const SupportSchema = z.enum(['native', 'adapter', 'degraded', 'none']);
export const EvalHooksSchema = z.enum(['native', 'external', 'none']);
export const StateStoreKindSchema = z.enum(['sqlite', 'libsql', 'postgres']);
export const DurabilityModeSchema = z.enum(['sync', 'async', 'exit']);
export const ExtensionArtifactKindSchema = z.enum(['ts-package', 'python-wheel', 'http']);
export const TopologyModeSchema = z.enum(['split', 'merged-container', 'agent-server']);

/**
 * The contract's own enumeration order, exported so a normalizer can canonicalize
 * a declaration without keeping a second copy of the order. `capabilities()`
 * sorts by these (see `@fde/runtime-generator`), which is why they are data, not
 * an implementation detail of the Zod schema.
 */
export const SUPPORT_LEVELS = SupportSchema.options;
export const STATE_STORE_KINDS = StateStoreKindSchema.options;
export const DURABILITY_MODES = DurabilityModeSchema.options;
export const EXTENSION_ARTIFACT_KINDS = ExtensionArtifactKindSchema.options;
export const TOPOLOGY_MODES = TopologyModeSchema.options;

export const LimitationsSchema = z
  .array(z.string().min(1).max(300))
  .max(10)
  .refine((items) => new Set(items).size === items.length, {
    message: 'limitations must be unique',
  });

/** A `degraded` group must say what is lost; the contract's `if/then` rule. */
function degradedRequiresLimitations(value: unknown, ctx: z.RefinementCtx): void {
  const node = value as { support?: string; limitations?: string[] };
  if (node.support !== 'degraded') return;
  if (node.limitations && node.limitations.length > 0) return;
  ctx.addIssue({
    code: 'custom',
    path: ['limitations'],
    message: 'group support is degraded, so limitations must list what is lost',
  });
}

const group = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape).superRefine(degradedRequiresLimitations);

export const CapabilityNodeSchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
});

export const DurableWorkflowCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  durabilityModes: z.array(DurabilityModeSchema).min(1),
  autoResume: SupportSchema,
});

export const HitlCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  interrupt: SupportSchema,
  resume: SupportSchema,
  approvalResource: SupportSchema,
  expiry: SupportSchema,
  multipleInterrupts: SupportSchema,
  consume: SupportSchema,
});

export const StreamingCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  tokenStream: SupportSchema,
  toolEvents: SupportSchema,
  interruptEvents: SupportSchema,
  transport: SupportSchema,
});

export const ObservabilityCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  otel: SupportSchema,
  evalHooks: EvalHooksSchema,
});

export const MemoryCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  thread: SupportSchema,
  longTerm: SupportSchema,
  ttl: SupportSchema,
});

export const ToolsCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  native: SupportSchema,
  mcp: SupportSchema,
  connectorOperations: SupportSchema,
});

export const ExtensionsCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  artifactKinds: z.array(ExtensionArtifactKindSchema).min(1),
});

export const StateStoreCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  kinds: z.array(StateStoreKindSchema).min(1),
  schemaVersion: SchemaVersionSchema,
  encryption: SupportSchema,
  retention: SupportSchema,
});

export const TopologyCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
  modes: z.array(TopologyModeSchema).min(1),
  singleWriter: z.boolean(),
});

export const OfflineCapabilitySchema = group({
  support: SupportSchema,
  limitations: LimitationsSchema.optional(),
});

export const RuntimeCapabilitiesSchema = z.strictObject({
  durableWorkflow: DurableWorkflowCapabilitySchema,
  hitl: HitlCapabilitySchema,
  streaming: StreamingCapabilitySchema,
  observability: ObservabilityCapabilitySchema,
  memory: MemoryCapabilitySchema,
  tools: ToolsCapabilitySchema,
  extensions: ExtensionsCapabilitySchema,
  stateStore: StateStoreCapabilitySchema,
  topology: TopologyCapabilitySchema,
  offline: OfflineCapabilitySchema,
});

/** Flat `capability.path` → node map used by the `runtime-info` handshake. */
export const CapabilityDetailsSchema = z
  .record(
    z
      .string()
      .regex(/^(durableWorkflow|hitl|streaming|observability|memory|tools|extensions|stateStore|topology|offline)(\.[a-zA-Z][a-zA-Z0-9]*)?$/),
    CapabilityNodeSchema,
  )
  .refine((details) => Object.keys(details).length > 0, {
    message: 'capability_details must report at least one capability path',
  });

export type Support = z.infer<typeof SupportSchema>;
export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
export type CapabilityDetails = z.infer<typeof CapabilityDetailsSchema>;
export const CAPABILITY_GROUPS = [
  'durableWorkflow',
  'hitl',
  'streaming',
  'observability',
  'memory',
  'tools',
  'extensions',
  'stateStore',
  'topology',
  'offline',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];
