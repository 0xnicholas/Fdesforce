import { z } from 'zod';

import {
  ArtifactRefSchema,
  ClassificationSchema,
  NameSchema,
  RetentionClassSchema,
  SpecFilePathSchema,
} from './common.js';
import { PLATFORM_ROLES } from './platform-roles.js';

/**
 * `SolutionSpec` — the declarative authoring surface of a Solution Revision.
 * It contains author intent only: no generated artifacts, no secrets, no
 * environment values.
 *
 * Grammar is deliberately narrow (v0, `docs/domain-model.md` §3.6):
 * ordered `context | agent | tool | approval` steps, no branch/parallel, and
 * conditions only as a named Policy predicate on `approval.requiredWhen`.
 * Cross-document rules (does a referenced workflow exist? does the gate cover a
 * side-effecting tool?) live in `checkSolution()`, not here.
 */

export const BusinessRoleSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,62}$/)
  .refine((role) => !(PLATFORM_ROLES as readonly string[]).includes(role), {
    message: 'business roles may not reuse a platform role name',
  });

/** `output.citedSources`, `entities[0].id` — a restricted dot path, not JSON Pointer. */
export const DotPathSchema = z.string().regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+|\[[0-9]+\]|\[\*\])*$/);

/** ISO-8601 duration with at least one component (`PT5M`, `PT24H`, `P1DT2H`). */
export const DurationSchema = z.string().regex(/^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+S)?)?$/).refine(
  (duration) => !/^P(T?)$/.test(duration),
  { message: 'duration must have at least one component' },
);

const StepRefSchema = z.strictObject({
  step: NameSchema,
  path: DotPathSchema,
});

const PolicyArgValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  StepRefSchema,
  z.array(z.union([z.string(), z.number(), z.boolean()])),
]);

/** `pii-redaction@^1.0.0` or a parameterised binding. */
export const PolicyRefSchema = z.union([
  ArtifactRefSchema,
  z.strictObject({
    ref: ArtifactRefSchema,
    appliesTo: z.array(NameSchema).min(1).optional(),
    args: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), PolicyArgValueSchema).optional(),
  }),
]);

/**
 * Evidence selector (`docs/decision-audit-binding.md` §4.2). `from: input` is the
 * explicit "this action has no external evidence" escape hatch; an empty
 * selector list is a build error, not a runtime degradation.
 */
export const EvidenceSelectorSchema = z.discriminatedUnion('from', [
  z.strictObject({ from: z.literal('retrieval'), recipe: z.string().optional() }),
  z.strictObject({
    from: z.literal('step'),
    step: NameSchema,
    path: DotPathSchema,
    as: z.enum(['artifact', 'citations']).optional(),
  }),
  z.strictObject({ from: z.literal('input') }),
]);

export const CapabilityAuditSchema = z.strictObject({
  /** Keyed by side-effecting Tool id; each list must be non-empty. */
  evidence: z.record(NameSchema, z.array(EvidenceSelectorSchema).min(1)).optional(),
  runOutcomeDecision: z.enum(['required', 'omitted']).optional(),
});

export const CapabilityBudgetSchema = z.strictObject({
  maxToolCallsPerRun: z.number().int().min(1).optional(),
  maxSteps: z.number().int().min(1).optional(),
});

export const CapabilityBindingSchema = z.strictObject({
  template: ArtifactRefSchema,
  implementation: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('agent'), ref: NameSchema }),
    z.strictObject({ type: z.literal('workflow'), ref: NameSchema }),
  ]),
  policyRefs: z.array(PolicyRefSchema).optional(),
  evalRefs: z.array(ArtifactRefSchema).optional(),
  budget: CapabilityBudgetSchema.optional(),
  audit: CapabilityAuditSchema.optional(),
  overlayRefs: z.array(ArtifactRefSchema).optional(),
  extensionRefs: z.array(ArtifactRefSchema).optional(),
});

const ThreadMemorySchema = z.strictObject({
  lastMessages: z.number().int().min(1).max(100).default(20),
});

