import { z } from 'zod';

import { NameSchema, PackageFilePathSchema, SemverSchema, TenantIdSchema } from './common.js';

/**
 * `manifest.yaml` — the Customer Context Package (CCP): the Customer-level,
 * versioned, immutable, *declarative* semantic asset set (ADR-0004,
 * `docs/semantic-modeling.md` §3).
 *
 * The manifest names the parts; the parts are the package. A CCP carries no
 * customer data, no secret values, no generated graph and no runtime state — the
 * manifest's job is to say which documents the package is made of, so `validate`
 * can resolve them and `freeze` can content-address the whole set.
 *
 * `status` is the lifecycle (`draft → validated → frozen`, §3.4). It is an
 * authoring claim, not the immutability evidence: what makes a version frozen is
 * a `revisions/<version>.yaml` whose digest is the content digest, and that is
 * `checkContextPackage`'s business.
 */
export const ContextPackageSpecSchema = z.strictObject({
  /** The Semantic Model binding: ontology modules, sources, mappings, resolution. */
  semanticModelRef: PackageFilePathSchema,
  /** Context Source definitions, each a `ContextSource` document. */
  contextSources: z.array(PackageFilePathSchema),
  /** Reusable Context Recipes; a Solution binds them and may only tighten them. */
  recipes: z.array(PackageFilePathSchema),
  /** The Customer permission baseline. One per package; a recipe may not substitute another. */
  permissionsRef: PackageFilePathSchema,
  /** Context Eval suites (L1). Freeze requires at least one suite with a question. */
  evals: z.array(PackageFilePathSchema),
  /**
   * What this package can be compiled into. `specMajor`/`runtimeContract` name
   * version *lines* (`v0`, `fde.runtime/v1`), so an additive minor does not
   * invalidate a frozen package; the graph/audit schema versions are exact
   * because the Context Graph is materialized, not forward-compatible.
   */
  compatibility: z.strictObject({
    specMajor: z.string().regex(/^v[0-9]+$/),
    runtimeContract: z.string().regex(/^fde\.runtime\/v[0-9]+$/),
    graphSchema: z.union([z.number().int().min(0), z.string().regex(/^[0-9]+(\.[0-9]+)*$/)]),
    auditSchema: z.union([z.number().int().min(0), z.string().regex(/^[0-9]+(\.[0-9]+)*$/)]),
  }),
  provenance: z.strictObject({
    createdBy: z.string().min(1).max(200),
    createdAt: z.iso.datetime(),
    /** Governance Decisions that shaped this version (why this mapping, this baseline). */
    decisions: z.array(z.string().min(1).max(64)),
  }),
});

export const ContextPackageSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('CustomerContextPackage'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
    version: SemverSchema,
    status: z.enum(['draft', 'validated', 'frozen']),
  }),
  spec: ContextPackageSpecSchema,
});

/**
 * `revisions/<version>.yaml` — the frozen record (§3.4).
 *
 * Freeze writes it; nothing edits it afterwards. `digest` is the content digest
 * of the package with `revisions/**` excluded, so the same value appears in three
 * places that must agree: this file, `solution.lock.assets.customerContextPackage`
 * and the ingest job request. `files` is the per-file manifest, so a modified
 * document is named rather than merely detected.
 *
 * The timestamp and actor are *provenance*, not identity: the digest is what makes
 * the artifact what it is, which is why `freeze` over unchanged content is a
 * no-op rather than a re-stamp.
 */
export const ContextPackageRevisionSpecSchema = z.strictObject({
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  files: z.record(PackageFilePathSchema, z.string().regex(/^sha256:[a-f0-9]{64}$/)),
  frozenAt: z.iso.datetime(),
  frozenBy: z.string().min(1).max(200),
  /** The commit the frozen content came from, when the caller supplied one. */
  sourceCommit: z.string().regex(/^[0-9a-f]{7,40}$/).optional(),
  /** FDE semantics owner + Customer business owner sign-off (`docs/semantic-modeling.md` §3.4). */
  decisions: z.array(z.string().min(1).max(64)).optional(),
});

export const ContextPackageRevisionSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('ContextPackageRevision'),
  metadata: z.strictObject({
    customer: TenantIdSchema,
    name: NameSchema,
    version: SemverSchema,
  }),
  spec: ContextPackageRevisionSpecSchema,
});

export type ContextPackage = z.infer<typeof ContextPackageSchema>;
export type ContextPackageSpec = z.infer<typeof ContextPackageSpecSchema>;
export type ContextPackageRevision = z.infer<typeof ContextPackageRevisionSchema>;
