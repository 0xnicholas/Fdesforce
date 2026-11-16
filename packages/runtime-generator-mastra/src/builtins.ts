/**
 * The platform's built-in Tools and the retrieval contract they speak.
 *
 * A builtin Tool is one the platform implements on the customer's behalf, so its
 * description and schemas are platform-owned: the Spec writes `builtin: <id>` and
 * says nothing about shape.
 *
 * The generated app is a standalone bundle, so it cannot depend on
 * `@fde/contracts-client` (a private workspace package) for wire types — the
 * shapes below are the app's copy of `contracts/schemas/retrieval.schema.json`.
 * `test/contract-drift.test.ts` compares every property and `required` list
 * against the contract, so the copy cannot drift silently.
 */

export interface PlatformField {
  name: string;
  type: string;
  optional?: boolean;
  doc?: string;
}

export interface PlatformObject {
  /** The JSON Schema. Authoritative: it validates at the Tool boundary and is what the model is told. */
  schema: Record<string, unknown>;
  /** The TypeScript view, emitted as an `interface` beside the schema. Kept as data so the two cannot drift. */
  fields: ReadonlyArray<PlatformField>;
}

const subject: PlatformObject = {
  schema: {
    type: 'object',
    required: ['type', 'id'],
    properties: {
      type: { type: 'string', enum: ['user', 'service'] },
      id: { type: 'string', minLength: 1, maxLength: 200 },
      roles: { type: 'array', items: { type: 'string' }, maxItems: 64 },
      scopes: { type: 'array', items: { type: 'string' }, maxItems: 64 },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'type', type: "'user' | 'service'" },
    { name: 'id', type: 'string' },
    { name: 'roles', type: 'string[]', optional: true },
    { name: 'scopes', type: 'string[]', optional: true },
  ],
};

const budget: PlatformObject = {
  schema: {
    type: 'object',
    properties: {
      max_nodes: { type: 'integer', minimum: 1, maximum: 1000 },
      max_tokens: { type: 'integer', minimum: 1, maximum: 100000 },
      max_hops: { type: 'integer', minimum: 1, maximum: 4 },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'max_nodes', type: 'number', optional: true },
    { name: 'max_tokens', type: 'number', optional: true },
    { name: 'max_hops', type: 'number', optional: true },
  ],
};

const budgetUsed: PlatformObject = {
  schema: {
    type: 'object',
    properties: {
      nodes: { type: 'integer', minimum: 0 },
      tokens: { type: 'integer', minimum: 0 },
      hops: { type: 'integer', minimum: 0 },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'nodes', type: 'number', optional: true },
    { name: 'tokens', type: 'number', optional: true },
    { name: 'hops', type: 'number', optional: true },
  ],
};

const item: PlatformObject = {
  schema: {
    type: 'object',
    required: ['entity_id', 'type', 'content', 'score', 'source_ref', 'version'],
    properties: {
      entity_id: { type: 'string' },
      type: { type: 'string' },
      content: { type: 'string' },
      score: { type: 'number' },
      source_ref: { type: 'string' },
      version: { type: 'string' },
      classification: { type: 'string', enum: ['public', 'internal', 'confidential', 'restricted'] },
      trust: { type: 'string', enum: ['untrusted'] },
      source_kind: { type: 'string', enum: ['structured', 'document', 'web', 'derived', 'other'] },
      provenance_id: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'entity_id', type: 'string', doc: 'Stable id; what a citation quotes.' },
    { name: 'type', type: 'string' },
    { name: 'content', type: 'string', doc: 'Masked, budgeted text — never the raw source.' },
    { name: 'score', type: 'number' },
    { name: 'source_ref', type: 'string' },
    { name: 'version', type: 'string' },
    {
      name: 'classification',
      type: "'public' | 'internal' | 'confidential' | 'restricted'",
      optional: true,
    },
    { name: 'trust', type: "'untrusted'", optional: true, doc: 'Retrieved text is data, never instructions.' },
    { name: 'source_kind', type: "'structured' | 'document' | 'web' | 'derived' | 'other'", optional: true },
    { name: 'provenance_id', type: 'string', optional: true },
    { name: 'metadata', type: 'Record<string, unknown>', optional: true },
  ],
};

