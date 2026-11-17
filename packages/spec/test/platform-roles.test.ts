// Seam: the platform role vocabulary and the scope matrix behind it.
//
// `ExecutionContext.roles` is the union of platform roles and business roles, and
// only the platform half may grant a scope (ADR-0006, `docs/security-and-deployment.md`
// §4.1). Two copies of that rule would be one too many — `BusinessRoleSchema`
// rejects a business role that reuses a platform role name, the build gate rejects
// a subject that claims a scope its platform roles do not grant, and the generated
// app bakes the matrix — so the vocabulary and the matrix live here, once.
//
// The matrix is not a decision this package gets to make: §4.1 is. So the test
// reads the table and compares, and a role or scope that moves in the doc without
// moving here fails the build.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLATFORM_ROLES, PLATFORM_ROLE_SCOPES, PLATFORM_SCOPES, isPlatformRole, scopesForRoles } from '../src/index.js';

const repoRoot = resolve(import.meta.dirname, '../../..');
const security = readFileSync(join(repoRoot, 'docs/security-and-deployment.md'), 'utf8');

/** The §4.1 table, as the doc writes it: one platform role per row, scopes in backticks. */
const documented = (): Map<string, string[]> => {
  const roles = new Map<string, string[]>();
  for (const line of security.split('\n')) {
    const row = /^\| `([a-z_]+)` \| (.+?) \| .* \|\s*$/.exec(line);
    if (row?.[1] === undefined || row[2] === undefined) continue;
    const scopes = [...row[2].matchAll(/`([^`]+)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    if (scopes.length > 0) roles.set(row[1], scopes);
  }
  return roles;
};

describe('the platform role vocabulary', () => {
  it('is the fixed seven every document, the generated app and the gate share', () => {
    expect([...PLATFORM_ROLES].sort()).toEqual([
      'approver',
      'auditor',
      'customer_admin',
      'deployment_operator',
      'end_user',
      'service',
      'support',
    ]);
  });

  it('is closed: a role outside it is not a platform role', () => {
    expect(isPlatformRole('end_user')).toBe(true);
    expect(isPlatformRole('claims-adjuster')).toBe(false);
    expect(isPlatformRole('release:approve')).toBe(false);
    expect(isPlatformRole('')).toBe(false);
  });
});

describe('the scope matrix is §4.1', () => {
  it('grants exactly the scopes the doc table lists', () => {
    const table = documented();

    expect([...table.keys()].sort()).toEqual([...PLATFORM_ROLES].sort());
    for (const [role, scopes] of table) {
      expect([...(PLATFORM_ROLE_SCOPES as Record<string, readonly string[]>)[role] ?? []].sort(), role).toEqual(
        [...scopes].sort(),
      );
    }
  });

  it('declares every scope in the matrix once, sorted and unique', () => {
    const listed = Object.values(PLATFORM_ROLE_SCOPES).flat();

    expect([...PLATFORM_SCOPES]).toEqual([...new Set(listed)].sort());
  });

  it('keeps the workspace-only role out of the runtime vocabulary', () => {
    // `release:approve` lives in the workbench and never enters an ExecutionContext.
    expect(PLATFORM_SCOPES).not.toContain('release:approve');
    expect(PLATFORM_SCOPES).not.toContain('release:sign');
  });
});

describe('scopes for a role set', () => {
  it('is the union of the platform roles, sorted and unique', () => {
    expect(scopesForRoles(['end_user', 'approver'])).toEqual([
      'approval:decide',
      'approval:read',
      'context:retrieve',
      'run:cancel',
      'run:create',
      'run:read',
    ]);
  });

  it('grants nothing for a business role, because a business role is data permissions only', () => {
    expect(scopesForRoles(['claims-adjuster', 'claims-supervisor'])).toEqual([]);
  });

  it('ignores the business roles in a mixed set and repeats of a platform role', () => {
    expect(scopesForRoles(['claims-adjuster', 'end_user', 'end_user'])).toEqual([
      'context:retrieve',
      'run:cancel',
      'run:create',
      'run:read',
    ]);
  });

  it('grants nothing for an empty set', () => {
    expect(scopesForRoles([])).toEqual([]);
  });
});
