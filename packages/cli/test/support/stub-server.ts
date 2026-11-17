import { createServer } from 'node:http';

/**
 * A loopback context-service: the runtime side of `fde context ingest`.
 *
 * The CLI's ingest is tested against a real HTTP surface rather than a mocked
 * transport, because what the criterion is about — *which endpoint* the job goes
 * to, and what credential it carries — is only observable on the wire.
 */
export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface StubServer {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

export interface StubResponse {
  status: number;
  body: unknown;
}

export async function startStubServer(response: StubResponse): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, reply) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      reply.writeHead(response.status, { 'content-type': 'application/json' });
      reply.end(JSON.stringify(response.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the stub server did not bind a port');

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A successful job over the two Acme sources. */
export function jobResult(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    job_id: `job_${'A'.repeat(26)}`,
    status: 'succeeded',
    package: { name: 'acme-claims-context', version: '1.0.0', digest: `sha256:${'a'.repeat(64)}` },
    mode: 'incremental',
    started_at: '2026-11-15T08:00:00Z',
    finished_at: '2026-11-15T08:00:12Z',
    sources: [
      { source: 'claims-db', status: 'ok', entities: 42, edges: 51, watermark: '2026-11-15T07:59:00Z' },
      { source: 'sharepoint-claims', status: 'ok', entities: 7, edges: 7 },
    ],
    ...overrides,
  };
}
