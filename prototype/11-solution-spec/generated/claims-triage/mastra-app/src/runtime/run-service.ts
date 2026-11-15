// PROTOTYPE — generated skeleton.
// GAP: capability_id -> workflow mapping is not declared in the Spec. The
// generated Run service hardcodes `document-triage` -> `document-triage-flow`.
const runs = new Map<string, { runId: string; traceId: string; status: string }>();

export async function startRun(input: { runId: string; traceId: string }) {
  // GAP: no generated code connects the Runtime API Run to a Mastra workflow
  // run. The Mastra workflow API surface must be verified against 1.83 before
  // this can be generated for real.
  const run = { ...input, status: 'queued' };
  runs.set(input.runId, run);
  return { ...run, stream_url: `/v1/runs/${input.runId}/stream` };
}

export function getRun(runId: string) {
  return runs.get(runId) ?? null;
}

export function cancelRun(runId: string) {
  const run = runs.get(runId);
  if (run) run.status = 'cancelled';
  return { runId, status: run?.status ?? 'not_found' };
}
