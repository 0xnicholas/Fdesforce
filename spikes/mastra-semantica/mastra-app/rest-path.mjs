import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.CONTEXT_URL ?? 'http://127.0.0.1:8011';
const TENANT = process.env.TENANT_ID ?? 'acme';
const TRACE = process.env.TRACE_ID ?? `tr-rest-${Date.now()}`;
const ACTOR = process.env.ACTOR ?? 'mastra-agent:spike';
const ROOT = process.env.SPIKE_ROOT ?? '/tmp/fdesforce-spike-5';
const OUT_DIR = `${ROOT}/artifacts`;
mkdirSync(OUT_DIR, { recursive: true });

const headers = {
  'content-type': 'application/json',
  'x-tenant-id': TENANT,
  'x-trace-id': TRACE,
  'x-actor': ACTOR,
};

async function call(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error(`${path} -> ${res.status}: ${text}`);
    error.status = res.status;
    error.body = json;
    throw error;
  }
  return { status: res.status, traceId: res.headers.get('x-trace-id'), json };
}

const retrieveTool = createTool({
  id: 'retrieve_context',
  description: 'Retrieve customer-context graph facts from the context service.',
  inputSchema: z.object({
    query: z.string(),
    maxHops: z.number().int().min(0).max(3).default(1),
    topK: z.number().int().min(1).max(20).default(5),
  }),
  execute: async ({ query, maxHops, topK }) => {
    const r = await call('/v1/context/retrieve', { query, max_hops: maxHops, top_k: topK });
    return r.json;
  },
});

const recordDecisionTool = createTool({
  id: 'record_decision',
  description: 'Record the decision and its evidence in the context graph with provenance.',
  inputSchema: z.object({
    category: z.string(),
    scenario: z.string(),
    reasoning: z.string(),
    outcome: z.string(),
    confidence: z.number().min(0).max(1),
    evidenceIds: z.array(z.string()),
  }),
  execute: async (input) => {
    const r = await call('/v1/decisions', {
      category: input.category,
      scenario: input.scenario,
      reasoning: input.reasoning,
      outcome: input.outcome,
      confidence: input.confidence,
      entities: input.evidenceIds,
      evidence_ids: input.evidenceIds,
      metadata: { source: 'mastra-agent' },
    });
    return r.json;
  },
});

const provenanceTool = createTool({
  id: 'get_provenance',
  description: 'Read the PROV-O provenance entry and hash-chain status for an entity or decision.',
  inputSchema: z.object({ entityId: z.string() }),
  execute: async ({ entityId }) => {
    const r = await call(`/v1/provenance/${encodeURIComponent(entityId)}`);
    return r.json;
  },
});

function collectToolResults(prompt) {
  const found = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool-result') found.push(value);
    for (const child of Object.values(value)) walk(child);
  };
  walk(prompt);
  return found;
}

function unwrapToolResult(part) {
  const out = part.output ?? part.result;
  if (out && typeof out === 'object' && 'value' in out) return out.value;
  return out;
}

let debugDumped = false;
const model = new MockLanguageModelV4({
  provider: 'spike',
  modelId: 'deterministic-tool-caller',
  doGenerate: async (opts) => {
    const toolResults = collectToolResults(opts.prompt);
    if (!debugDumped && toolResults.length > 0) {
      writeFileSync(`${OUT_DIR}/prompt-after-tool.json`, JSON.stringify(opts.prompt, null, 2));
      debugDumped = true;
    }
    const last = toolResults.at(-1);
    const usage = {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
      totalTokens: 150,
    };
    const base = { finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [] };

    if (!last) {
      return {
        ...base,
        content: [{
          type: 'tool-call',
          toolCallId: 'call-retrieve-1',
          toolName: 'retrieve_context',
          input: JSON.stringify({ query: 'refund policy premium customer 31 days', maxHops: 2, topK: 5 }),
        }],
      };
    }

    const lastValue = unwrapToolResult(last);

    if (last.toolName === 'retrieve_context') {
      const items = lastValue?.items ?? [];
      const evidenceIds = items.filter((i) => i.type !== 'decision').map((i) => i.entity_id);
      return {
        ...base,
        content: [{
          type: 'tool-call',
          toolCallId: 'call-decision-1',
          toolName: 'record_decision',
          input: JSON.stringify({
            category: 'refund_request',
            scenario: 'Premium customer requests a refund 31 days after delivery on order 1001.',
            reasoning: 'Premium policy gives a 45-day window, which covers this request; standard 30-day policy is augmented by the premium addendum.',
            outcome: 'approve_refund',
            confidence: 0.87,
            evidenceIds,
          }),
        }],
      };
    }

    if (last.toolName === 'record_decision') {
      return {
        ...base,
        content: [{
          type: 'tool-call',
          toolCallId: 'call-provenance-1',
          toolName: 'get_provenance',
          input: JSON.stringify({ entityId: lastValue.decision_id }),
        }],
      };
    }

    if (last.toolName === 'get_provenance') {
      return {
        content: [{
          type: 'text',
          text: `Refund approved. Decision ${lastValue.entity_id} recorded with provenance; chain valid: ${lastValue.chain?.valid ?? lastValue.chain?.is_valid ?? 'see artifact'}.`,
        }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage,
        warnings: [],
      };
    }

    throw new Error(`unexpected tool result: ${last.toolName}`);
  },
});

const agent = new Agent({
  id: 'fde-context-agent',
  name: 'fde-context-agent',
  instructions: 'You answer customer operations questions using the context service. Always retrieve evidence, record the decision, then verify provenance.',
  model,
  tools: { retrieve_context: retrieveTool, record_decision: recordDecisionTool, get_provenance: provenanceTool },
});

const started = Date.now();
const result = await agent.generate(
  [{ role: 'user', content: 'A premium customer asks for a refund 31 days after delivery on order 1001. Decide and record it.' }],
  { maxSteps: 8 },
);
const wallMs = Date.now() - started;

const artifact = {
  trace_id: TRACE,
  tenant_id: TENANT,
  actor: ACTOR,
  wall_ms: wallMs,
  final_text: result.text,
  finish_reason: result.finishReason,
  raw_steps: result.steps,
  steps: result.steps?.map((s) => ({
    tool_calls: s.toolCalls?.map((c) => ({ toolName: c.payload?.toolName, args: c.payload?.args })),
    tool_results: s.toolResults?.map((r) => ({ toolName: r.payload?.toolName, result: r.payload?.result })),
    text: s.text,
  })),
};
writeFileSync(`${OUT_DIR}/rest-run.json`, JSON.stringify(artifact, null, 2));

// Independent verification through the same HTTP contract.
const health = await call('/health');
const verified = {
  artifact,
  health: health.json,
  decision_provenance: null,
};
const decisionStep = artifact.raw_steps?.flatMap((s) => s.toolResults ?? []).find((r) => (r.toolName ?? r.payload?.toolName) === 'record_decision');
const decisionId = decisionStep?.result?.decision_id ?? decisionStep?.payload?.result?.decision_id;
if (decisionId) {
  verified.decision_provenance = (await call(`/v1/provenance/${encodeURIComponent(decisionId)}`)).json;
}
writeFileSync(`${OUT_DIR}/rest-verified.json`, JSON.stringify(verified, null, 2));

console.log(JSON.stringify({
  trace_id: TRACE,
  wall_ms: wallMs,
  final_text: result.text,
  decision_id: decisionId,
  provenance_entry: verified.decision_provenance?.entry,
  chain: verified.decision_provenance?.chain,
  tool_calls: artifact.steps?.flatMap((s) => s.tool_calls ?? []).map((c) => c.toolName),
}, null, 2));
