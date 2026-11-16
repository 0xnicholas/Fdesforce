import { z } from 'zod';

import { NameSchema, ProfileNameSchema, SemverSchema } from './common.js';
import { RuntimeCapabilitiesSchema } from './runtime-capabilities.js';

/**
 * `RuntimeProfile` — versioned, content-addressed declaration of a runtime
 * combination, referenced by `spec.build.runtimeProfile` and pinned by
 * `solution.lock`. Mirrors `contracts/schemas/runtime-profile.schema.json`.
 */

export const RuntimeLanguageSchema = z.enum(['typescript', 'python']);

export const ProfileMetadataSchema = z.strictObject({
  name: ProfileNameSchema,
  version: SemverSchema,
  description: z.string().max(500).optional(),
});

export const ProfileGeneratorSchema = z.strictObject({
  name: NameSchema,
  version: SemverSchema,
});

/**
 * Exact versions only. A range in a profile means the lock would pin something
 * the artifact does not state, so `PackagePins` rejects it by pattern.
 */
export const PackagePinsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9@/._-]{1,200}$/), SemverSchema)
  .refine((pins) => Object.keys(pins).length > 0, {
    message: 'a profile must pin at least one package',
  });

export const LicensingSchema = z.strictObject({
  runtime: z.enum(['Apache-2.0', 'MIT', 'Elastic-2.0', 'other']),
  requiresLicenseKey: z.boolean(),
  egress: z.boolean(),
});

export const ProfileSpecSchema = z.strictObject({
  generator: ProfileGeneratorSchema,
  family: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  language: RuntimeLanguageSchema,
  runtimeVersion: SemverSchema,
  contractVersion: SemverSchema,
  packages: PackagePinsSchema,
  capabilities: RuntimeCapabilitiesSchema,
  licensing: LicensingSchema,
});

export const RuntimeProfileSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('RuntimeProfile'),
  metadata: ProfileMetadataSchema,
  spec: ProfileSpecSchema,
});

/** `name@version` — bundle-topology's `ProfileRef` pattern. */
export const ProfileRefSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}@[0-9]+\.[0-9]+\.[0-9]+$/);

export type RuntimeProfile = z.infer<typeof RuntimeProfileSchema>;
export type ProfileSpec = z.infer<typeof ProfileSpecSchema>;

/**
 * A lock entry for a runtime profile. v1 lock artifacts fold the digest into the
 * reference (`name@version@sha256:…`), so both shapes are accepted here and
 * normalized by `lock --check` (#25).
 */
export const RuntimeProfilePinSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,62}@[0-9]+(\.[0-9]+){0,2}(@sha256:[a-f0-9]{64})?$/);
