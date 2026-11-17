import { z } from 'zod';

import { NameSchema, TenantIdSchema } from './common.js';

/**
 * `IdentityProfile` — the Environment-scoped identity source (ADR-0006,
 * `docs/security-and-deployment.md` §4.3).
 *
 * In v0 the customer IdP is not wired yet, so the profile describes a **static**
 * source: fixed subjects, the platform and business roles each one asserts, and
 * the scopes a credential requests. It is deliberately shaped like the claim set
 * the future OIDC resource server will derive, so the issuance chain behind it —
 * platform/business role mapping → ES256 `ExecutionContext` — does not change
 * when real tokens arrive; only the thing that produces `subjects` does.
 *
 * The document is *not* part of the Solution Spec and *not* a Bundle artifact:
 * it is mounted into the deployment (§5.4 keeps the signing key out of the bundle,
 * and this profile names subjects, so it lives beside the key, not in the build).
 * The build still parses and checks it for the Environment it targets, so a
 * profile that would issue an escalated token fails the build rather than a Run.
 *
 * The grammar is structural only. Whether a platform role exists, whether a
 * business role impersonates one, and whether a subject claims a scope its roles
 * do not grant are `validate`'s decisions (`runtime_identity_*`), because those
 * are policy questions with an author-facing remediation, not shapes.
 */

/**
 * `ExecutionContext.roles` and `.scopes` carry at most 64 **distinct** entries
 * (`contracts/schemas/execution-context.schema.json`: `maxItems: 64`,
 * `uniqueItems: true`), and a subject's `roles` is its platform ∪ business union. The
 * document is bounded rather than the token overflowing a shape context-service
 * validates against — a duplicate role would be the same failure from the other side.
 */
export const MAX_EXECUTION_CONTEXT_ROLES = 64;
export const MAX_EXECUTION_CONTEXT_SCOPES = 64;

/** A list of role/scope strings: distinct and bounded, because the token is. */
const roleList = (fields: { max: number }) =>
  z
    .array(z.string().min(1).max(100))
    .max(fields.max)
    .refine((values) => new Set(values).size === values.length, { message: 'a role may not be listed twice' });

/** One fixed subject: the static stand-in for an IdP user or service account. */
export const IdentityProfileSubjectSchema = z.strictObject({
  /** `ExecutionContext.sub` — the stable subject id. */
  subject: z.string().min(1).max(200),
  /** `ExecutionContext.actor.display`. */
  display: z.string().min(1).max(200).optional(),
  /** `ExecutionContext.actor.type`; a Run always has one, defaulting to the user case. */
  actorType: z.enum(['user', 'service', 'system']).default('user'),
  /** Platform roles, from the closed vocabulary; they are what grants scopes. */
  platformRoles: roleList({ max: MAX_EXECUTION_CONTEXT_ROLES }).default([]),
  /** Customer IdP groups: data permissions and `approver_roles`, never a platform scope. */
  businessRoles: roleList({ max: MAX_EXECUTION_CONTEXT_ROLES }).default([]),
  /**
   * Scopes the credential requests. Absent means "everything the platform roles
   * grant"; present means a narrowing, and a scope no platform role grants is an
   * escalation the build refuses.
   */
  scopes: roleList({ max: MAX_EXECUTION_CONTEXT_SCOPES }).optional(),
}).refine((entry) => entry.platformRoles.length + entry.businessRoles.length <= MAX_EXECUTION_CONTEXT_ROLES, {
  message: `a subject may assert at most ${MAX_EXECUTION_CONTEXT_ROLES} roles, because that is what an ExecutionContext carries`,
  path: ['platformRoles'],
});

export const IdentityProfileSpecSchema = z.strictObject({
  /** Only the static source exists in this slice; real OIDC/JWKS/JIT is Slice 2.4. */
  source: z.literal('static'),
  /** The subject a Run runs as when the caller names none. */
  defaultSubject: z.string().min(1).max(200),
  subjects: z.array(IdentityProfileSubjectSchema).min(1),
});

export const IdentityProfileSchema = z.strictObject({
  apiVersion: z.literal('fde.dev/v0'),
  kind: z.literal('IdentityProfile'),
  metadata: z.strictObject({
    /** The Customer this profile belongs to; `ExecutionContext.tenant_id` is this Customer. */
    customer: TenantIdSchema,
    /** The Environment it is mounted into; a profile for another Environment is a build error. */
    environment: NameSchema,
    name: z.string().min(1).max(200).optional(),
  }),
  spec: IdentityProfileSpecSchema,
});

export type IdentityProfile = z.infer<typeof IdentityProfileSchema>;
export type IdentityProfileSpec = z.infer<typeof IdentityProfileSpecSchema>;
export type IdentityProfileSubject = z.infer<typeof IdentityProfileSubjectSchema>;
