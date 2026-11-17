// Seam: the platform catalogue against the wire contract.
//
// The generated app is a standalone bundle, so it cannot import
// `@fde/contracts-client` for the retrieval shapes — the catalogue in
// `src/builtins.ts` is the app's copy of
// `contracts/schemas/retrieval.schema.json`. A copy that drifts is worse than no
// copy: a Tool whose schema declares fewer properties than the contract, or
// closes an object the contract leaves open, silently rejects valid calls.
//
// So this test compares the copy to the contract, property by property. It is the
// same idea as `@fde/spec`'s `contract-drift.test.ts`, for the one document whose
// types a *generated* artifact has to carry itself.
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MAX_EXECUTION_CONTEXT_ROLES } from '@fde/spec';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MaterializedTree } from './support/generated-app.js';
import { materialize } from './support/generated-app.js';

import { RETRIEVAL } from '../src/index.js';
import { generateContractTests } from '../src/contract-tests.js';
import {
  CAPABILITY_ID_PATTERN,
  ERROR_CODES,
  ID_PATTERNS,
  IDEMPOTENCY_KEY,
  RUN_API_OPERATIONS,
  RUN_CREATE_FIELDS,
  RUN_EVENT_TYPES,
  RUN_STATUSES,
  SLICE_EVENT_TYPES,
  THREAD_ID_BOUNDS,
} from '../src/run-api.js';
import { generateInput } from './support/fixtures.js';
import { repoRoot } from './support/repo.js';

interface JsonSchemaObject {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean | Record<string, unknown>;
}

const readSchema = (name: string): { $defs: Record<string, JsonSchemaObject> } =>
  JSON.parse(readFileSync(join(repoRoot, `contracts/schemas/${name}.schema.json`), 'utf8')) as {
    $defs: Record<string, JsonSchemaObject>;
  };

const retrieval = readSchema('retrieval');
const common = readSchema('common');

/** `PolicyEvaluation` is shared, so it lives in `common.schema.json`. */
const defs: Record<string, JsonSchemaObject> = { ...retrieval.$defs, ...common.$defs };

type CatalogueObject = { schema: Record<string, unknown>; fields: ReadonlyArray<{ name: string; optional?: boolean }> };

const pairs: ReadonlyArray<{ def: string; copy: CatalogueObject }> = [
  { def: 'RetrieveRequest', copy: RETRIEVAL.request },
  { def: 'RetrieveResponse', copy: RETRIEVAL.response },
  { def: 'RetrievalItem', copy: RETRIEVAL.item },
  { def: 'Budget', copy: RETRIEVAL.budget },
  { def: 'BudgetUsed', copy: RETRIEVAL.budgetUsed },
  { def: 'Subject', copy: RETRIEVAL.subject },
  { def: 'PolicyEvaluation', copy: RETRIEVAL.policyEvaluation },
];

const asObject = (value: Record<string, unknown>): JsonSchemaObject => value as JsonSchemaObject;

describe('the retrieval catalogue is the contract', () => {
  it.each(pairs)('$def declares the same properties', ({ def, copy }) => {
    const declared = Object.keys(defs[def]?.properties ?? {}).sort();
    const copied = Object.keys(asObject(copy.schema).properties ?? {}).sort();

    expect(copied).toEqual(declared);
  });

  it.each(pairs)('$def requires the same properties', ({ def, copy }) => {
    expect([...(asObject(copy.schema).required ?? [])].sort()).toEqual([...(defs[def]?.required ?? [])].sort());
  });

  it.each(pairs)('$def agrees on whether extra properties are allowed', ({ def, copy }) => {
    const declared = defs[def]?.additionalProperties ?? true;
    const copied = asObject(copy.schema).additionalProperties ?? true;

    expect(copied).toBe(declared);
  });

  it('covers every object retrieval.schema.json defines', () => {
    const emitted = new Set(pairs.map((pair) => pair.def));
    const objects = Object.entries(retrieval.$defs)
      .filter(([, node]) => node.type === 'object')
      .map(([name]) => name);

    expect(objects.filter((name) => !emitted.has(name))).toEqual([]);
  });
});

