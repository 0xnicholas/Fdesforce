// Seam: `fde context ingest` — the internal job endpoint (#31 acceptance criterion 3).
//
// The criterion is directional: the CLI must go to context-service's *internal
// maintenance surface*, with the `fde-jobs` credential, and never to the customer
// Runtime API. So the stub server asserts the path, the JWT (signature, issuer,
// audience, maintenance scope, trace correlation) and the job body — everything a
// wrong endpoint or a wrong credential would change.
import { generateKeyPairSync, verify } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { makeSandbox, type Sandbox } from './support/sandbox.js';
import { jobResult, startStubServer, type StubServer } from './support/stub-server.js';

let sandbox: Sandbox | undefined;
let stub: StubServer | undefined;

const DEPLOYMENT = `dep_${'B'.repeat(26)}`;

interface Keys {
  publicKeyPem: string;
  privateKeyPath: string;
}

/** A per-test ES256 key pair; the private half goes in the sandbox like a mounted secret. */
function writeJobsKey(sb: Sandbox, kind: 'ec' | 'rsa' = 'ec'): Keys {
  const { privateKey, publicKey } =
    kind === 'ec'
      ? generateKeyPairSync('ec', {
          namedCurve: 'prime256v1',
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        })
      : generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
  const path = join(sb.root, 'jobs-key.pem');
  sb.write('jobs-key.pem', privateKey);
  return { publicKeyPem: publicKey, privateKeyPath: path };
}

const fresh = (): Sandbox => {
  sandbox = makeSandbox();
  return sandbox;
};

afterEach(async () => {
  await stub?.close();
  stub = undefined;
  sandbox?.cleanup();
  sandbox = undefined;
});

interface Args {
  sb: Sandbox;
  keys: Keys;
  url: string;
  extra?: string[];
}

const ingest = ({ sb, keys, url, extra = [] }: Args) =>
  sb.run([
    'context',
    'ingest',
    '--package',
    sb.contextPackage,
    '--context-service',
    url,
    '--deployment',
    DEPLOYMENT,
    '--solution',
    'claims-triage',
    '--jobs-key',
    keys.privateKeyPath,
    '--workspace',
    sb.workspace,
    ...extra,
  ]);

const decode = (token: string): { header: Record<string, string>; claims: Record<string, any>; signingInput: string; signature: Buffer } => {
  const [header = '', claims = '', signature = ''] = token.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, string>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, any>,
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature, 'base64url'),
  };
};

