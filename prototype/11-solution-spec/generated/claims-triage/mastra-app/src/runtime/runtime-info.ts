// PROTOTYPE — generated skeleton.
// Source: solution.lock#/runtime + contracts/schemas/runtime-info.schema.json
export const runtimeInfo = {
  contract_version: '1.0.0',
  service: 'mastra-app',
  service_version: '0.1.0',
  graph_schema_version: '1',
  audit_schema_version: '1',
  backend: { graph: 'embedded', audit: 'sqlite' },
  capabilities: ['runs', 'streaming', 'approvals', 'otel'],
  limits: {
    max_nodes: 10000,
    max_edges: 50000,
    max_request_timeout_ms: 30000,
    max_run_deadline_ms: 300000,
  },
  components: [
    { name: 'mastra-app', version: '0.1.0', contract_version: '1.0.0', status: 'ready' },
    { name: 'context-service', version: '0.1.0', contract_version: '1.0.0', status: 'ready', schema_version: '1' },
  ],
  started_at: new Date().toISOString(),
} as const;
