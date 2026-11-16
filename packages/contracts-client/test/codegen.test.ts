// Seam: `contracts/` → `@fde/contracts-client`.
//
// Two things must hold: the committed generated code matches `contracts/`
// (otherwise the published wire surface and the client drift apart), and the
// generated client actually speaks the contract's HTTP shape.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { HttpRequest, Transport } from '../src/index.js';
import { createContextServiceClient, createRuntimeApiClient, send } from '../src/index.js';
import type { RunCreateRequest, RunCreateResponse } from '../src/index.js';

const packageRoot = resolve(import.meta.dirname, '..');

const recordTransport = () => {
  const requests: HttpRequest[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    return {
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: `run_${'A'.repeat(26)}`, trace_id: 'a'.repeat(32), status: 'queued', stream_url: '/v1/runs/x/stream' }),
    };
  };
  return { requests, transport };
};

describe('generated code is current', () => {
  it('matches contracts/ (regenerate with `pnpm generate`)', () => {
    const output = execFileSync(process.execPath, ['scripts/generate.mjs', '--check'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });

    expect(output).toContain('up to date');
  });
});

describe('runtime API client', () => {
  it('sends the contract method, path, headers and body', async () => {
    const { requests, transport } = recordTransport();
    const client = createRuntimeApiClient({ baseUrl: 'https://fde.example.internal', transport });
    const body: RunCreateRequest = { capability_id: 'document-triage', input: { claim_id: 'C-1' } };

    const result = await client.createRun({
      headers: { 'Idempotency-Key': 'a'.repeat(16), traceparent: '00-abc-def-01' },
      body,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'post',
      url: 'https://fde.example.internal/v1/runs',
      headers: { 'Idempotency-Key': 'a'.repeat(16), traceparent: '00-abc-def-01', 'content-type': 'application/json' },
    });
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual(body);

    expect(result.status).toBe(201);
    if (result.status === 201) {
      // Narrowed by status: the success body type comes from the contract.
      const created: RunCreateResponse = result.body;
      expect(created.status).toBe('queued');
    }
  });

  it('encodes path parameters and drops undefined headers', async () => {
    const { requests, transport } = recordTransport();
    const client = createRuntimeApiClient({ baseUrl: 'https://fde.example.internal/', transport });

    await client.getRun({ pathParams: { run_id: `run_${'B'.repeat(26)}` }, headers: {} });

    expect(requests[0]?.url).toBe(`https://fde.example.internal/v1/runs/run_${'B'.repeat(26)}`);
    expect(requests[0]?.headers).toEqual({});
    expect(requests[0]?.body).toBeUndefined();
  });

  it('refuses to build a URL when a path parameter is missing', async () => {
    const { transport } = recordTransport();
    const client = createRuntimeApiClient({ baseUrl: 'https://fde.example.internal', transport });

    await expect(
      client.getRun({ pathParams: {} as { run_id: `run_${string}` }, headers: {} }),
    ).rejects.toThrow(/missing path parameter run_id/);
  });
});

describe('context service client', () => {
  it('encodes query parameters and keeps undefined headers out of the wire', async () => {
    const requests: HttpRequest[] = [];
    const transport: Transport = async (request) => {
      requests.push(request);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' };
    };
    const client = createContextServiceClient({ baseUrl: 'http://context-service:8011', transport });

    await client.listApprovals({
      headers: { traceparent: '00-abc-def-01' },
      query: { status: 'pending', limit: 5 },
    });

    expect(requests[0]?.url).toBe('http://context-service:8011/v1/approvals?status=pending&limit=5');
  });
});

describe('transport', () => {
  it('returns a plain-text body unchanged and a JSON body parsed', async () => {
    const json = await send(
      async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }),
      { method: 'get', baseUrl: 'http://x', path: '/y' },
    );
    expect(json).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: { ok: true } });

    const text = await send(
      async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: {}\n\n' }),
      { method: 'get', baseUrl: 'http://x', path: '/y' },
    );
    expect(text).toMatchObject({ body: 'data: {}\n\n' });
  });
});
