import { z } from 'zod';

import { ArtifactRefSchema, NameSchema, SemverSchema, TenantIdSchema } from './common.js';

/**
 * `evals/*.yaml` — the L1 Context Eval suite that gates a CCP freeze
 * (`docs/semantic-modeling.md` §9, `docs/evaluation-and-observability.md` §2).
 *
 * Context quality is "the right facts, in budget, citable, fresh, with conflicts
 * visible" — so the suite asks golden questions and states what a correct
 * retrieval contains. It holds questions, not data: expected facts are stable
 * entity ids or business keys, never production rows (§9.5).
 *
 * The thresholds are the freeze gate's numbers (`recallAtBudget`,
 * `citationValidity`, and the two "must stay zero" counters). Running the suite
 * needs a context-service; this document is what makes the run comparable across
 * versions, and it is why an eval suite travels *inside* the package it evaluates.
 */
export const ContextEvalQuestionSchema = z.strictObject({
  id: z.string().min(1).max(100),
  question: z.string().min(1).max(2000),
  /** Recipe input: `{claim_id: C-1001}` or `{query: refund policy}`. */
  input: z.record(z.string().min(1).max(100), z.unknown()),
  /** Stable entity ids the retrieval must contain (`ic:Claim/C-1001`). */
  expectedEntities: z.array(z.string().min(1).max(300)),
  /** `source://path` citations that must survive masking. */
  requiredCitations: z.array(z.string().min(1).max(500)),
});

export const ContextEvalSuiteSpecSchema = z.strictObject({
  /** `claims-context@1.0.0` — the recipe under test. */
  recipeRef: ArtifactRefSchema,
  thresholds: z.strictObject({
    recallAtBudget: z.number().min(0).max(1),
    citationValidity: z.number().min(0).max(1),
    silentStale: z.number().int().min(0),
    silentConflict: z.number().int().min(0),
  }),
  questions: z.array(ContextEvalQuestionSchema),
});

export const ContextEvalSuiteSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('ContextEvalSuite'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
    version: SemverSchema,
  }),
  spec: ContextEvalSuiteSpecSchema,
});

export type ContextEvalSuite = z.infer<typeof ContextEvalSuiteSchema>;
export type ContextEvalSuiteSpec = z.infer<typeof ContextEvalSuiteSpecSchema>;
export type ContextEvalQuestion = z.infer<typeof ContextEvalQuestionSchema>;
