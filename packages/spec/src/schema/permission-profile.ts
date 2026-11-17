import { z } from 'zod';

import { ClassificationSchema, NameSchema, TermNameSchema, TenantIdSchema } from './common.js';

/**
 * `permissions.yaml` — the Customer permission baseline (`docs/semantic-modeling.md` §7).
 *
 * The baseline is the layer a Solution may tighten but never relax (§3.2), so two
 * things are structural rather than configurable:
 *
 * - `defaults.unknownClassification` is `restricted`. A baseline that defaults
 *   anything else would be an opt-out of D11 ("未分类默认 restricted"), so the
 *   literal keeps the decision visible instead of merely defaulted.
 * - A property entry must say *something*: an empty entry reads as "no policy" but
 *   behaves as `restricted`, which is the opposite of what its author meant.
 *
 * Whether a term exists is not this document's question — the annotation names
 * ontology terms, and `checkContextPackage` resolves them against the package's
 * terminology. A typo is a reference error, not a shape error.
 */

/** How a value is masked on the way out. */
export const MaskActionSchema = z.enum(['redact', 'hash', 'tokenize', 'null']);

/** What kind of PII a term carries; the baselines decide the mask per kind. */
export const PiiClassSchema = z.enum(['none', 'identifier', 'contact', 'sensitive']);

const TermAnnotationShape = {
  classification: ClassificationSchema.optional(),
  pii: PiiClassSchema.optional(),
  columnMask: MaskActionSchema.optional(),
  requiredScopes: z.array(z.string().min(1).max(100)).optional(),
};

/** A row filter is pushed down to the source; it may reference `:tenant_id`, `:allowed_customer_ids`, … */
const RowFilterSchema = z.string().min(1).max(500);

export const PermissionProfileSpecSchema = z.strictObject({
  defaults: z.strictObject({
    /** Fixed: the fail-closed default is the decision, not a setting. */
    unknownClassification: z.literal('restricted'),
    /** The mask applied to PII a property annotation does not override. */
    pii: MaskActionSchema,
  }),
  /** Per-class baseline: `ic:Claim` is confidential and identifier-grade PII. */
  classifications: z.record(
    TermNameSchema,
    z.strictObject({
      classification: ClassificationSchema,
      pii: PiiClassSchema.optional(),
      requiredScopes: z.array(z.string().min(1).max(100)).optional(),
    }),
  ),
  /** Per-property baseline: masks, PII class and the scopes that unlock the column. */
  properties: z.record(
    TermNameSchema,
    z
      .strictObject(TermAnnotationShape)
      .refine(
        (entry) =>
          entry.classification !== undefined ||
          entry.pii !== undefined ||
          entry.columnMask !== undefined ||
          entry.requiredScopes !== undefined,
        {
          message:
            'a property annotation must say something (classification, pii, columnMask or requiredScopes); an empty entry reads as no policy but behaves as restricted',
        },
      ),
  ),
  rowFilters: z.record(TermNameSchema, RowFilterSchema),
  /** The scopes that unlock a class; a property annotation may narrow further. */
  scopes: z.record(TermNameSchema, z.array(z.string().min(1).max(100)).min(1)),
});

export const PermissionProfileSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('PermissionProfile'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
  }),
  spec: PermissionProfileSpecSchema,
});

export type PermissionProfile = z.infer<typeof PermissionProfileSchema>;
export type PermissionProfileSpec = z.infer<typeof PermissionProfileSpecSchema>;
export type MaskAction = z.infer<typeof MaskActionSchema>;
export type PiiClass = z.infer<typeof PiiClassSchema>;