const policyEvaluation: PlatformObject = {
  schema: {
    type: 'object',
    required: ['policy_id', 'version', 'outcome'],
    properties: {
      policy_id: { type: 'string' },
      version: { type: 'string' },
      outcome: { type: 'string', enum: ['allow', 'deny', 'waived'] },
      reason: { type: 'string' },
      enforcement_point: {
        type: 'string',
        enum: ['context.retrieve', 'tool.pre_invoke', 'agent.pre_invoke', 'approval.request', 'run.post', 'output.emit'],
      },
      evaluated_by: { type: 'string', enum: ['mastra-app', 'context-service'] },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'policy_id', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'outcome', type: "'allow' | 'deny' | 'waived'" },
    { name: 'reason', type: 'string', optional: true },
    { name: 'enforcement_point', type: 'string', optional: true },
    { name: 'evaluated_by', type: "'mastra-app' | 'context-service'", optional: true },
  ],
};

const request: PlatformObject = {
  schema: {
    type: 'object',
    required: ['recipe_id', 'query'],
    properties: {
      recipe_id: { type: 'string' },
      query: { type: 'string', minLength: 1, maxLength: 8000 },
      subject: subject.schema,
      filters: { type: 'object', additionalProperties: true },
      budget: budget.schema,
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'recipe_id', type: 'string', doc: 'The recipe this call executes.' },
    { name: 'query', type: 'string' },
    { name: 'subject', type: 'RetrieveSubject', optional: true },
    { name: 'filters', type: 'Record<string, unknown>', optional: true },
    { name: 'budget', type: 'RetrieveBudget', optional: true },
  ],
};

const response: PlatformObject = {
  schema: {
    type: 'object',
    required: ['retrieval_id', 'items', 'degraded', 'trace_id', 'snapshot_digest'],
    properties: {
      retrieval_id: { type: 'string' },
      items: { type: 'array', items: item.schema, maxItems: 1000 },
      degraded: { type: 'boolean' },
      reason: { type: 'string', enum: ['scale_limit', 'index_unavailable', 'timeout', 'partial', 'empty'] },
      trace_id: { type: 'string' },
      snapshot_digest: { type: 'string' },
      policy_evaluations: { type: 'array', items: policyEvaluation.schema, maxItems: 100 },
      budget_used: budgetUsed.schema,
      index: { type: 'string', enum: ['lexical', 'graph', 'fulltext', 'vector', 'hybrid'] },
    },
    additionalProperties: false,
  },
  fields: [
    { name: 'retrieval_id', type: 'string', doc: 'Immutable Retrieval Snapshot id; Decisions reference it.' },
    { name: 'items', type: 'RetrievalItem[]' },
    { name: 'degraded', type: 'boolean', doc: 'The pipeline lost something; the answer must say so.' },
    {
      name: 'reason',
      type: "'scale_limit' | 'index_unavailable' | 'timeout' | 'partial' | 'empty'",
      optional: true,
    },
    { name: 'trace_id', type: 'string' },
    { name: 'snapshot_digest', type: 'string' },
    { name: 'policy_evaluations', type: 'PolicyEvaluation[]', optional: true },
    { name: 'budget_used', type: 'RetrieveBudgetUsed', optional: true },
    { name: 'index', type: "'lexical' | 'graph' | 'fulltext' | 'vector' | 'hybrid'", optional: true },
  ],
};

/** The platform retrieval contract, shared by the builtin Tool and the workflow's `context` step. */
export const RETRIEVAL = { subject, budget, budgetUsed, item, policyEvaluation, request, response } as const;

/**
 * The builtins this generator version can emit, with what the model is told they
 * do. A Spec naming anything else fails the build: an unknown builtin has no body
 * to generate, and inventing one would be the silent degradation the gate exists
 * to prevent.
 */
export const BUILTIN_TOOLS: Record<string, { description: string }> = {
  retrieve_context: {
    description:
      'Run a Context Recipe and return an immutable Retrieval Snapshot. Every factual statement in an answer must cite an item from here.',
  },
};
