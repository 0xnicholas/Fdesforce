import { z } from 'zod';

import { ArtifactRefSchema, DigestSchema, NameSchema, PackageFilePathSchema, SemverSchema, TenantIdSchema } from './common.js';
import { DurationSchema } from './solution-spec.js';

/**
 * `semantic-model.yaml` — the Customer's binding to the ontology
 * (`docs/semantic-modeling.md` §4, `docs/domain-model.md` §3.13).
 *
 * Three layers meet here: the **Domain Ontology** modules are vendored platform
 * templates (cross-customer, immutable), the **Customer Ontology Extension** is a
 * Turtle file in the package, and this document is the **Semantic Model** that
 * picks the modules, lists the sources and mappings, and fixes resolution,
 * precedence and freshness rules.
 *
 * The manifest carries the file list and the digests below are *claims*: a module
 * digest must equal the vendored template's digest and an extension digest must
 * equal the file's content, which is what `checkContextPackage` compares. A digest
 * that is not checked is decoration, so it is checked.
 *
 * `resolution.keys` and `sourcePrecedence` are keyed by the *local* name of a
 * class (`Claim`), not by a prefixed term: the rules are the Customer's, and the
 * same rule set survives swapping `ic:Claim` for another module's term. The check
 * resolves a local name against the mappings' entity terms.
 */
export const SemanticModelOntologySchema = z.strictObject({
  modules: z.array(
    z.strictObject({
      /** `insurance-claims@1.0.0` — a vendored Domain Ontology module version. */
      ref: ArtifactRefSchema,
      source: z.literal('template'),
      /** The vendored template's content digest, so a frozen package names the exact TTL it was modelled against. */
      digest: DigestSchema,
    }),
  ),
  /** Customer Ontology Extensions in the package: TTL, plus SHACL shapes. */
  extensions: z.array(
    z.strictObject({
      path: PackageFilePathSchema,
      digest: DigestSchema,
    }),
  ),
});

export const SemanticModelSourceSchema = z.strictObject({
  /** The id a recipe stage and a mapping refer to (`claims-db`). */
  ref: NameSchema,
  contextSource: PackageFilePathSchema,
});

export const SemanticModelSpecSchema = z.strictObject({
  ontology: SemanticModelOntologySchema,
  sources: z.array(SemanticModelSourceSchema),
  entityMappings: z.array(z.strictObject({ ref: PackageFilePathSchema })),
  resolution: z.strictObject({
    /** Stable business keys per class local name; `Claim: [claim_id]`. */
    keys: z.record(z.string().min(1).max(100), z.array(z.string().min(1).max(100)).min(1)),
    /** Which source wins per class local name (`Claim: [claims-db, sharepoint-claims]`). */
    sourcePrecedence: z.record(z.string().min(1).max(100), z.array(NameSchema).min(1)),
    merge: z.strictObject({
      strategy: z.literal('same_as'),
      minConfidence: z.number().min(0).max(1),
    }),
  }),
  freshness: z.strictObject({
    defaultStaleAfter: DurationSchema,
    perSource: z.record(NameSchema, DurationSchema),
  }),
  recipes: z.array(z.strictObject({ ref: PackageFilePathSchema })),
  permissions: z.strictObject({ ref: PackageFilePathSchema }),
  evals: z.array(z.strictObject({ ref: PackageFilePathSchema })),
});

export const SemanticModelSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('SemanticModel'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
    version: SemverSchema,
  }),
  spec: SemanticModelSpecSchema,
});

export type SemanticModel = z.infer<typeof SemanticModelSchema>;
export type SemanticModelSpec = z.infer<typeof SemanticModelSpecSchema>;