describe('fde context ingest', () => {
  it('posts the frozen package to the internal job endpoint, not to the Runtime API', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url });

    expect(result.code, result.err).toBe(0);
    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/internal/v1/jobs/ingest');
    expect(request.path.startsWith('/v1/')).toBe(false);
  });

  it('authenticates as the fde-jobs issuer with a maintenance scope only', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url });
    expect(result.code, result.err).toBe(0);

    const authorization = stub.requests[0]?.headers['authorization'];
    expect(authorization).toMatch(/^Bearer /);
    const token = String(authorization).slice('Bearer '.length);
    const { header, claims, signingInput, signature } = decode(token);

    // The signature is real: a verifier holding the public half accepts it.
    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT' });
    expect(typeof header['kid']).toBe('string');
    expect(
      verify('sha256', Buffer.from(signingInput, 'utf8'), { key: keys.publicKeyPem, dsaEncoding: 'ieee-p1363' }, signature),
    ).toBe(true);

    expect(claims['iss']).toBe(`fde://${DEPLOYMENT}/jobs`);
    expect(claims['aud']).toBe('context-service');
    expect(claims['deployment_id']).toBe(DEPLOYMENT);
    expect(claims['solution_id']).toBe('claims-triage');
    expect(claims['tenant_id']).toBe('acme');
    expect(claims['roles']).toEqual([]);
    expect(claims['scopes']).toEqual(['context:ingest']);
    expect(claims['scopes']).not.toContain('context:retrieve');
    expect(claims['run_id']).toBeUndefined();
    expect(claims['kid']).toBe(header['kid']);
    expect(claims['jti']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(claims['exp'] - claims['iat']).toBe(300);
  });

  it('carries one trace through the JWT and the traceparent header', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url });
    expect(result.code, result.err).toBe(0);

    const request = stub.requests[0]!;
    const token = String(request.headers['authorization']).slice('Bearer '.length);
    const traceparent = String(request.headers['traceparent']);
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(decode(token).claims['trace_id']).toBe(traceparent.split('-')[1]);
  });

  it('sends the revision digest, the mode and the requested sources', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });
    const revision = (await import('yaml')).parse(sb.read('examples/semantic/acme/revisions/1.0.0.yaml')) as Record<string, any>;

    const result = await ingest({
      sb,
      keys,
      url: stub.url,
      extra: ['--mode', 'rebuild', '--source', 'sharepoint-claims', '--source', 'claims-db'],
    });

    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(stub.requests[0]!.body)).toEqual({
      package: { name: 'acme-claims-context', version: '1.0.0', digest: revision['spec']['digest'] },
      mode: 'rebuild',
      sources: ['claims-db', 'sharepoint-claims'],
    });
  });

  it('omits sources when the caller asks for all of them', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    await ingest({ sb, keys, url: stub.url });

    const body = JSON.parse(stub.requests[0]!.body) as Record<string, unknown>;
    expect(body['mode']).toBe('incremental');
    expect(body['sources']).toBeUndefined();
  });

  it('reports the finished job', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url, extra: ['--json'] });

    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out) as { command: string; ok: boolean; result: Record<string, any> };
    expect(report.command).toBe('context ingest');
    expect(report.ok).toBe(true);
    expect(report.result['status']).toBe('succeeded');
    expect(report.result['sources']).toHaveLength(2);
  });

  it('exits 0 with a warning when the job finished degraded', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({
      status: 200,
      body: jobResult({
        status: 'degraded',
        sources: [{ source: 'claims-db', status: 'degraded', reason: 'source_unavailable' }],
      }),
    });

    const result = await ingest({ sb, keys, url: stub.url });

    expect(result.code, result.err).toBe(0);
    expect(result.err).toMatch(/context_ingest_degraded/);
    expect(result.err).toMatch(/claims-db degraded/);
  });

  it('exits 1 when the job failed', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult({ status: 'failed', message: 'graph write failed' }) });

    const result = await ingest({ sb, keys, url: stub.url });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_ingest_failed/);
    expect(result.err).toMatch(/graph write failed/);
  });

  it('surfaces a refusal from the job endpoint with the reason it gave', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({
      status: 409,
      body: {
        error: {
          code: 'conflict',
          message: 'the package digest is not a frozen revision',
          retryable: false,
          trace_id: 'a'.repeat(32),
          details: { reason: 'package_not_frozen' },
        },
      },
    });

    const result = await ingest({ sb, keys, url: stub.url });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_ingest_failed/);
    expect(result.err).toMatch(/not a frozen revision/);
    expect(result.err).toMatch(/package_not_frozen/);
    expect(result.err).toMatch(/fde context freeze/);
  });

  it('refuses to ingest a package that is not frozen, without calling the runtime', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });
    rmSync(join(sb.contextPackage, 'revisions/1.0.0.yaml'));

    const result = await ingest({ sb, keys, url: stub.url });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_package_not_frozen/);
    expect(stub.requests).toEqual([]);
  });

  it('refuses a source the package does not declare, without calling the runtime', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url, extra: ['--source', 'beta-dms'] });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_reference_unknown/);
    expect(result.err).toMatch(/beta-dms/);
    expect(stub.requests).toEqual([]);
  });

  it('refuses a key that is not ES256 before it mints a token', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb, 'rsa');
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_jobs_key_invalid/);
    expect(result.err).toMatch(/ES256/);
    expect(stub.requests).toEqual([]);
  });

  it('uses a --kid override in the token header', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);
    stub = await startStubServer({ status: 200, body: jobResult() });

    const result = await ingest({ sb, keys, url: stub.url, extra: ['--kid', 'jobs-key-2026-11'] });
    expect(result.code, result.err).toBe(0);

    const token = String(stub.requests[0]?.headers['authorization']).slice('Bearer '.length);
    expect(decode(token).header['kid']).toBe('jobs-key-2026-11');
  });

  it('rejects a malformed deployment id, a bad mode and a missing key with usage errors', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);

    const badDeployment = await sb.run([
      'context',
      'ingest',
      '--package',
      sb.contextPackage,
      '--context-service',
      'http://127.0.0.1:1',
      '--deployment',
      'production',
      '--solution',
      'claims-triage',
      '--jobs-key',
      keys.privateKeyPath,
      '--workspace',
      sb.workspace,
    ]);
    expect(badDeployment.code).toBe(2);
    expect(badDeployment.err).toMatch(/--deployment must be dep_/);

    const badMode = await ingest({ sb, keys, url: 'http://127.0.0.1:1', extra: ['--mode', 'sync'] });
    expect(badMode.code).toBe(2);
    expect(badMode.err).toMatch(/--mode/);

    const missingKey = await sb.run([
      'context',
      'ingest',
      '--package',
      sb.contextPackage,
      '--context-service',
      'http://127.0.0.1:1',
      '--deployment',
      DEPLOYMENT,
      '--solution',
      'claims-triage',
    ]);
    expect(missingKey.code).toBe(2);
    expect(missingKey.err).toMatch(/--jobs-key/);
  });

  it('reports an unreachable context-service as a failed job, not a crash', async () => {
    const sb = fresh();
    const keys = writeJobsKey(sb);

    const result = await ingest({ sb, keys, url: 'http://127.0.0.1:1' });

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/context_ingest_failed/);
  });
});
