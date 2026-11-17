import { z } from 'zod';

/**
 * Scalar shapes shared by every FDE document. The ones that also exist in
 * `contracts/schemas/common.schema.json` (`$defs`) are compared one by one in
 * `packages/spec/test/contract-drift.test.ts`, so a one-sided edit fails CI.
 */

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const RunIdSchema = z.string().regex(/^run_[0-9A-HJKMNP-TV-Z]{26}$/);
export const TenantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const SolutionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const CapabilityIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const EntityIdSchema = z.string().regex(/^fde:[A-Za-z0-9._~:-]{1,200}$/);
export const TraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SemverSchema = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$/);
export const SchemaVersionSchema = z.string().regex(/^[0-9]+(\.[0-9]+)*$/);

/** `Name` in `contracts/schemas` — component, volume, job and network names. */
export const NameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
/** Profile names allow dots: `mastra-1.83-node22`. */
export const ProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/);
export const RuntimeFamilySchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);

export const ClassificationSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
export const RetentionClassSchema = z.enum(['ephemeral', 'standard', 'extended', 'legal_hold']);

/**
 * A reference to a platform artifact: `name@range`, where the range is `^x.y.z`,
 * `~x.y.z`, `x.y`, `x` or an exact version. `solution.lock` resolves these to
 * exact versions + digests; a Spec never carries a digest itself.
 */
export const ArtifactRefSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}@(\^|~)?[0-9]+(\.[0-9]+){0,2}$/);

/** A Spec-local file path (`files/prompts/triage.md`), never absolute. */
export const SpecFilePathSchema = z.string().regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,200}$/);

/**
 * A package-relative path inside a Customer Context Package (`recipes/claims-context.yaml`).
 * Same rules as a Spec file path: relative, POSIX, no `..`.
 */
export const PackageFilePathSchema = SpecFilePathSchema;

/**
 * A prefixed ontology term, e.g. `ic:Claim` / `acme:priority`.
 *
 * The prefix is the module (or the Customer extension) and the local name is the
 * term; a bare local name (`Claim`) is never a term, it is only ever a *hint* in
 * the Semantic Model's resolution rules, where the package stays prefix-agnostic.
 */
export const TermNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*:[A-Za-z][A-Za-z0-9_-]*$/);