describe('the TypeScript view matches the schema beside it', () => {
  it.each(pairs)('$def: every required property is a non-optional field', ({ def, copy }) => {
    const fields = copy.fields;
    const optional = new Set(fields.filter((field) => field.optional === true).map((field) => field.name));
    const names = new Set(fields.map((field) => field.name));

    expect([...(asObject(copy.schema).required ?? [])].filter((name) => optional.has(name))).toEqual([]);
    expect([...(asObject(copy.schema).required ?? [])].filter((name) => !names.has(name))).toEqual([]);
    expect(fields.map((field) => field.name).sort()).toEqual(Object.keys(defs[def]?.properties ?? {}).sort());
  });
});

// --- the Run API (#28) ------------------------------------------------------

/**
 * The Run API catalogue (`src/run-api.ts`) is the second copy the generated app
 * has to carry: it feeds the emitted `runtime/wire.ts`, the router's statuses and
 * the A2/A5 parity fixture. So it is compared against three independent sources —
 * the OpenAPI document, the JSON Schemas, and the error table in
 * `docs/runtime-contract.md` §3.4 — rather than against itself.
 */
const runApi = readSchema('run');
const openapi = parse(readFileSync(join(repoRoot, 'contracts/runtime-api-v1.openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
  components: { parameters: { IdempotencyKey: { schema: { minLength: number; maxLength: number } } } };
};

const operations = Object.values(RUN_API_OPERATIONS);

describe('the Run API catalogue is the contract', () => {
  it('names the four operations with the contract method, path and statuses', () => {
    for (const operation of operations) {
      const declared = openapi.paths[operation.path]?.[operation.method];
      expect(declared, `${operation.method.toUpperCase()} ${operation.path}`).toBeDefined();

      const statuses = Object.keys(declared?.responses ?? {}).map(Number);
      expect(statuses.sort((left, right) => left - right)).toEqual(
        [...operation.success, ...operation.errors].sort((left, right) => left - right),
      );
      expect(statuses.filter((status) => status >= 200 && status < 300)).toEqual([...operation.success]);
    }
  });

  it('knows which operations require an Idempotency-Key', () => {
    const declared = Object.entries(openapi.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, operation]) => ({
        path,
        method,
        idempotency: JSON.stringify(operation).includes('IdempotencyKey'),
      })),
    );

    for (const operation of operations) {
      const match = declared.find((candidate) => candidate.path === operation.path && candidate.method === operation.method);
      expect(match?.idempotency, `${operation.operationId}`).toBe(operation.idempotencyKey);
    }
  });

  it('carries every event type the RunEvent schema defines, and only those', () => {
    const declared = (runApi.$defs['RunEvent']?.properties?.['type'] as { enum?: string[] } | undefined)?.enum ?? [];

    expect([...RUN_EVENT_TYPES].sort()).toEqual([...declared].sort());
  });

  it('produces a subset of the contract events, without the approval types', () => {
    expect(SLICE_EVENT_TYPES.every((type) => RUN_EVENT_TYPES.includes(type))).toBe(true);
    expect(SLICE_EVENT_TYPES.some((type) => type.startsWith('approval.'))).toBe(false);
    expect(RUN_EVENT_TYPES.filter((type) => type.startsWith('approval.')).filter((type) => SLICE_EVENT_TYPES.includes(type))).toEqual([]);
  });

  it('carries every Run status the schema defines', () => {
    const declared = (runApi.$defs['RunStatus']?.properties?.['status'] as { enum?: string[] } | undefined)?.enum ?? [];

    expect([...RUN_STATUSES].sort()).toEqual([...declared].sort());
  });

  it('carries every error code, with the status and retryability in §3.4', () => {
    const declared = (common.$defs['ErrorCode'] as { enum?: string[] } | undefined)?.enum ?? [];
    expect(Object.keys(ERROR_CODES).sort()).toEqual([...declared].sort());

    const table = readFileSync(join(repoRoot, 'docs/runtime-contract.md'), 'utf8');
    const rows = [...table.matchAll(/^\| `([a-z_]+)` \| (\d{3}) \| (true|false) \|/gm)].map((match) => ({
      code: match[1] as string,
      status: Number(match[2]),
      retryable: match[3] === 'true',
    }));
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(ERROR_CODES[row.code], row.code).toEqual({ status: row.status, retryable: row.retryable });
    }
  });

  it('mints the identifier shapes the common schema declares', () => {
    expect(ID_PATTERNS.run_id).toBe((common.$defs['RunId'] as { pattern?: string } | undefined)?.pattern);
    expect(ID_PATTERNS.trace_id).toBe((common.$defs['TraceId'] as { pattern?: string } | undefined)?.pattern);
    const bounds = openapi.components.parameters.IdempotencyKey.schema;
    expect(IDEMPOTENCY_KEY).toEqual({ minLength: bounds.minLength, maxLength: bounds.maxLength });
  });

  it('validates a RunCreateRequest against the schema that defines it', () => {
    const request = runApi.$defs['RunCreateRequest'] as {
      required?: string[];
      properties?: Record<string, { pattern?: string; minLength?: number; maxLength?: number }>;
    };

    expect(CAPABILITY_ID_PATTERN).toBe((common.$defs['CapabilityId'] as { pattern?: string } | undefined)?.pattern);
    expect([...RUN_CREATE_FIELDS].sort()).toEqual(Object.keys(request.properties ?? {}).sort());
    expect((request.required ?? []).filter((name) => !RUN_CREATE_FIELDS.includes(name as never))).toEqual([]);
    expect(THREAD_ID_BOUNDS).toEqual({
      minLength: request.properties?.['thread_id']?.minLength,
      maxLength: request.properties?.['thread_id']?.maxLength,
    });
  });

  it('ships a parity fixture that is exactly the catalogue', () => {
    const fixture = JSON.parse(
      generateContractTests(generateInput()).generatedFiles.find((entry) => entry.path.endsWith('run-api-parity.json'))?.content ??
        '{}',
    ) as { operations: unknown; eventTypes: unknown; errorCodes: unknown };

    expect(fixture.operations).toEqual(JSON.parse(JSON.stringify(RUN_API_OPERATIONS)));
    expect(fixture.eventTypes).toEqual(SLICE_EVENT_TYPES);
    expect(fixture.errorCodes).toEqual(ERROR_CODES);
  });
});

