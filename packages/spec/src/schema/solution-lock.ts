import { z } from 'zod';

import { DigestSchema, NameSchema, SchemaVersionSchema, SemverSchema, SpecFilePathSchema } from './common.js';
import { RuntimeProfilePinSchema } from './runtime-profile.js';

/**
 * `solution.lock` v1 — the complete list of build inputs (ADR-0007).
 *
 * The lock is generated, never hand-written: every Spec reference resolves to
 * exactly one entry, and every entry pins an exact version plus a content
 * digest. `checkSolution()` enforces "no missing entry, no extra entry, digest
 * matches"; this module only fixes the shape.
 */

/** `1.0.0@sha256:…` — version first, digest second. */
export const VersionDigestPinSchema = z
  .string()
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+@sha256:[a-f0-9]{64}$/);

/** `policy/claims-approval-threshold@1.0.0` — where a concrete asset was materialized from. */
export const MaterializedFromSchema = z
  .string()
  .regex(/^[a-z][A-Za-z0-9-]*\/[a-z0-9][a-z0-9.-]*@[0-9]+\.[0-9]+\.[0-9]+$/);

const FileManifestSchema = z.record(SpecFilePathSchema, DigestSchema);

export const ConcreteAssetSchema = z.strictObject({
  version: SemverSchema,
  digest: DigestSchema,
  materializedFrom: MaterializedFromSchema.optional(),
  files: FileManifestSchema,
});

export const CustomerAssetSchema = z.strictObject({
  digest: DigestSchema,
  files: FileManifestSchema,
});

export const SpecManifestSchema = z.strictObject({
  digest: DigestSchema,
  files: FileManifestSchema,
});

/** Typed Template namespaces; a namespace may be absent, not empty. */
const templateNamespace = () => z.record(NameSchema, VersionDigestPinSchema);

export const TemplatePinsSchema = z.strictObject({
  solution: templateNamespace().optional(),
  capability: templateNamespace().optional(),
  policy: templateNamespace().optional(),
  eval: templateNamespace().optional(),
  ontology: templateNamespace().optional(),
  deploymentProfile: templateNamespace().optional(),
  modelProfile: templateNamespace().optional(),
});

export const AssetPinsSchema = z.strictObject({
  policies: z.record(NameSchema, ConcreteAssetSchema).optional(),
  evalSuites: z.record(NameSchema, ConcreteAssetSchema).optional(),
  connectors: z.record(NameSchema, CustomerAssetSchema).optional(),
  customerContextPackage: z.record(NameSchema, VersionDigestPinSchema).optional(),
});

/**
 * A runtime profile pin must carry a digest, either folded into the reference
 * (`name@version@sha256:…`, the v1 artifact shape) or as `profileDigest`.
 * Without it, `runtime_profile_missing` (runtime-adapter §7.3) cannot be decided.
 */
const FOLDED_DIGEST = /@(sha256:[a-f0-9]{64})$/;

export const RuntimePinBlockSchema = z
  .strictObject({
  profile: RuntimeProfilePinSchema,
  profileDigest: DigestSchema.optional(),
  contractVersion: SemverSchema,
  graphSchema: z.union([SchemaVersionSchema, z.number().int().min(0)]),
  auditSchema: z.union([SchemaVersionSchema, z.number().int().min(0)]),
  stateStore: z
    .strictObject({
      kind: z.enum(['sqlite', 'libsql', 'postgres']),
      schemaVersion: z.union([SchemaVersionSchema, z.number().int().min(0)]),
    })
    .optional(),
  checkpointerSchema: z.union([SchemaVersionSchema, z.number().int().min(0)]).optional(),
  mastra: SemverSchema,
  node: SemverSchema,
  python: SemverSchema,
  semantica: SemverSchema,
  contextService: SemverSchema,
  })
  .superRefine((pin, ctx) => {
    const folded = FOLDED_DIGEST.exec(pin.profile)?.[1];
    if (folded === undefined && pin.profileDigest === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['profile'],
        message: 'the runtime profile must be pinned with a digest (folded into the reference or as profileDigest)',
      });
    }
    if (folded !== undefined && pin.profileDigest !== undefined && folded !== pin.profileDigest) {
      ctx.addIssue({
        code: 'custom',
        path: ['profileDigest'],
        message: 'profileDigest disagrees with the digest folded into runtime.profile',
      });
    }
  });

/**
 * Platform artifacts the toolchain composes but a Runtime Profile does not own:
 * the `ContextServiceTopology` fragment and the license catalog. Both feed the
 * bundle payload (the composed topology and `NOTICE`), so a lock that did not
 * pin them would let two builds of the same inputs produce different addresses.
 *
 * Optional for locks written before #33; `fde build` refuses a lock without them
 * rather than resolving "the newest vendored" fragment.
 */
export const ToolchainPinSchema = z.strictObject({
  generator: SemverSchema,
  image: z.string().regex(/^[a-z0-9][a-z0-9./_-]{1,200}@sha256:[a-f0-9]{64}$/),
  contextServiceTopology: z
    .strictObject({ version: SemverSchema, digest: DigestSchema })
    .optional(),
  licenseCatalog: z.strictObject({ digest: DigestSchema }).optional(),
});

export const SolutionLockSchema = z.strictObject({
  lockVersion: z.literal(1),
  spec: SpecManifestSchema,
  templates: TemplatePinsSchema,
  assets: AssetPinsSchema.optional(),
  overlays: z.record(NameSchema, VersionDigestPinSchema).optional(),
  extensions: z.record(NameSchema, VersionDigestPinSchema).optional(),
  modelProfiles: z.record(NameSchema, VersionDigestPinSchema).optional(),
  evalDatasets: z.record(NameSchema, VersionDigestPinSchema).optional(),
  runtime: RuntimePinBlockSchema,
  toolchain: ToolchainPinSchema,
});

export type SolutionLock = z.infer<typeof SolutionLockSchema>;
export type ConcreteAsset = z.infer<typeof ConcreteAssetSchema>;
export type TemplatePins = z.infer<typeof TemplatePinsSchema>;
export type AssetPins = z.infer<typeof AssetPinsSchema>;
export type RuntimePinBlock = z.infer<typeof RuntimePinBlockSchema>;
