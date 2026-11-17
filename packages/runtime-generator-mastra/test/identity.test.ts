// Seam: the emitted ExecutionContext issuance chain (#29), executed.
//
// The acceptance criteria are wire behaviour, not source text: an ES256 token with
// `iss = fde://<deployment_id>`, `aud = context-service`, a five-minute expiry, a
// `kid` and a `jti`, and `roles` that are the platform ∪ business union where only
// the platform half derived the scopes. So this suite materialises the generated
// tree, loads `runtime/identity.ts` / `runtime/roles.ts` exactly as the bundle
// does, and verifies the signature with the public half of a key it generated —
// the same check context-service will run.
//
// It also pins the two properties the ticket names and a source scan cannot prove:
// the private key never reaches a file, a message or the tree, and every escalation
// the build refuses at validate time is refused again when the mounted profile is
// loaded (the profile is mounted at deploy time, so the build cannot be the only
// gate).
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PLATFORM_ROLE_SCOPES, PLATFORM_ROLES, parseIdentityProfile, scopesForRoles } from '@fde/spec';

import { mastraGenerator } from '../src/index.js';
import { materialize } from './support/generated-app.js';
import type { MaterializedTree } from './support/generated-app.js';
import { generateInput, mutatedGenerateInput } from './support/fixtures.js';

type Mutable = Record<string, any>;

interface IdentitySubject {
  subject: string;
  display?: string;
  actorType: string;
  platformRoles: string[];
  businessRoles: string[];
  scopes?: string[];
}

interface IdentitySource {
  defaultSubject: string;
  subjects: IdentitySubject[];
}

interface Claims {
  iss: string;
  aud: string;
  sub: string;
  actor: { type: string; id: string; display?: string };
  tenant_id: string;
  deployment_id: string;
  solution_id: string;
  run_id: string;
  trace_id: string;
  roles: string[];
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}

interface ResolvedIdentity {
  source: IdentitySource;
  key: KeyObject;
  kid: string;
  deploymentId: string;
}

interface IdentityModule {
  IdentityConfigError: new (message: string) => Error;
  EXECUTION_CONTEXT_AUDIENCE: string;
  EXECUTION_CONTEXT_TTL_SECONDS: number;
  loadIdentity(env: Record<string, string | undefined>): ResolvedIdentity;
  parseIdentitySource(document: unknown): IdentitySource;
  createExecutionContextIssuer(identity: ResolvedIdentity): (request: {
    runId: string;
    traceId: string;
    deadline?: number;
  }) => { token: string; claims: Claims };
}

interface RolesModule {
  PLATFORM_ROLES: readonly string[];
  PLATFORM_ROLE_SCOPES: Record<string, readonly string[]>;
  PLATFORM_SCOPES: readonly string[];
  isPlatformRole(role: string): boolean;
  scopesForRoles(roles: readonly string[]): string[];
}

const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RUN_ID = 'run_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

let tree: MaterializedTree;
let identity: IdentityModule;
let roles: RolesModule;
let keyPair: { privateKey: KeyObject; publicKey: KeyObject };
let privatePem: string;

beforeAll(async () => {
  tree = materialize();
  identity = await tree.load<IdentityModule>('runtime/identity.ts');
  roles = await tree.load<RolesModule>('runtime/roles.ts');
  const generated = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  keyPair = { privateKey: generated.privateKey, publicKey: generated.publicKey };
  privatePem = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
});
afterAll(() => {
  tree.cleanup();
});

/** The mounted static profile: one dev adjuster, one supervisor with a business role. */
const identityDocument = (change: (spec: Mutable) => void = () => {}): Mutable => {
  const document: Mutable = {
    apiVersion: 'fde.dev/v0',
    kind: 'IdentityProfile',
    metadata: { customer: 'acme', environment: 'acme-prod' },
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
      ],
    },
  };
  change(document['spec'] as Mutable);
  return document;
};

const load = (change: (spec: Mutable) => void = () => {}): ResolvedIdentity =>
  identity.loadIdentity({
    deploymentId: DEPLOYMENT_ID,
    configJson: JSON.stringify(identityDocument(change)),
    signingKeyPem: privatePem,
  });