const LongTermMemorySchema = z
  .strictObject({
    write: z.literal('explicit'),
    recall: z.enum(['semantic', 'none']).default('none'),
    scope: z.enum(['end_user', 'agent']).default('end_user'),
    embeddingProfile: ArtifactRefSchema.optional(),
  })
  .superRefine((memory, ctx) => {
    if (memory.recall === 'semantic' && memory.embeddingProfile === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['embeddingProfile'],
        message: 'recall: semantic requires an embeddingProfile pinned by solution.lock',
      });
    }
    if (memory.recall === 'none' && memory.embeddingProfile !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['embeddingProfile'],
        message: 'embeddingProfile is only meaningful with recall: semantic',
      });
    }
  });

export const AgentMemorySchema = z.strictObject({
  thread: ThreadMemorySchema.optional(),
  longTerm: LongTermMemorySchema.optional(),
  retentionClass: RetentionClassSchema.optional(),
});

export const AgentSchema = z.strictObject({
  modelProfile: ArtifactRefSchema,
  instructions: SpecFilePathSchema.optional(),
  tools: z.array(NameSchema).optional(),
  policyRefs: z.array(PolicyRefSchema).optional(),
  memory: AgentMemorySchema.optional(),
});

const ContextStepSchema = z.strictObject({
  id: NameSchema,
  type: z.literal('context'),
  recipe: z.string().min(1),
  outputSchema: SpecFilePathSchema.optional(),
});

const AgentStepSchema = z.strictObject({
  id: NameSchema,
  type: z.literal('agent'),
  agent: NameSchema,
  outputSchema: SpecFilePathSchema.optional(),
});

const ToolStepSchema = z.strictObject({
  id: NameSchema,
  type: z.literal('tool'),
  tool: NameSchema,
  outputSchema: SpecFilePathSchema.optional(),
});

const ApprovalStepSchema = z.strictObject({
  id: NameSchema,
  type: z.literal('approval'),
  /** The immediately following step this gate blocks. */
  gates: NameSchema,
  requiredWhen: z
    .strictObject({
      predicate: ArtifactRefSchema,
      args: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.unknown()).optional(),
    })
    .optional(),
  approverRoles: z
    .array(BusinessRoleSchema)
    .min(1)
    .refine((roles) => new Set(roles).size === roles.length, { message: 'approver roles must be unique' }),
  expiresAfter: DurationSchema,
  evidenceFrom: z.array(NameSchema).min(1),
  summaryFrom: StepRefSchema.optional(),
});

export const WorkflowStepSchema = z.discriminatedUnion('type', [
  ContextStepSchema,
  AgentStepSchema,
  ToolStepSchema,
  ApprovalStepSchema,
]);

export const WorkflowSchema = z.strictObject({
  durable: z.boolean().optional(),
  timeout: DurationSchema.optional(),
  steps: z.array(WorkflowStepSchema).min(1),
  policyRefs: z.array(PolicyRefSchema).optional(),
});

const ToolAuditSchema = z.strictObject({
  classification: ClassificationSchema,
  retentionClass: RetentionClassSchema,
  digests: z
    .strictObject({
      input: z.literal('jcs-sha256'),
      output: z.literal('jcs-sha256'),
    })
    .optional(),
});

export const ToolSchema = z
  .strictObject({
    connectorRef: NameSchema.optional(),
    operation: z.string().regex(/^[a-z][A-Za-z0-9_]{0,63}$/).optional(),
    /**
     * Prototype-only field (`prototype/11-solution-spec/GAPS.md` GAP-1): built-in
     * tools are platform-provided, but v0 has no documented discriminator yet.
     * `checkSolution()` warns instead of failing so the sample Spec still loads.
     */
    builtin: z.string().min(1).max(100).optional(),
    sideEffects: z.enum(['read', 'write', 'external']),
    inputSchema: SpecFilePathSchema.optional(),
    outputSchema: SpecFilePathSchema.optional(),
    audit: ToolAuditSchema.optional(),
    rateLimit: z
      .strictObject({
        perRunMax: z.number().int().min(1),
        perActorPerHourMax: z.number().int().min(1),
      })
      .optional(),
  })
  .superRefine((tool, ctx) => {
    if (tool.connectorRef !== undefined && tool.operation === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'a connector-backed tool must name its typed operation',
      });
    }
    if (tool.connectorRef === undefined && tool.operation !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['operation'],
        message: 'operation is only valid with connectorRef',
      });
    }
  });

