import { MCPClient } from '@mastra/mcp';
import { mkdirSync, writeFileSync } from 'node:fs';

const ROOT = process.env.SPIKE_ROOT ?? '/tmp/fdesforce-spike-5';
const OUT_DIR = `${ROOT}/artifacts`;
mkdirSync(OUT_DIR, { recursive: true });
const PYTHON = process.env.SEMANTICA_PYTHON ?? `${ROOT}/.venv/bin/python`;
const KG_PATH = `${ROOT}/mcp-graph.json`;

const client = new MCPClient({
  id: 'semantica-control',
  servers: {
    semantica: {
      command: PYTHON,
      args: ['-m', 'semantica.mcp_server'],
      env: { SEMANTICA_KG_PATH: KG_PATH },
      stderr: 'pipe',
    },
  },
  timeout: 120000,
});

const started = Date.now();
const tools = await client.listTools();
const toolNames = Object.keys(tools).sort();
const serverInfo = client.getServerInfo();
const toolset = Object.values(await client.listToolsets())[0] ?? {};
const localNames = Object.keys(toolset).sort();

async function exec(name, args) {
  const tool = tools[`semantica_${name}`] ?? tools[name];
  if (!tool) throw new Error(`missing tool ${name}`);
  return await tool.execute(args, {});
}

let addResult;
let summaryBefore;
let queryResult;
let summaryAfter;
let decisionQuery;
let recordDecision;
let restRetrieve;
let restHealth;
let error;

try {
  summaryBefore = await exec('get_graph_summary', {});
  addResult = await exec('add_entity', {
    id: 'mcp:probe:policy',
    label: 'MCP-only refund policy',
    type: 'Policy',
    metadata: { tenant_id: 'acme', origin: 'mcp-control' },
  });
  await exec('add_relationship', {
    source: 'mcp:probe:policy',
    target: 'acme:policy:refund',
    type: 'MENTIONS',
    metadata: { origin: 'mcp-control' },
  }).catch((e) => { error = `add_relationship: ${e.message}`; });
  queryResult = await exec('query_graph', { query: 'refund policy' });
  recordDecision = await exec('record_decision', {
    category: 'refund_request',
    scenario: 'MCP control: premium customer asks for refund after 31 days.',
    reasoning: 'MCP graph has its own isolated copy of the policy.',
    outcome: 'approve_refund',
    confidence: 0.8,
    decision_maker: 'mcp-agent:control',
  });
  summaryAfter = await exec('get_graph_summary', {});
  decisionQuery = await exec('query_decisions', { limit: 3 });
  const restRes = await fetch('http://127.0.0.1:8011/v1/context/retrieve', {
    method: 'POST',
    headers: {'content-type':'application/json','x-tenant-id':'acme','x-actor':'mcp-control','x-trace-id':'tr-mcp-isolation'},
    body: JSON.stringify({query:'mcp:probe:policy', max_hops:1, top_k:5}),
  });
  restRetrieve = await restRes.json();
  restHealth = await (await fetch('http://127.0.0.1:8011/health')).json();
} catch (e) {
  error = e.stack ?? String(e);
}

const artifact = {
  transport: 'stdio',
  command: `${PYTHON} -m semantica.mcp_server`,
  env: { SEMANTICA_KG_PATH: KG_PATH },
  wall_ms: Date.now() - started,
  server_info: serverInfo,
  tools: toolNames,
  tools_by_local_name: localNames,
  has_provenance_tool: toolNames.some((n) => n.includes('provenance')),
  has_decision_write_tool: localNames.some((n) => ['record_decision', 'add_decision'].includes(n)),
  summary_before: summaryBefore,
  add_entity: addResult,
  query_graph: queryResult,
  summary_after: summaryAfter,
  query_decisions: decisionQuery,
  record_decision: recordDecision,
  rest_retrieve_mcp_entity: restRetrieve,
  rest_graph_summary: restHealth?.graph,
  error,
};
writeFileSync(`${OUT_DIR}/mcp-run.json`, JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({
  tools: toolNames,
  has_provenance_tool: artifact.has_provenance_tool,
  has_decision_write_tool: artifact.has_decision_write_tool,
  summary_before: summaryBefore,
  add_entity: addResult,
  summary_after: summaryAfter,
  error,
}, null, 2));
await client.disconnect();
