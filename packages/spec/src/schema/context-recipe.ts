import { z } from 'zod';

import { ArtifactRefSchema, NameSchema, PackageFilePathSchema, SemverSchema, TermNameSchema, TenantIdSchema } from './common.js';

/**
 * `recipes/*.yaml` — a deterministic retrieval plan (`docs/semantic-modeling.md` §6).
 *
 * The FDE writes the recipe; a Solution binds it and may only tighten it; the
 * model picks `recipe_id` and fills query/filters. It never generates a query and
 * never reorders the stages — which is why the stage list is a closed union here
 * and why `checkContextPackage` enforces the canonical order rather than trusting
 * document order to mean something.
 *
 * `mask` and `budget` are mandatory and come last: they are the two stages that
 * cannot be skipped without either leaking data or blowing the prompt. The schema
 * fixes each stage's own fields; the order and the mandatory pair are the check's.
 */
export const RecipeInputSchemaSchema = z.strictObject({
  type: z.literal('object'),
  required: z.array(z.string().min(1).max(100)).optional(),
  /** Property name → JSON Schema fragment. Only the property names are checked. */
  properties: z.record(z.string().min(1).max(100), z.record(z.string(), z.unknown())).optional(),
  additionalProperties: z.boolean().optional(),
});

export const ResolveStageSchema = z.strictObject({
  type: z.literal('resolve'),
  /** The business object the query is about (`ic:Claim`). */
  entity: TermNameSchema,
  /** The input property carrying the stable key (`claim_id`). */
  key: z.string().min(1).max(100),
});

export const StructuredStageSchema = z.strictObject({
  type: z.literal('structured'),
  /** A Context Source id declared by the Semantic Model. */
  source: NameSchema,
  entities: z.array(TermNameSchema).min(1),
});

export const GraphStageSchema = z.strictObject({
  type: z.literal('graph'),
  /** v0 expands from the resolved entity set only; there is no other anchor. */
  from: z.literal('resolved'),
  relations: z.array(TermNameSchema).min(1),
  /** The v0 graph is 1–2 hops (`docs/runtime-contract.md` §4.3). */
  maxHops: z.number().int().min(1).max(2),
});

export const LexicalStageSchema = z.strictObject({
  type: z.literal('lexical'),
  source: NameSchema,
  /** `$query` interpolates the run's query; a literal is a fixed search. */
  query: z.string().min(1).max(500),
  topK: z.number().int().min(1).max(200),
});

export const MergeStageSchema = z.strictObject({
  type: z.literal('merge'),
  dedupe: z.array(z.enum(['entity_id', 'content_hash'])).min(1),
});

export const RankStageSchema = z.strictObject({
  type: z.literal('rank'),
  weights: z.strictObject({
    structured: z.number().min(0).max(1).optional(),
    graph: z.number().min(0).max(1).optional(),
    lexical: z.number().min(0).max(1).optional(),
    /** Experimental in v0; declaring a weight is not a promise the stage runs. */
    vector: z.number().min(0).max(1).optional(),
  }),
  freshnessBoost: z.number().min(0).max(1).optional(),
});

export const MaskStageSchema = z.strictObject({
  type: z.literal('mask'),
  /** Must be the package's `spec.permissionsRef`; a recipe cannot substitute a laxer baseline. */
  permissions: PackageFilePathSchema,
});

export const BudgetStageSchema = z.strictObject({
  type: z.literal('budget'),
  maxNodes: z.number().int().min(1),
  maxTokens: z.number().int().min(1),
  maxHops: z.number().int().min(1).max(2),
});

export const RecipeStageSchema = z.discriminatedUnion('type', [
  ResolveStageSchema,
  StructuredStageSchema,
  GraphStageSchema,
  LexicalStageSchema,
  MergeStageSchema,
  RankStageSchema,
  MaskStageSchema,
  BudgetStageSchema,
]);

/** The canonical pipeline order (§6.3). A stage sequence is a subsequence of it. */
export const RECIPE_STAGE_ORDER = [
  'resolve',
  'structured',
  'graph',
  'lexical',
  'merge',
  'rank',
  'mask',
  'budget',
] as const;

export const ContextRecipeSpecSchema = z.strictObject({
  /** `acme-claims@1.0.0` — the Semantic Model version this recipe was written against. */
  semanticModelRef: ArtifactRefSchema,
  inputSchema: RecipeInputSchemaSchema,
  stages: z.array(RecipeStageSchema).min(1),
  output: z.strictObject({
    /** v0 renders through the generated Mastra renderer; no free-form prompt assembly. */
    render: z.literal('mastra'),
    includeCitations: z.boolean().optional(),
    /** An output schema file in the package, when the capability expects typed items. */
    schema: PackageFilePathSchema.optional(),
  }),
});

export const ContextRecipeSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('ContextRecipe'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
    version: SemverSchema,
  }),
  spec: ContextRecipeSpecSchema,
});

export type ContextRecipe = z.infer<typeof ContextRecipeSchema>;
export type ContextRecipeSpec = z.infer<typeof ContextRecipeSpecSchema>;
export type RecipeStage = z.infer<typeof RecipeStageSchema>;
export type RecipeStageType = (typeof RECIPE_STAGE_ORDER)[number];
