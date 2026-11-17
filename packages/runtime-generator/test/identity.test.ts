// Seam: the identity half of the build gate (#29).
//
// `contracts/schemas/execution-context.schema.json` says what a token may assert;
// `docs/security-and-deployment.md` §4 says who may assert what. The gate is where
// those meet: a static identity profile is the dev stand-in for the customer IdP,
// so every privilege escalation it could encode must fail the build instead of
// minting a token at runtime. Three refusals matter and each has its own code —
// an unknown platform role, a business role that impersonates a platform one, and
// a scope no platform role grants (which is how "business roles never grant a
// platform scope" is enforced).
import { describe, expect, it } from 'vitest';

import type { IdentityProfile } from '@fde/spec';

import { validateRuntime } from '../src/index.js';
import type { RuntimeValidationInput } from '../src/index.js';
import { exampleIdentity, findDiagnostic, validationInput } from './support/fixtures.js';

const inputWithIdentity = (change: (identity: IdentityProfile) => void): RuntimeValidationInput => {
  const input = structuredClone(validationInput());
  input.identity = exampleIdentity();
  change(input.identity);

  return input;
};

const subject = (identity: IdentityProfile, index = 0) => {
  const found = identity.spec.subjects[index];
  if (found === undefined) throw new Error(`the fixture has no subject ${index}`);
  return found;
};

describe('the reference identity profile', () => {
  it('passes the gate with nothing to warn about', () => {
    const result = validateRuntime(inputWithIdentity(() => {}));

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('is optional: a build with no profile mounted has nothing to validate', () => {
    const result = validateRuntime(validationInput());

    expect(result.errors.map((error) => error.code).filter((code) => code.startsWith('runtime_identity'))).toEqual([]);
  });
});

describe('runtime_identity_role_unknown', () => {
  it('rejects a platform role outside the fixed vocabulary', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).platformRoles = ['end_user', 'superuser'];
      }),
    );

    const diagnostic = findDiagnostic(result, 'runtime_identity_role_unknown');
    expect(diagnostic.path).toBe('identity.spec.subjects[0].platformRoles[1]');
    expect(diagnostic.message).toContain('superuser');
    expect(diagnostic.remediation).toMatch(/end_user/);
  });

  it('rejects a misspelt role rather than silently granting nothing', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).platformRoles = ['end_userr'];
      }),
    );

    expect(findDiagnostic(result, 'runtime_identity_role_unknown').path).toBe('identity.spec.subjects[0].platformRoles[0]');
  });
});

describe('runtime_identity_role_collision', () => {
  it('rejects a business role that only looks like a platform role', () => {
    // IdP group names are not normalised by the customer: `Customer_Admin` grants
    // nothing, but it is authority to a human reading an audit trail.
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).businessRoles = ['Customer_Admin'];
      }),
    );

    expect(findDiagnostic(result, 'runtime_identity_role_collision').path).toBe('identity.spec.subjects[0].businessRoles[0]');
  });

  it('rejects a business role that reuses a platform role name', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).businessRoles = ['claims-adjuster', 'approver'];
      }),
    );

    const diagnostic = findDiagnostic(result, 'runtime_identity_role_collision');
    expect(diagnostic.path).toBe('identity.spec.subjects[0].businessRoles[1]');
    expect(diagnostic.message).toContain('approver');
    expect(diagnostic.remediation).toBeDefined();
  });
});

describe('runtime_identity_scope_escalation', () => {
  it('rejects a scope a business role would carry', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).platformRoles = [];
        subject(identity).businessRoles = ['claims-supervisor'];
        subject(identity).scopes = ['context:retrieve'];
      }),
    );

    const diagnostic = findDiagnostic(result, 'runtime_identity_scope_escalation');
    expect(diagnostic.path).toBe('identity.spec.subjects[0].scopes[0]');
    expect(diagnostic.message).toContain('context:retrieve');
    expect(diagnostic.message).toContain('business role');
  });

  it('rejects a scope the subject’s platform roles do not grant', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).platformRoles = ['end_user'];
        subject(identity).scopes = ['identity:manage'];
      }),
    );

    const diagnostic = findDiagnostic(result, 'runtime_identity_scope_escalation');
    expect(diagnostic.message).toContain('identity:manage');
    expect(diagnostic.message).toContain('end_user');
  });

  it('allows a credential to request fewer scopes than its roles grant', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).platformRoles = ['end_user'];
        subject(identity).scopes = ['context:retrieve'];
      }),
    );

    expect(result.errors).toEqual([]);
  });
});

describe('runtime_identity_invalid', () => {
  it('rejects a default subject no profile declares', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        identity.spec.defaultSubject = 'nobody';
      }),
    );

    const diagnostic = findDiagnostic(result, 'runtime_identity_invalid');
    expect(diagnostic.path).toBe('identity.spec.defaultSubject');
    expect(diagnostic.message).toContain('nobody');
  });

  it('rejects the same subject declared twice, which would make the Run’s identity depend on order', () => {
    const declared = exampleIdentity().spec.subjects.length;
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        identity.spec.subjects.push({ ...subject(identity) });
      }),
    );

    expect(findDiagnostic(result, 'runtime_identity_invalid').path).toBe(
      `identity.spec.subjects[${declared}].subject`,
    );
  });

  it('rejects a profile that belongs to another Customer, because the tenant is the Customer', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        identity.metadata.customer = 'beta';
      }),
    );

    const diagnostic = findDiagnostic(result, 'runtime_identity_invalid');
    expect(diagnostic.path).toBe('identity.metadata.customer');
    expect(diagnostic.message).toContain('acme');
  });

  it('rejects a profile mounted into the wrong Environment', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        identity.metadata.environment = 'acme-prod-copy';
      }),
    );

    expect(findDiagnostic(result, 'runtime_identity_invalid').path).toBe('identity.metadata.environment');
  });
});

describe('the identity gate is not the runtime’s only check', () => {
  it('reports every problem at once, so an author fixes the document in one pass', () => {
    const result = validateRuntime(
      inputWithIdentity((identity) => {
        subject(identity).platformRoles = ['superuser'];
        subject(identity).businessRoles = ['auditor'];
        subject(identity).scopes = ['audit:export'];
      }),
    );

    expect(result.errors.map((error) => error.code).sort()).toEqual([
      'runtime_identity_role_collision',
      'runtime_identity_role_unknown',
      'runtime_identity_scope_escalation',
    ]);
  });
});