// --- the ExecutionContext (#29) --------------------------------------------

/**
 * The second wire shape a generated artifact has to carry itself: the claims the
 * app signs. `contracts/schemas/execution-context.schema.json` is the authority —
 * context-service validates against it — and the app cannot import it, so this test
 * mints a real token from the emitted issuer and compares the claim set with the
 * schema, property by property.
 *
 * `additionalProperties: false` is what makes this a *set* comparison: a claim the
 * schema does not declare is a token the service rejects, and a required claim the
 * app omits is the same failure from the other side.
 */
const executionContext = readFileSync(join(repoRoot, 'contracts/schemas/execution-context.schema.json'), 'utf8');
const contextSchema = JSON.parse(executionContext) as {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, { type?: string; const?: unknown; pattern?: string; minLength?: number; maxLength?: number; maxItems?: number; uniqueItems?: boolean; $ref?: string }>;
};

let tokenTree: MaterializedTree;
beforeAll(() => {
  tokenTree = materialize();
});
afterAll(() => {
  tokenTree.cleanup();
});

const issuedToken = async (): Promise<{ claims: Record<string, any>; header: Record<string, any>; verified: boolean }> => {
  const module = await tokenTree.load<{
    loadIdentity(env: Record<string, string>): unknown;
    createExecutionContextIssuer(identity: unknown): (request: { runId: string; traceId: string }) => { token: string };
  }>('runtime/identity.ts');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

  const identity = module.loadIdentity({
    deploymentId: 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    configJson: JSON.stringify({
      apiVersion: 'fde.dev/v0',
      kind: 'IdentityProfile',
      metadata: { customer: 'acme', environment: 'acme-prod' },
      spec: {
        source: 'static',
        defaultSubject: 'adjuster-1',
        subjects: [{ subject: 'adjuster-1', platformRoles: ['end_user'], businessRoles: ['claims-adjuster'] }],
      },
    }),
    signingKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
  });

  const token = module.createExecutionContextIssuer(identity)({
    runId: 'run_01ARZ3NDEKTSV4RRFFQ69G5FAW',
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  }).token;

  const [header, payload, signature] = token.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, any>,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, any>,
    verified: verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  };
};