const issue = (change: (spec: Mutable) => void = () => {}, request: { deadline?: number } = {}) =>
  identity.createExecutionContextIssuer(load(change))({ runId: RUN_ID, traceId: TRACE_ID, ...request });

/** Decode a compact JWS without verifying it; verification is a separate, explicit step. */
const decode = (token: string): { header: Record<string, any>; claims: Claims; signingInput: string; signature: Buffer } => {
  const [header, payload, signature] = token.split('.');
  if (header === undefined || payload === undefined || signature === undefined) {
    throw new Error(`not a compact JWS: ${token}`);
  }
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, any>,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
};

/** RFC 7638 JWK thumbprint, computed the way context-service would. */
const thumbprint = (publicKey: KeyObject): string => {
  const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string; y: string };
  const members = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(members).digest('base64url');
};

describe('an issued ExecutionContext', () => {
  it('is an ES256 JWS the public key verifies', () => {
    const { token } = issue();
    const { header, signingInput, signature } = decode(token);

    expect(header['alg']).toBe('ES256');
    expect(header['typ']).toBe('JWT');
    expect(verify('sha256', Buffer.from(signingInput, 'utf8'), { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' }, signature)).toBe(true);
    expect(token.split('.')).toHaveLength(3);
  });

  it('asserts the deployment, the audience, the tenant and the Run', () => {
    const { claims } = issue();

    expect(claims.iss).toBe(`fde://${DEPLOYMENT_ID}`);
    expect(claims.aud).toBe(identity.EXECUTION_CONTEXT_AUDIENCE);
    expect(claims.aud).toBe('context-service');
    expect(claims.deployment_id).toBe(DEPLOYMENT_ID);
    expect(claims.tenant_id).toBe('acme');
    expect(claims.solution_id).toBe('claims-triage');
    expect(claims.run_id).toBe(RUN_ID);
    expect(claims.trace_id).toBe(TRACE_ID);
    expect(claims.sub).toBe('adjuster-1');
    expect(claims.actor).toEqual({ type: 'user', id: 'adjuster-1', display: 'Ada Adjuster' });
  });

  it('expires in five minutes', () => {
    const { claims } = issue();

    expect(claims.exp - claims.iat).toBe(identity.EXECUTION_CONTEXT_TTL_SECONDS);
    expect(claims.exp - claims.iat).toBe(300);
    expect(Math.abs(claims.iat - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
  });

  it('expires with the Run when the deadline is nearer', () => {
    const deadline = Date.now() + 30_000;
    const { claims } = issue(() => {}, { deadline });

    expect(claims.exp - claims.iat).toBeLessThanOrEqual(30);
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
  });

  it('never outlives five minutes, however generous the Run deadline', () => {
    const { claims } = issue(() => {}, { deadline: Date.now() + 3_600_000 });

    expect(claims.exp - claims.iat).toBe(300);
  });

  it('carries a fresh `jti` per token and the `kid` of the key that signed it', () => {
    const issuer = identity.createExecutionContextIssuer(load());
    const first = issuer({ runId: RUN_ID, traceId: TRACE_ID });
    const second = issuer({ runId: RUN_ID, traceId: TRACE_ID });

    expect(first.claims.jti).toHaveLength(26);
    expect(first.claims.jti).not.toBe(second.claims.jti);

    // `kid` is the JFV/7638 thumbprint of the public key, so the service that holds
    // the public key derives the same id — and a `kid` cannot name the wrong key.
    expect(first.claims.kid).toBe(thumbprint(keyPair.publicKey));
    expect(decode(first.token).header['kid']).toBe(first.claims.kid);
  });

  it('gives another key another `kid`', () => {
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const otherPem = other.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const resolved = identity.loadIdentity({
      deploymentId: DEPLOYMENT_ID,
      configJson: JSON.stringify(identityDocument()),
      signingKeyPem: otherPem,
    });

    expect(resolved.kid).toBe(thumbprint(other.publicKey));
    expect(resolved.kid).not.toBe(load().kid);
  });
});

describe('roles are the platform ∪ business union, scopes are the platform half', () => {
  it('carries business roles in `roles` and grants them no scope', () => {
    const { claims } = issue((spec) => {
      spec['subjects'][0].platformRoles = ['end_user'];
      spec['subjects'][0].businessRoles = ['claims-adjuster', 'claims-supervisor'];
    });

    expect(claims.roles).toEqual(['claims-adjuster', 'claims-supervisor', 'end_user']);
    expect(claims.scopes).toEqual(scopesForRoles(['end_user']));
    expect(claims.scopes).toEqual(['context:retrieve', 'run:cancel', 'run:create', 'run:read']);
  });

  it('grants nothing to a subject that holds only business roles', () => {
    const { claims } = issue((spec) => {
      spec['subjects'][0].platformRoles = [];
      spec['subjects'][0].businessRoles = ['claims-adjuster'];
    });

    expect(claims.roles).toEqual(['claims-adjuster']);
    expect(claims.scopes).toEqual([]);
  });

  it('unions the scopes of several platform roles, sorted and unique', () => {
    const { claims } = issue((spec) => {
      spec['subjects'][0].platformRoles = ['end_user', 'approver'];
    });

    expect(claims.scopes).toEqual(['approval:decide', 'approval:read', 'context:retrieve', 'run:cancel', 'run:create', 'run:read']);
  });

  it('honours scopes a credential narrowed', () => {
    const journal = issue((spec) => {
      spec['subjects'][0].platformRoles = ['end_user'];
      spec['subjects'][0].scopes = ['run:read', 'context:retrieve'];
    });

    expect(journal.claims.scopes).toEqual(['context:retrieve', 'run:read']);
    expect(journal.claims.roles).toEqual(['claims-adjuster', 'end_user']);
  });

  it('runs as the default subject the profile names', () => {
    const { claims } = issue((spec) => {
      spec['defaultSubject'] = 'svc-eval';
      spec['subjects'].push({ subject: 'svc-eval', actorType: 'service', platformRoles: ['service'] });
    });

    expect(claims.sub).toBe('svc-eval');
    expect(claims.actor).toEqual({ type: 'service', id: 'svc-eval' });
    expect(claims.scopes).toEqual(scopesForRoles(['service']));
  });
});

describe('the deployment injects the profile and the key', () => {
  let directory: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'fde-identity-'));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  it('mounts the profile and the key as files, the way a secret store injects them', () => {
    const profilePath = join(directory, 'identity.json');
    const keyPath = join(directory, 'signing-key.pem');
    writeFileSync(profilePath, JSON.stringify(identityDocument()));
    writeFileSync(keyPath, privatePem);

    const resolved = identity.loadIdentity({ deploymentId: DEPLOYMENT_ID, configPath: profilePath, signingKeyFile: keyPath });
    const issued = identity.createExecutionContextIssuer(resolved)({ runId: RUN_ID, traceId: TRACE_ID });

    expect(decode(issued.token).claims.sub).toBe('adjuster-1');
    expect(verify('sha256', Buffer.from(decode(issued.token).signingInput), { key: keyPair.publicKey, dsaEncoding: 'ieee-p1363' }, decode(issued.token).signature)).toBe(true);
  });

  it('accepts either mechanism: a mounted file or inline JSON', () => {
    const profilePath = join(directory, 'inline.json');
    writeFileSync(profilePath, JSON.stringify(identityDocument()));

    expect(identity.loadIdentity({ deploymentId: DEPLOYMENT_ID, configPath: profilePath, signingKeyPem: privatePem }).kid).toBe(
      identity.loadIdentity({ deploymentId: DEPLOYMENT_ID, configJson: JSON.stringify(identityDocument()), signingKeyPem: privatePem }).kid,
    );
  });
});

describe('a deployment that cannot sign does not serve', () => {
  const rejects = (env: Record<string, string | undefined>, message: RegExp): void => {
    expect(() => identity.loadIdentity(env)).toThrow(identity.IdentityConfigError);
    expect(() => identity.loadIdentity(env)).toThrow(message);
  };

  const withProfile = (change: (spec: Mutable) => void): Record<string, string> => ({
    deploymentId: DEPLOYMENT_ID,
    configJson: JSON.stringify(identityDocument(change)),
    signingKeyPem: privatePem,
  });

  it('refuses to start with no deployment id, because `iss` has no other source', () => {
    rejects({ configJson: JSON.stringify(identityDocument()), signingKeyPem: privatePem }, /FDE_DEPLOYMENT_ID/);
  });

  it('refuses a deployment id the contract schema would not accept', () => {
    rejects({ ...withProfile(() => {}), deploymentId: 'prod' }, /FDE_DEPLOYMENT_ID/);
  });

  it('refuses to start with no signing key', () => {
    rejects({ deploymentId: DEPLOYMENT_ID, configJson: JSON.stringify(identityDocument()) }, /FDE_SIGNING_KEY/);
  });

  it('refuses a key that is not a readable PKCS#8 PEM', () => {
    rejects({ deploymentId: DEPLOYMENT_ID, configJson: JSON.stringify(identityDocument()), signingKeyPem: 'not a key' }, /PKCS#8/);
  });

  it('refuses a key on another curve, which would sign under the wrong alg', () => {
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const pem = p384.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

    rejects({ deploymentId: DEPLOYMENT_ID, configJson: JSON.stringify(identityDocument()), signingKeyPem: pem }, /ES256/);
  });

  it('refuses to start with no identity source mounted', () => {
    rejects({ deploymentId: DEPLOYMENT_ID, signingKeyPem: privatePem }, /FDE_IDENTITY_CONFIG/);
  });

  it('refuses a profile for another Customer, whose tokens would assert another tenant', () => {
    expect(() =>
      identity.loadIdentity({
        deploymentId: DEPLOYMENT_ID,
        configJson: JSON.stringify({ ...identityDocument(), metadata: { customer: 'beta', environment: 'acme-prod' } }),
        signingKeyPem: privatePem,
      }),
    ).toThrow(/does not declare acme/);
  });

  it("refuses a profile for another Environment, because a profile\u2019s roles are Environment-scoped", () => {
    // §4.3: each Environment has its own mapping. A staging profile mounted into prod
    // carries roles nobody reviewed for prod, and the build's check cannot see it —
    // the profile is mounted after the build.
    expect(() =>
      identity.loadIdentity({
        deploymentId: DEPLOYMENT_ID,
        configJson: JSON.stringify({ ...identityDocument(), metadata: { customer: 'acme', environment: 'acme-staging' } }),
        signingKeyPem: privatePem,
      }),
    ).toThrow(/Environment-scoped/);
  });
});

describe('the load-time gate is the build gate', () => {
  const refuses = (change: (spec: Mutable) => void, message: RegExp, scopes?: string[]): void => {
    const mutate = (spec: Mutable): void => {
      change(spec);
      if (scopes !== undefined) spec['subjects'][0].scopes = scopes;
    };

    expect(() => load(mutate)).toThrow(identity.IdentityConfigError);
    expect(() => load(mutate)).toThrow(message);
  };

  it('refuses an unknown platform role', () => {
    refuses((spec) => (spec['subjects'][0].platformRoles = ['superuser']), /not a platform role/);
  });

  it('refuses a business role that reuses a platform role name', () => {
    refuses((spec) => (spec['subjects'][0].businessRoles = ['customer_admin']), /platform role/);
    refuses((spec) => (spec['subjects'][0].businessRoles = ['Customer_Admin']), /platform role/);
  });

  it('refuses a scope no platform role grants, which is how a business role would gain one', () => {
    refuses(
      (spec) => {
        spec['subjects'][0].platformRoles = [];
        spec['subjects'][0].businessRoles = ['claims-supervisor'];
        spec['subjects'][0].scopes = ['audit:export'];
      },
      /never grant a platform scope/,
    );
  });

  it('refuses a default subject that is not declared', () => {
    refuses((spec) => (spec['defaultSubject'] = 'nobody'), /not one of the declared subjects/);
  });

  it('refuses the same subject twice', () => {
    refuses((spec) => spec['subjects'].push({ ...spec['subjects'][0] }), /declared twice/);
  });

  it('refuses a repeated role or scope, which the token could not carry', () => {
    refuses((spec) => (spec['subjects'][0].platformRoles = ['end_user', 'end_user']), /twice/);
    refuses((spec) => (spec['subjects'][0].businessRoles = ['claims-adjuster', 'claims-adjuster']), /twice/);
    refuses((spec) => (spec['subjects'][0].platformRoles = ['end_user']), /twice/, ['run:read', 'run:read']);
  });

  it('refuses a profile with no subjects at all', () => {
    refuses((spec) => (spec['subjects'] = []), /no subjects/);
  });

  it('refuses a source this build does not implement', () => {
    refuses((spec) => (spec['source'] = 'oidc'), /Slice 2.4/);
  });

  it('refuses a document that is not an IdentityProfile', () => {
    expect(() =>
      identity.loadIdentity({
        deploymentId: DEPLOYMENT_ID,
        configJson: JSON.stringify({ ...identityDocument(), kind: 'SolutionSpec' }),
        signingKeyPem: privatePem,
      }),
    ).toThrow(/not an IdentityProfile/);
  });

  it('refuses a subject with more roles than an ExecutionContext can carry', () => {
    refuses(
      (spec) => {
        spec['subjects'][0].businessRoles = Array.from({ length: 64 }, (_, index) => `group-${index}`);
      },
      /at most 64/,
    );
  });

  it('agrees with the build: every document the runtime refuses, validate refuses too', () => {
    const documents: Array<(spec: Mutable) => void> = [
      (spec) => (spec['subjects'][0].platformRoles = ['superuser']),
      (spec) => (spec['subjects'][0].businessRoles = ['approver']),
      (spec) => {
        spec['subjects'][0].platformRoles = [];
        spec['subjects'][0].scopes = ['audit:export'];
      },
    ];

    for (const change of documents) {
      const ran = (() => {
        try {
          load(change);
          return 'loaded';
        } catch {
          return 'refused';
        }
      })();

      const validated = mastraGenerator.validate({ ...generateInput(), identity: parsedIdentity(change) });

      expect(ran, 'the runtime must refuse what the build refuses').toBe('refused');
      expect(validated.errors.map((error) => error.code)).toContain(
        identityCodesFor(change),
      );
    }
  });

  it('agrees with the build in the other direction too: an Environment profile the build refuses, the app refuses', () => {
    // The profile is mounted after the build, so this direction is the one a real
    // deployment relies on: the build saw `acme-prod`, the mount says something else.
    const input = { ...generateInput(), identity: parsedIdentity(() => {}) };
    const mismatched = { ...input, environment: { ...input.environment, name: 'acme-staging' } };

    expect(mastraGenerator.validate(mismatched).errors.map((error) => error.code)).toContain('runtime_identity_invalid');
    expect(() =>
      identity.loadIdentity({
        deploymentId: DEPLOYMENT_ID,
        configJson: JSON.stringify({ ...identityDocument(), metadata: { customer: 'acme', environment: 'acme-staging' } }),
        signingKeyPem: privatePem,
      }),
    ).toThrow(identity.IdentityConfigError);
  });
});

/** The code the build reports for the escalation `change` encodes. */
const identityCodesFor = (change: (spec: Mutable) => void): string => {
  const document = identityDocument(change);
  const subject = (document['spec'] as Mutable)['subjects'][0] as Mutable;
  if ((subject['platformRoles'] as string[]).some((role) => role === 'superuser')) return 'runtime_identity_role_unknown';
  if ((subject['businessRoles'] as string[]).some((role) => role === 'approver')) return 'runtime_identity_role_collision';
  return 'runtime_identity_scope_escalation';
};

/** The mutated profile, parsed the way the CLI hands it to the build gate. */
const parsedIdentity = (change: (spec: Mutable) => void) => {
  const parsed = parseIdentityProfile(identityDocument(change));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
  return parsed.value;
};

describe('generation is gated by the identity half too', () => {
  it('refuses to emit a tree for an escalated profile, not just to warn about one', () => {
    // `validate` is where the ticket asks for the refusal, and every `generate*` method
    // re-checks the gate (#27) — so a build that skipped `validate` still cannot emit a
    // tree for a profile that grants a business role a platform scope.
    const input = { ...generateInput(), identity: parsedIdentity((spec) => {
      spec['subjects'][0].platformRoles = [];
      spec['subjects'][0].scopes = ['audit:export'];
    }) };

    expect(() => mastraGenerator.generateApp(input)).toThrow(/runtime_identity_scope_escalation/);
    expect(() => mastraGenerator.generateTopology(input)).toThrow(/runtime_identity_scope_escalation/);
  });
});

describe('the key never leaves the environment', () => {
  it('appears in no generated file', () => {
    const files = mastraGenerator.generateApp(generateInput()).files;

    for (const file of files) {
      expect(file.content, file.path).not.toMatch(/BEGIN (?:EC |RSA )?PRIVATE KEY/);
    }
  });

  it('is not echoed by a failure to read it', () => {
    const marker = 'fde-private-key-marker';
    const failure = (() => {
      try {
        identity.loadIdentity({ deploymentId: DEPLOYMENT_ID, configJson: JSON.stringify(identityDocument()), signingKeyPem: `-----BEGIN PRIVATE KEY-----\n${marker}\n-----END PRIVATE KEY-----` });
      } catch (error) {
        return error as Error;
      }
      throw new Error('the loader accepted a key it cannot parse');
    })();

    expect(failure.message).not.toContain(marker);
    expect(failure.message).not.toMatch(/PRIVATE KEY/);
  });

  it('is not logged and no token is logged', () => {
    const app = mastraGenerator.generateApp(generateInput());
    const identitySource = app.files.find((file) => file.path === 'mastra-app/src/runtime/identity.ts')?.content ?? '';

    // A bearer credential or a signing key in a log is a credential leak; the module
    // that holds both does not talk to stdout at all.
    expect(identitySource).not.toMatch(/console\.(log|error|warn|debug)/);
  });
});

describe('the baked role matrix', () => {
  it('is the platform vocabulary from `@fde/spec`, verbatim', () => {
    expect([...roles.PLATFORM_ROLES].sort()).toEqual([...PLATFORM_ROLES].sort());
    expect(roles.PLATFORM_ROLE_SCOPES).toEqual(
      Object.fromEntries(Object.entries(PLATFORM_ROLE_SCOPES).map(([role, scopes]) => [role, [...scopes].sort()])),
    );
  });

  it('grants a scope to a platform role and never to anything else', () => {
    expect(roles.isPlatformRole('end_user')).toBe(true);
    expect(roles.isPlatformRole('claims-adjuster')).toBe(false);
    expect(roles.scopesForRoles(['claims-adjuster'])).toEqual([]);
  });

  it('ships as its own module, so the matrix is a reviewable artifact', () => {
    expect(mastraGenerator.generateApp(generateInput()).files.map((file) => file.path)).toContain('mastra-app/src/runtime/roles.ts');
  });
});

describe('generation bakes no subject', () => {
  it('keeps the mounted profile out of the tree, even when the build saw one', () => {
    const withIdentity = mutatedGenerateInput(() => {});
    withIdentity.identity = parsedIdentity(() => {});

    const withoutIdentity = mutatedGenerateInput(() => {});
    delete withoutIdentity.identity;

    const generated = mastraGenerator.generateApp(withIdentity);
    const joined = generated.files.map((file) => file.content).join('\n');

    // The profile names people; the bundle must not. Only the vocabulary and the
    // Customer/Solution ids are build facts (§5.4).
    expect(joined).not.toContain('adjuster-1');
    expect(joined).not.toContain('Ada Adjuster');
    // Validating a profile is not generating one: the tree is the same either way.
    expect(generated.sourceDigest).toBe(mastraGenerator.generateApp(withoutIdentity).sourceDigest);
  });
});
