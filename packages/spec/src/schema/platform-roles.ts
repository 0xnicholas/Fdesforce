/**
 * The platform role vocabulary and the scopes each role grants
 * (`docs/security-and-deployment.md` §4.1, ADR-0006).
 *
 * Two role families exist and only one of them authorizes: a platform role is a
 * member of this closed vocabulary and derives the platform scopes a token
 * carries, while a business role is a Customer-defined IdP group that only filters
 * data (`permissions.yaml` row filters, `approver_roles`). A business role that
 * reused a platform role name, or that granted a platform scope, would be
 * privilege escalation through a configuration file — so the vocabulary is closed,
 * and `scopesForRoles` answers for platform roles only.
 *
 * The matrix is deliberately not a policy engine: it is the fixed mapping the
 * bundle ships, and `test/platform-roles.test.ts` compares it with the table in
 * §4.1 so a decision recorded in the doc cannot drift away from the code that
 * enforces it.
 */

/** Roles the platform itself owns; a business role may not reuse the name. */
export const PLATFORM_ROLES = [
  'end_user',
  'approver',
  'customer_admin',
  'deployment_operator',
  'auditor',
  'service',
  'support',
] as const;

export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * The scopes each platform role grants. `support:repair` is absent on purpose: it
 * needs a separate, time-boxed approval and is not a default grant (§4.1).
 */
export const PLATFORM_ROLE_SCOPES: Readonly<Record<PlatformRole, ReadonlyArray<string>>> = {
  end_user: ['run:create', 'run:read', 'run:cancel', 'context:retrieve'],
  approver: ['approval:read', 'approval:decide', 'run:read'],
  customer_admin: [
    'identity:manage',
    'deployment:approve',
    'audit:read',
    'retention:manage',
    'legal_hold:manage',
    'support:grant',
    'killswitch:execute',
  ],
  deployment_operator: ['deployment:execute', 'backup:run', 'restore:run', 'keys:rotate', 'health:read'],
  auditor: ['audit:read', 'audit:export', 'deployment:read', 'provenance:read'],
  service: ['run:create', 'context:retrieve', 'decision:write', 'approval:create', 'approval:consume'],
  support: ['health:read', 'diagnostics:read'],
};

/** Every platform scope, sorted and unique. A scope outside this set is not a platform scope. */
export const PLATFORM_SCOPES: ReadonlyArray<string> = [
  ...new Set(Object.values(PLATFORM_ROLE_SCOPES).flat()),
].sort();

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * Whether a name could pass for a platform role: case and surrounding space ignored.
 *
 * IdP group names are not normalised by the customer, and `Customer_Admin` reads as
 * authority to a human even though it grants nothing. The collision rule uses this,
 * so "a business role may not reuse a platform role name" cannot be sidestepped by
 * capitalisation.
 */
export function isPlatformRoleName(value: string): boolean {
  return isPlatformRole(value.trim().toLowerCase());
}

/**
 * The scopes a role set grants: the union over its **platform** roles.
 *
 * A role outside the vocabulary contributes nothing, which is what makes "a
 * business role never grants a scope" a property of the code rather than a promise
 * in a document.
 */
export function scopesForRoles(roles: ReadonlyArray<string>): string[] {
  const granted = new Set<string>();
  for (const role of roles) {
    if (!isPlatformRole(role)) continue;
    for (const scope of PLATFORM_ROLE_SCOPES[role]) granted.add(scope);
  }
  return [...granted].sort();
}
