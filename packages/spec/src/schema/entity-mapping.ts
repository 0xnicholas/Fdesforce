import { z } from 'zod';

import { NameSchema, TermNameSchema, TenantIdSchema } from './common.js';
import { DurationSchema } from './solution-spec.js';

/**
 * `mappings/*.yaml` — how a source becomes graph facts (`docs/semantic-modeling.md` §5.2/§5.3).
 *
 * Two mapping kinds, because the two sources are different animals:
 *
 * - `EntityMapping` maps a structured dataset onto classes by declarative
 *   column/property pairs. It may not invent relations or properties the ontology
 *   does not declare — the check resolves every target term against the package's
 *   terminology, which is the union of what the mappings and recipes name.
 * - `DocumentMapping` maps a document tree through the extraction pipeline. An
 *   extraction result is a *candidate* (`mode: candidate`): LLM output never
 *   writes authoritative facts, so the mapping fixes the confidence floor and the
 *   provenance template instead.
 *
 * Neither may bypass the permission baseline: `filters` are pushed down to the
 * source and cannot widen what `permissions.yaml` allows (§7.2).
 */

/** Column types the structured ingress understands; a type outside this set has no writer. */
export const MappingColumnTypeSchema = z.enum(['string', 'integer', 'decimal', 'boolean', 'date', 'datetime']);

export const EntityMappingSpecSchema = z.strictObject({
  connectorRef: NameSchema,
  dataset: z.string().min(1).max(300),
  /** The class this dataset produces (`ic:Claim`). */
  entity: TermNameSchema,
  /** Stable source columns, in declaration order (a composite key concatenates in order). */
  key: z.array(z.string().min(1).max(100)).min(1),
  properties: z.record(
    z.string().min(1).max(100),
    z.strictObject({
      property: TermNameSchema,
      type: MappingColumnTypeSchema,
    }),
  ),
  relations: z.array(
    z.strictObject({
      property: TermNameSchema,
      targetEntity: TermNameSchema,
      targetKey: z.string().min(1).max(100),
      join: z.strictObject({
        table: z.string().min(1).max(300),
        on: z.string().min(1).max(500),
      }),
    }),
  ),
  watermark: z.strictObject({
    column: z.string().min(1).max(100),
    mode: z.enum(['updated_at', 'etag', 'sequence']),
  }),
  /** Row filters pushed down to the source; they narrow, they cannot widen. */
  filters: z.array(z.string().min(1).max(500)),
});

export const EntityMappingSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('EntityMapping'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    source: NameSchema,
  }),
  spec: EntityMappingSpecSchema,
});

export const DocumentMappingSpecSchema = z.strictObject({
  connectorRef: NameSchema,
  paths: z.array(z.string().min(1).max(300)).min(1),
  parser: z.string().min(1).max(100),
  chunking: z.strictObject({
    strategy: z.enum(['heading', 'paragraph', 'fixed']),
    maxTokens: z.number().int().min(1).max(32_000),
  }),
  extraction: z.strictObject({
    entityTypes: z.array(TermNameSchema),
    relationTypes: z.array(TermNameSchema),
    /** Candidates only: an extraction never writes an authoritative fact (§5.3). */
    mode: z.literal('candidate'),
    minConfidence: z.number().min(0).max(1),
  }),
  provenance: z.strictObject({
    /** Template with `{placeholders}` resolved per document. */
    sourceRef: z.string().min(1).max(300),
    version: z.string().min(1).max(100),
  }),
  schedule: z.string().min(1).max(100),
  freshness: z.strictObject({ staleAfter: DurationSchema }),
});

export const DocumentMappingSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('DocumentMapping'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    source: NameSchema,
  }),
  spec: DocumentMappingSpecSchema,
});

export type EntityMapping = z.infer<typeof EntityMappingSchema>;
export type EntityMappingSpec = z.infer<typeof EntityMappingSpecSchema>;
export type DocumentMapping = z.infer<typeof DocumentMappingSchema>;
export type DocumentMappingSpec = z.infer<typeof DocumentMappingSpecSchema>;

/**
 * The file a `spec.entityMappings[].ref` points at is either kind, so the parser
 * discriminates on `kind` rather than on the directory it happens to live in.
 */
export const MappingSchema = z.discriminatedUnion('kind', [EntityMappingSchema, DocumentMappingSchema]);

export type Mapping = z.infer<typeof MappingSchema>;