const RecipeBindingSchema = z.strictObject({
  recipeRef: ArtifactRefSchema,
  budget: z
    .strictObject({
      maxNodes: z.number().int().min(1).optional(),
      maxTokens: z.number().int().min(1).optional(),
      maxHops: z.number().int().min(0).max(5).optional(),
    })
    .optional(),
});

export const SemanticSchema = z.strictObject({
  contextPackageRef: ArtifactRefSchema,
  recipeBindings: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,62}$/), RecipeBindingSchema),
});

export const GovernanceSchema = z.strictObject({
  policies: z.array(ArtifactRefSchema).optional(),
  evalSuites: z.array(ArtifactRefSchema).optional(),
});

export const EnvironmentRequirementSchema = z.strictObject({
  kind: z.enum(['dev', 'staging', 'prod']),
  region: z.string().min(1).max(100).optional(),
  capacityClass: z.string().min(1).max(50).optional(),
  networkClass: z.string().min(1).max(50).optional(),
  secretStoreKind: z.string().min(1).max(50).optional(),
});

export const BuildSchema = z
  .strictObject({
    runtimeProfile: ArtifactRefSchema,
    platform: z.enum(['compose', 'helm']).optional(),
    delivery: z.enum(['registry', 'offline-bundle']).optional(),
    /** Only promotes derived `should` requirements to `must`; never the reverse. */
    requirements: z
      .strictObject({
        observability: z.strictObject({ otel: z.literal('required') }).optional(),
        offline: z.boolean().optional(),
      })
      .optional(),
    /**
     * Legacy pre-#17 target list. Superseded by `platform` + `delivery`;
     * `checkSolution()` warns when it is present.
     */
    targets: z.array(z.enum(['compose', 'helm', 'airgap'])).min(1).optional(),
  })
  .superRefine((build, ctx) => {
    if (build.targets !== undefined && (build.platform !== undefined || build.delivery !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'build.targets is superseded by build.platform/build.delivery; use one or the other',
      });
    }
  });

export const DeploymentDefaultsSchema = z.strictObject({
  profile: NameSchema.optional(),
  migrationPolicy: z.string().min(1).max(50).optional(),
});

export const SolutionSpecSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('SolutionSpec'),
  metadata: z.strictObject({
    customer: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    solution: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    name: z.string().min(1).max(200).optional(),
  }),
  spec: z.strictObject({
    overlays: z.array(ArtifactRefSchema).optional(),
    capabilities: z.record(NameSchema, CapabilityBindingSchema),
    agents: z.record(NameSchema, AgentSchema).optional(),
    workflows: z.record(NameSchema, WorkflowSchema).optional(),
    tools: z.record(NameSchema, ToolSchema).optional(),
    semantic: SemanticSchema.optional(),
    governance: GovernanceSchema.optional(),
    environments: z.record(NameSchema, EnvironmentRequirementSchema).optional(),
    extensions: z.array(ArtifactRefSchema).optional(),
    build: BuildSchema,
    deployment: DeploymentDefaultsSchema.optional(),
  }),
});

export type SolutionSpec = z.infer<typeof SolutionSpecSchema>;
export type CapabilityBinding = z.infer<typeof CapabilityBindingSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type Workflow = z.infer<typeof WorkflowSchema>;
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type EvidenceSelector = z.infer<typeof EvidenceSelectorSchema>;
export type PolicyRef = z.infer<typeof PolicyRefSchema>;
export type Semantic = z.infer<typeof SemanticSchema>;
export type BuildSpec = z.infer<typeof BuildSchema>;
