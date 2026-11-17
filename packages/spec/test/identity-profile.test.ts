// Seam: the `IdentityProfile` document (#29).
//
// The mounted static identity source is the development stand-in for the customer
// IdP (ADR-0006, `docs/security-and-deployment.md` §4.3): it declares fixed
// subjects, the platform roles and business roles each one asserts, and — where a
// credential asks for less than its roles grant — the scopes it requests. The
// runtime half of that read (`loadIdentity`) is the generator's; this seam is the
// document grammar, so an authoring mistake is a parse diagnostic and not a
// container that boots and then refuses every Run.
import { describe, expect, it } from 'vitest';

import { IdentityProfileSchema, documentSchemas, parseIdentityProfile } from '../src/index.js';

const profile = (): Record<string, unknown> => ({
  apiVersion: 'fde.dev/v0',
  kind: 'IdentityProfile',
  metadata: { customer: 'acme', environment: 'acme-dev' },
  spec: {
    source: 'static',
    defaultSubject: 'adjuster-1',
    subjects: [
      {
        subject: 'adjuster-1',
        display: 'Ada Adjuster',
        platformRoles: ['end_user'],
        businessRoles: ['claims-adjuster'],
      },
      { subject: 'svc-eval', actorType: 'service', platformRoles: ['service'] },
    ],
  },
});

const body = (document = profile()): Record<string, any> => document['spec'] as Record<string, any>;
const subjects = (document = profile()): Array<Record<string, any>> => body(document)['subjects'] as Array<Record<string, any>>;

describe('an IdentityProfile parses', () => {
  it('fills the defaults the runtime relies on', () => {
    const parsed = parseIdentityProfile(profile());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.spec.subjects[0]).toEqual({
      subject: 'adjuster-1',
      display: 'Ada Adjuster',
      actorType: 'user',
      platformRoles: ['end_user'],
      businessRoles: ['claims-adjuster'],
    });
    expect(parsed.value.spec.subjects[1]?.actorType).toBe('service');
    expect(parsed.value.spec.subjects[1]?.businessRoles).toEqual([]);
    expect(parsed.value.metadata).toEqual({ customer: 'acme', environment: 'acme-dev' });
  });

  it('accepts a subject that requests fewer scopes than its roles grant', () => {
    subjects()[0]!['scopes'] = ['context:retrieve'];

    expect(parseIdentityProfile(profile()).ok).toBe(true);
  });

  it('is a published document schema, so an editor validates it like any other', () => {
    const published = documentSchemas().find((entry) => entry.kind === 'IdentityProfile');

    expect(published?.file).toBe('identity-profile.schema.json');
    expect(published?.schema).toMatchObject({ type: 'object' });
  });
});

describe('the grammar rejects what the runtime cannot honour', () => {
  const fails = (change: (document: Record<string, any>) => void): ReturnType<typeof parseIdentityProfile> => {
    const document = profile();
    change(document);
    return parseIdentityProfile(document);
  };

  it('rejects a document that is not an IdentityProfile', () => {
    const result = parseIdentityProfile({ ...profile(), kind: 'SolutionSpec' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.code)).toEqual(['identity_profile_invalid']);
  });

  it('rejects an unknown field instead of letting it become configuration', () => {
    const result = fails((document) => {
      subjects(document)[0]!['platformRole'] = ['end_user'];
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: 'identity_profile_invalid', path: 'spec.subjects[0]' });
    expect(result.errors[0]?.remediation).toMatch(/unknown field/);
  });

  it('rejects a source other than the static one this slice implements', () => {
    const result = fails((document) => {
      body(document)['source'] = 'oidc';
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ code: 'identity_profile_invalid', path: 'spec.source' });
  });

  it('rejects an empty subject list, which would leave a Run with no identity at all', () => {
    const result = fails((document) => {
      body(document)['subjects'] = [];
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'spec.subjects' });
  });

  it('rejects an actor type the contract does not define', () => {
    const result = fails((document) => {
      subjects(document)[0]!['actorType'] = 'robot';
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'spec.subjects[0].actorType' });
  });

  it('rejects a missing default subject, because a Run always runs as somebody', () => {
    const result = fails((document) => {
      delete body(document)['defaultSubject'];
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'spec.defaultSubject' });
  });

  it('rejects metadata that does not name the Customer and Environment it belongs to', () => {
    const result = fails((document) => {
      document['metadata'] = { customer: 'acme' };
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'metadata.environment' });
  });

  it('rejects a role or scope listed twice, because the token carries distinct entries', () => {
    for (const change of [
      (document: Record<string, any>) => (subjects(document)[0]!['platformRoles'] = ['end_user', 'end_user']),
      (document: Record<string, any>) => (subjects(document)[0]!['businessRoles'] = ['claims-adjuster', 'claims-adjuster']),
      (document: Record<string, any>) => (subjects(document)[0]!['scopes'] = ['run:read', 'run:read']),
    ]) {
      const result = fails(change);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]?.message).toMatch(/may not be listed twice/);
    }
  });

  it('rejects more roles than an ExecutionContext can carry, rather than overflowing the token', () => {
    const result = fails((document) => {
      subjects(document)[0]!['businessRoles'] = Array.from({ length: 64 }, (_, index) => `group-${index}`);
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ path: 'spec.subjects[0].platformRoles' });
    expect(result.errors[0]?.message).toMatch(/at most 64 roles/);
  });

  it('is not enforced by the schema: who may hold which role is the build gate', () => {
    // The document is shaped here; whether the roles are real, whether a business
    // role impersonates a platform one, and whether a scope is granted by the
    // roles that claim it are decisions `validate` makes with diagnostics an
    // author can act on (#29). Splitting the seam that way keeps one rule in one
    // place: the schema cannot reject a role name it does not know.
    subjects()[0]!['platformRoles'] = ['superuser'];

    expect(parseIdentityProfile(profile()).ok).toBe(true);
    expect(() => IdentityProfileSchema.parse(profile())).not.toThrow();
  });
});
