// PROTOTYPE — generated skeleton.
// Source: solution.lock#/runtime
// GAP: the stable Runtime API (/v1/runs, approvals, SSE) is not a Mastra-native
// surface. The generator has no declared integration point for mounting it, so
// this skeleton invents a standalone node:http adapter.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { startRun, getRun, cancelRun } from './run-service';
import { runtimeInfo } from './runtime-info';

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function handleRuntimeRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const method = request.method ?? 'GET';

  if (url.pathname === '/healthz') return json(response, 200, { status: 'ok' });
  if (url.pathname === '/readyz') return json(response, 200, { status: 'ready', reasons: [] });

  if (url.pathname === '/v1/runtime-info' && method === 'GET') {
    return json(response, 200, runtimeInfo);
  }

  if (url.pathname === '/v1/runs' && method === 'POST') {
    const run = await startRun({ runId: `run_${randomUUID()}`, traceId: randomUUID().replaceAll('-', '') });
    return json(response, 202, run);
  }

  const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
  if (runMatch && method === 'GET') {
    const run = getRun(runMatch[1]);
    return run ? json(response, 200, run) : json(response, 404, { error: { code: 'not_found' } });
  }

  const cancelMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
  if (cancelMatch && method === 'POST') {
    return json(response, 202, cancelRun(cancelMatch[1]));
  }

  if (url.pathname === '/v1/approvals' && method === 'GET') {
    // GAP: approval queue lives in context-service; this proxy is a stub.
    return json(response, 200, { approvals: [] });
  }

  return json(response, 404, { error: { code: 'not_found' } });
}