describe('the issued ExecutionContext is the contract', () => {
  it('carries every required claim, and nothing the schema does not declare', async () => {
    const { claims } = await issuedToken();
    const declared = Object.keys(contextSchema.properties).sort();

    expect(contextSchema.additionalProperties).toBe(false);
    expect([...contextSchema.required].filter((name) => claims[name] === undefined)).toEqual([]);
    // `run_id` is declared but only conditionally required (§5.1): this app always
    // mints for a Run, so it is always present — and no claim is *outside* the schema.
    expect(Object.keys(claims).sort().filter((name) => !declared.includes(name))).toEqual([]);
    expect(claims['run_id']).toBeDefined();
  });

  it('mints every identifier in the shape common.schema.json declares', async () => {
    const { claims } = await issuedToken();
    const pattern = (name: string): string | undefined => (common.$defs[name] as { pattern?: string } | undefined)?.pattern;

    expect(claims['iss']).toMatch(new RegExp(contextSchema.properties['iss']?.pattern ?? ''));
    expect(claims['aud']).toBe(contextSchema.properties['aud']?.const);
    expect(new RegExp(pattern('DeploymentId') ?? '').test(claims['deployment_id'])).toBe(true);
    expect(new RegExp(pattern('SolutionId') ?? '').test(claims['solution_id'])).toBe(true);
    expect(new RegExp(pattern('TenantId') ?? '').test(claims['tenant_id'])).toBe(true);
    expect(new RegExp(pattern('RunId') ?? '').test(claims['run_id'])).toBe(true);
    expect(new RegExp(pattern('TraceId') ?? '').test(claims['trace_id'])).toBe(true);
    expect(claims['iat']).toEqual(expect.any(Number));
    expect(claims['exp'] - claims['iat']).toBeLessThanOrEqual(300);
  });

  it('bounds the role union at what the schema allows', async () => {
    // The profile is bounded rather than the token overflowing: a document that
    // asserts more roles than an ExecutionContext can carry fails the build (and the
    // app's load), instead of minting an assertion context-service rejects.
    expect(MAX_EXECUTION_CONTEXT_ROLES).toBe(contextSchema.properties['roles']?.maxItems);
    expect(MAX_EXECUTION_CONTEXT_ROLES).toBe(64);
  });

  it('declares the same bounds on `roles`, `scopes`, `jti` and `kid`', async () => {
    const { claims, header } = await issuedToken();
    const bound = (name: string) => ({
      minLength: contextSchema.properties[name]?.minLength,
      maxLength: contextSchema.properties[name]?.maxLength,
    });

    for (const name of ['jti', 'kid']) {
      const declared = bound(name);
      expect(claims[name]).toEqual(expect.any(String));
      expect(claims[name].length, name).toBeGreaterThanOrEqual(declared.minLength ?? 0);
      expect(claims[name].length, name).toBeLessThanOrEqual(declared.maxLength ?? Number.MAX_SAFE_INTEGER);
    }

    for (const name of ['roles', 'scopes']) {
      expect(claims[name]).toEqual(expect.any(Array));
      expect(new Set(claims[name]).size, `${name} unique`).toBe(claims[name].length);
      expect(claims[name].length, `${name} maxItems`).toBeLessThanOrEqual(contextSchema.properties[name]?.maxItems ?? 0);
    }

    // The `kid` names the key in the JWS header; the claim is the contract's copy of
    // it, so a service that reads either finds the same key id.
    expect(header['kid']).toBe(claims['kid']);
  });

  it('carries an `actor` the common schema accepts', async () => {
    const { claims } = await issuedToken();
    const actor = common.$defs['Actor'] as JsonSchemaObject & { properties: Record<string, { enum?: string[] }> };

    expect(Object.keys(claims['actor']).sort().every((key) => Object.hasOwn(actor.properties, key))).toBe(true);
    expect([...(actor.required ?? [])].filter((key) => claims['actor'][key] === undefined)).toEqual([]);
    expect((actor.properties['type'] as { enum?: string[] }).enum).toContain(claims['actor']['type']);
  });

  it('is a JWS whose ES256 signature the public key verifies', async () => {
    const { header, verified } = await issuedToken();

    expect(header['alg']).toBe('ES256');
    expect(header['typ']).toBe('JWT');
    expect(verified).toBe(true);
  });
});
