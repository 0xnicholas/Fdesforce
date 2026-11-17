import { PLATFORM_ROLES, isPlatformRole, isPlatformRoleName, scopesForRoles } from '@fde/spec';
import type { IdentityProfile, IdentityProfileSubject, SolutionSpec } from '@fde/spec';

import type { RuntimeDiagnostic, RuntimeEnvironmentView } from './port.js';

/**
 * The identity half of the build gate (`docs/runtime-contract.md` §5.1,
 * `docs/security-and-deployment.md` §4, ADR-0006).
 *
 * The static identity profile is the development stand-in for the customer IdP:
 * it decides which subject a Run runs as and which roles that subject asserts, and
 * the app turns those roles into a signed `ExecutionContext`. That makes the
 * profile an authorization document, so a mistake in it is an escalation, not a
 * typo. Three refusals carry the weight, and each has its own code because each
 * has a different fix:
 *
 * - `runtime_identity_role_unknown` — a role outside the fixed platform
 *   vocabulary. The role would grant nothing, so the token would assert an
 *   authority context-service cannot resolve.
 * - `runtime_identity_role_collision` — a business role named after a platform
 *   role. Business roles are Customer IdP groups, and a group that poses as
 *   `customer_admin` is privilege escalation through configuration.
 * - `runtime_identity_scope_escalation` — a scope the subject's platform roles do
 *   not grant. Because scopes are derived from platform roles only, this is also
 *   how "a business role never receives a platform scope" is enforced: there is no
 *   path from a business role to a scope, and a credential cannot ask for one.
 *
 * Everything else about the document — a default subject that does not exist, a
 * subject declared twice, a profile for another Customer or Environment — is
 * `runtime_identity_invalid`: one code, one remediation, because they are all
 * "this document is not the one this deployment needs".
 *
 * The generated app re-checks the same rules when it loads the mounted profile.
 * The build cannot be the only gate: the profile is mounted at deploy time and can
 * be edited between build and run.
 */

export interface IdentityCheckInput {
  /** The Solution being built: the profile must belong to its Customer. */
  spec: SolutionSpec;
  /** The Environment being built for: the profile must be the one mounted there. */
  environment: RuntimeEnvironmentView;
  identity: IdentityProfile;
}

const SUBJECTS = 'identity.spec.subjects';

/**
 * The platform role vocabulary, as a sentence an author can act on. Sorted, so the
 * diagnostic does not change when the vocabulary is reordered.
 */
const vocabulary = (): string => [...PLATFORM_ROLES].sort().join(', ');

export function checkIdentity(input: IdentityCheckInput): RuntimeDiagnostic[] {
  const { identity, spec, environment } = input;
  const errors: RuntimeDiagnostic[] = [];
  const customer = spec.metadata.customer;

  if (identity.metadata.customer !== customer) {
    errors.push({
      code: 'runtime_identity_invalid',
      path: 'identity.metadata.customer',
      message: `the identity profile belongs to ${identity.metadata.customer}, but this Solution serves ${customer}; a token minted from it would assert another Customer's tenant`,
      remediation: `mount the IdentityProfile for ${customer}, or mount none for this Environment`,
    });
  }

  if (identity.metadata.environment !== environment.name) {
    errors.push({
      code: 'runtime_identity_invalid',
      path: 'identity.metadata.environment',
      message: `the identity profile is for Environment ${identity.metadata.environment}, but this build targets ${environment.name}; a profile's roles are Environment-scoped (§4.3)`,
      remediation: `point the Environment at the IdentityProfile for ${environment.name}`,
    });
  }

  const seen = new Set<string>();
  identity.spec.subjects.forEach((entry, index) => {
    if (seen.has(entry.subject)) {
      errors.push({
        code: 'runtime_identity_invalid',
        path: `${SUBJECTS}[${index}].subject`,
        message: `subject ${entry.subject} is declared twice; which roles a Run gets would depend on document order`,
        remediation: 'declare each subject once',
      });
    }
    seen.add(entry.subject);

    errors.push(...checkSubject(entry, index));
  });

  if (!seen.has(identity.spec.defaultSubject)) {
    errors.push({
      code: 'runtime_identity_invalid',
      path: 'identity.spec.defaultSubject',
      message: `defaultSubject ${identity.spec.defaultSubject} is not one of the profile's subjects, so a Run would start with no identity`,
      remediation: 'name one of the declared subjects, or declare the one a Run should run as',
    });
  }

  return errors;
}

function checkSubject(entry: IdentityProfileSubject, index: number): RuntimeDiagnostic[] {
  const errors: RuntimeDiagnostic[] = [];

  entry.platformRoles.forEach((role, position) => {
    if (isPlatformRole(role)) return;
    errors.push({
      code: 'runtime_identity_role_unknown',
      path: `${SUBJECTS}[${index}].platformRoles[${position}]`,
      message: `${role} is not a platform role, so it grants no scope and context-service cannot resolve it`,
      remediation: `use one of ${vocabulary()}; a Customer-defined group belongs in businessRoles, where it filters data and grants nothing`,
    });
  });

  entry.businessRoles.forEach((role, position) => {
    if (!isPlatformRoleName(role)) return;
    errors.push({
      code: 'runtime_identity_role_collision',
      path: `${SUBJECTS}[${index}].businessRoles[${position}]`,
      message: `${role} is a platform role, and a business role may not reuse a platform role name; the token would carry a Customer group that reads as platform authority`,
      remediation: 'rename the Customer IdP group, or declare the role under platformRoles if it really is a platform role',
    });
  });

  const granted = new Set(scopesForRoles(entry.platformRoles));
  (entry.scopes ?? []).forEach((scope, position) => {
    if (granted.has(scope)) return;
    errors.push({
      code: 'runtime_identity_scope_escalation',
      path: `${SUBJECTS}[${index}].scopes[${position}]`,
      message: escalationMessage(entry, scope),
      remediation:
        entry.platformRoles.length === 0
          ? 'grant the platform role that owns this scope, or drop the scope; business roles are data permissions and never grant a platform scope'
          : `drop the scope, or grant the platform role that owns it (${entry.platformRoles.join(', ')} grants ${[...granted].sort().join(', ') || 'no scope'})`,
    });
  });

  return errors;
}

function escalationMessage(entry: IdentityProfileSubject, scope: string): string {
  const business = entry.businessRoles.join(', ');
  if (entry.platformRoles.length === 0) {
    return `subject ${entry.subject} requests scope ${scope}, but has no platform role${business === '' ? '' : ` (its business role ${business} is a data permission)`}; a business role never grants a platform scope`;
  }
  return `subject ${entry.subject} requests scope ${scope}, which its platform role ${entry.platformRoles.join(', ')} does not grant`;
}
