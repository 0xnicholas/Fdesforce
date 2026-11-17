import type { ModelProfileSpec, Tool, Workflow, WorkflowStep } from '@fde/spec';
import { GENERATED_FILE_MODE, canonicalJsonFile, sortedFiles } from '@fde/runtime-generator';
import type { GeneratedFile, RuntimeGenerateInput } from '@fde/runtime-generator';

import { BUILTIN_TOOLS, RETRIEVAL } from './builtins.js';
import type { PlatformField } from './builtins.js';
import { APP_DIR, APP_PORT } from './deployment.js';
import { generatedHeader } from './generated.js';
import { identityModule, rolesModule } from './identity.js';
import { runtimeInfoModule } from './runtime-info.js';
import {
  canonicalModule,
  configModule,
  contextClientModule,
  errorsModule,
  executionContextModule,
  idsModule,
  migrateModule,
  routerModule,
  runRegistryModule,
  runServiceModule,
  sseModule,
  stateStoreModule,
  wireModule,
} from './run-runtime.js';
import { identifier, jsonLiteral, moduleName, schemaExportName, singleQuoted, templateLiteral } from './naming.js';

/**
 * `generateApp`: the mastra-app source tree for the read-only slice.
 *
 * Everything here is a pure function of the build input — no clock, no random
 * ids, no environment read, no disk, no network (A11). Versions come from the
 * lock (`node`), from the Runtime Profile (`@mastra/core`) and from the Model
 * Profiles (provider, model version, params); nothing is a constant in this file.
 *
 * The tree is meant to be reviewed: every module opens with the Spec construct it
 * came from, and the same input always produces the same bytes in the same order.
 */

// `APP_PORT` and `APP_DIR` are shared with the topology fragment: one deployment
// shape, two artifacts (see `deployment.ts`).
export { APP_DIR, APP_PORT } from './deployment.js';

/** The single Dockerfile the tree carries; `GeneratedApp.dockerfile` points at it. */
export const DOCKERFILE_PATH = `${APP_DIR}/Dockerfile`;

const APP_ENTRYPOINT = ['node', '--experimental-strip-types', 'src/index.ts'] as const;

const OPEN_OBJECT = { type: 'object', additionalProperties: true } as const;

/** The un-pinned shape used where the Spec declares no output schema. */
const OPEN_OUTPUT = 'openOutputSchema';

export function appPackageName(input: RuntimeGenerateInput): string {
  return `@${input.spec.metadata.customer}-fde/${input.spec.metadata.solution}-mastra-app`;
}

/**
 * The app's dependency set is the Runtime Profile's package set: the profile
 * describes the generated app, so adding a package to the app is a platform
 * decision with a version pin and a content address, not a generator constant.
 */
export function appDependencies(input: RuntimeGenerateInput): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input.profile.spec.packages)
      .filter(([name]) => name !== 'node' && name !== 'python')
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
}

/** A step's declared output schema. `approval` steps carry none; the gate rejects them anyway. */
const stepOutputSchema = (step: WorkflowStep): string | undefined =>
  step.type === 'approval' ? undefined : step.outputSchema;

interface ModelBinding {
  id: string;
  settings: Record<string, unknown>;
  reference: string;
}

/** `provider/model` plus baked params, from the Model Profile the Agent pins. */
function modelBindings(input: RuntimeGenerateInput): Map<string, ModelBinding> {
  const bindings = new Map<string, ModelBinding>();

  for (const [agentId, agent] of Object.entries(input.spec.spec.agents ?? {})) {
    const name = agent.modelProfile.slice(0, Math.max(0, agent.modelProfile.lastIndexOf('@')));
    const profile = input.modelProfiles?.[name];
    if (profile === undefined) {
      throw new Error(
        `agent ${agentId} pins Model Profile ${name}, which the build input did not resolve; the CLI resolves it before generation`,
      );
    }
    bindings.set(agentId, {
      id: `${profile.spec.provider}/${profile.spec.model}`,
      settings: modelSettings(profile.spec.params),
      reference: `${profile.metadata.name}@${profile.metadata.version}`,
    });
  }

  return bindings;
}

/** Model Profile params in the vocabulary the runtime's model call uses. */
function modelSettings(params: ModelProfileSpec['params'] = {}): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (params.temperature !== undefined) settings['temperature'] = params.temperature;
  if (params.topP !== undefined) settings['topP'] = params.topP;
  if (params.maxOutputTokens !== undefined) settings['maxOutputTokens'] = params.maxOutputTokens;
  if (params.seed !== undefined) settings['seed'] = params.seed;
  if (params.stop !== undefined) settings['stopSequences'] = params.stop;
  return settings;
}

/** Tools the app can reach: an Agent uses them, or a workflow step calls them. */
function reachableTools(input: RuntimeGenerateInput): string[] {
  const used = new Set<string>();
  for (const agent of Object.values(input.spec.spec.agents ?? {})) {
    for (const tool of agent.tools ?? []) used.add(tool);
  }
  for (const workflow of Object.values(input.spec.spec.workflows ?? {})) {
    for (const step of workflow.steps) {
      if (step.type === 'tool') used.add(step.tool);
    }
  }
  return [...used].sort();
}

/** Spec JSON Schema files the tree bakes into modules. */
function referencedSchemas(input: RuntimeGenerateInput, tools: ReadonlyArray<string>): string[] {
  const referenced = new Set<string>();
  const add = (path: string | undefined): void => {
    if (path !== undefined) referenced.add(path);
  };

  for (const name of tools) {
    const tool = input.spec.spec.tools?.[name];
    if (tool?.connectorRef !== undefined) {
      add(tool.inputSchema);
      add(tool.outputSchema);
    }
  }
  for (const workflow of Object.values(input.spec.spec.workflows ?? {})) {
    for (const step of workflow.steps) add(stepOutputSchema(step));
  }

  return [...referenced].sort();
}

function readSpecFile(input: RuntimeGenerateInput, specPath: string): string {
  const body = input.files?.[specPath];
  if (body === undefined) {
    throw new Error(
      `the Spec pins ${specPath}, but the build input did not carry it; the CLI resolves solution.lock.spec.files before generation`,
    );
  }
  return body;
}

/** The whole tree, sorted by path. */
export function generateAppFiles(input: RuntimeGenerateInput, generatorVersion: string): GeneratedFile[] {
  const tools = reachableTools(input);
  const schemas = referencedSchemas(input, tools);
  const models = modelBindings(input);

  const files: GeneratedFile[] = [
    dockerfile(input, generatorVersion),
    packageJson(input),
    tsconfig(),
    ...Object.keys(input.spec.spec.agents ?? {})
      .sort()
      .map((agentId) => agentModule(input, agentId, generatorVersion, models)),
    indexModule(generatorVersion),
    mastraModule(input, generatorVersion),
    executionContextModule(generatorVersion),
    contextClientModule(generatorVersion),
    retrievalModule(generatorVersion),
    idsModule(generatorVersion),
    canonicalModule(generatorVersion),
    wireModule(generatorVersion),
    errorsModule(generatorVersion),
    sseModule(generatorVersion),
    configModule(
      generatorVersion,
      APP_PORT,
      input.spec.metadata.customer,
      input.spec.metadata.solution,
      input.environment.name,
    ),
    stateStoreModule(generatorVersion, input.profile.spec.capabilities.stateStore.schemaVersion),
    rolesModule(generatorVersion),
    identityModule(generatorVersion),
    runtimeInfoModule(input, generatorVersion),
    runRegistryModule(generatorVersion),
    runServiceModule(input, generatorVersion),
    routerModule(generatorVersion),
    migrateModule(generatorVersion),
    ...schemas.map((specPath) => schemaModule(input, specPath, generatorVersion)),
    ...tools.map((name) => toolModule(input, name, generatorVersion)),
    ...Object.keys(input.spec.spec.workflows ?? {})
      .sort()
      .map((workflowId) => workflowModule(input, workflowId, generatorVersion)),
  ];

  return sortedFiles(files);
}

export const entrypoint = (): string[] => [...APP_ENTRYPOINT];

// --- build files ------------------------------------------------------------

function packageJson(input: RuntimeGenerateInput): GeneratedFile {
  return {
    path: `${APP_DIR}/package.json`,
    mode: GENERATED_FILE_MODE,
    content: canonicalJsonFile({
      name: appPackageName(input),
      private: true,
      type: 'module',
      engines: { node: input.lock.runtime.node },
      dependencies: appDependencies(input),
      scripts: { start: APP_ENTRYPOINT.join(' ') },
    }),
  };
}

function tsconfig(): GeneratedFile {
  return {
    path: `${APP_DIR}/tsconfig.json`,
    mode: GENERATED_FILE_MODE,
    content: canonicalJsonFile({
      // Typecheck-only. The app runs its sources through Node's type stripping, so
      // there is no build step to keep deterministic, and `erasableSyntaxOnly`
      // makes the compiler prove the sources are strippable.
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noUncheckedIndexedAccess: true,
        verbatimModuleSyntax: true,
        erasableSyntaxOnly: true,
        allowImportingTsExtensions: true,
        noEmit: true,
        skipLibCheck: true,
        types: ['node'],
      },
      include: ['src/**/*.ts'],
    }),
  };
}

function dockerfile(input: RuntimeGenerateInput, generatorVersion: string): GeneratedFile {
  const node = input.lock.runtime.node;
  const profile = `${input.profile.metadata.name}@${input.profile.metadata.version}`;
  const command = `[${APP_ENTRYPOINT.map((part) => JSON.stringify(part)).join(', ')}]`;

  return {
    path: DOCKERFILE_PATH,
    mode: GENERATED_FILE_MODE,
    content: [
      `# Generated by @fde/runtime-generator-mastra ${generatorVersion} — do not hand-edit.`,
      `# Source: solution.lock#/runtime (node ${node}) + Runtime Profile ${profile}`,
      '#',
      "# The app runs its TypeScript sources through Node's type stripping, so the image",
      '# installs the Runtime Profile package set and no compiler. The Profile pins no',
      "# compiler, so `tsc --noEmit` over these sources is the workbench's compile check",
      '# (`@fde/runtime-generator-mastra`), not a build step in this image.',
      `FROM node:${node}-bookworm-slim`,
      'WORKDIR /app',
      'ENV NODE_ENV=production',
      'COPY package.json ./',
      'RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund',
      'COPY src ./src',
      'USER node',
      `EXPOSE ${APP_PORT}`,
      `CMD ${command}`,
      '',
    ].join('\n'),
  };
}

// --- runtime modules --------------------------------------------------------

function indexModule(generatorVersion: string): GeneratedFile {
  return {
    path: `${APP_DIR}/src/index.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      generatedHeader(generatorVersion, 'solution.yaml#/metadata + docs/runtime-contract.md §5.4, §7.5, §9.2'),
      '// The generated entrypoint: open the state store, check it was migrated, resolve the',
      '// deployment\'s identity, run the startup handshake, then build the registry and the',
      '// executor and serve the Run API. A build that cannot open its store or cannot sign an',
      '// ExecutionContext exits non-zero instead of serving a Run API it can never complete',
      '// (A6, A8); a handshake that fails does *not* exit — it serves `/readyz` 503 with the',
      '// reason and refuses every Run, which is the difference between a deployment that',
      '// looks healthy and one an operator can debug (§9.3).',
      "import { mastra } from './mastra.ts';",
      "import { loadConfig, loadIdentityEnv } from './runtime/config.ts';",
      "import { IdentityConfigError, createExecutionContextIssuer, loadIdentity } from './runtime/identity.ts';",
      "import { createRuntimeServer } from './runtime/router.ts';",
      "import { handshake, readiness } from './runtime/runtime-info.ts';",
      "import { CAPABILITY_IDS, createRunExecutor } from './runtime/run-service.ts';",
      "import { RunRegistry } from './runtime/run-registry.ts';",
      "import { STATE_SCHEMA_VERSION, StateStore } from './runtime/state-store.ts';",
      '',
      'const config = loadConfig();',
      'const store = new StateStore(config.stateStorePath);',
      '',
      '// The runtime-migrate job owns the schema (§9.2). Verifying it here is what makes a',
      '// missing or mismatched store a startup failure rather than a silent empty registry.',
      'const schema = store.schemaVersion();',
      'if (schema !== STATE_SCHEMA_VERSION) {',
      '  console.error(',
      '    `mastra-app: the state store at ${config.stateStorePath} is at schema \'${schema === \'\' ? \'unmigrated\' : schema}\', expected ${STATE_SCHEMA_VERSION}; run the runtime-migrate job first`,',
      '  );',
      '  process.exit(1);',
      '}',
      '',
      '// Identity comes from the injected environment (§5.4): the `mastra-app` issuer key and',
      '// the static identity source are mounted, never baked. Failing here — not at the first',
      '// Run — is the difference between a deployment that looks healthy and one that can',
      '// actually call context-service. The message names the setting, never a value.',
      '// The issuer is built here too: it resolves the default subject out of the profile,',
      '// so a profile this app cannot mint from is a startup failure like any other.',
      'function resolveIssuer() {',
      '  try {',
      '    return createExecutionContextIssuer(loadIdentity(loadIdentityEnv()));',
      '  } catch (error) {',
      '    console.error(`mastra-app: ${error instanceof IdentityConfigError ? error.message : String(error)}`);',
      '    process.exit(1);',
      '  }',
      '}',
      '',
      'const issue = resolveIssuer();',
      '',
      '// The second handshake (§9.3). It runs before the listener binds, so a Run can never',
      '// arrive in the window between "the process started" and "the runtime proved it is the',
      '// build the lock describes". A failure is reported, not thrown: the process has to stay',
      '// up for `/readyz` and `/v1/runtime-info` to say what went wrong.',
      'const runtimeInfo = await handshake({ baseUrl: config.contextServiceUrl });',
      'for (const failure of runtimeInfo.ready ? [] : runtimeInfo.failures) {',
      '  console.error(`mastra-app: handshake refused this deployment (${failure.code}/${failure.reason}): ${failure.message}`);',
      '}',
      'const report = readiness(runtimeInfo);',
      'for (const reason of report.reasons) console.error(`mastra-app: readyz ${report.status}: ${reason}`);',
      '',
      'const registry = new RunRegistry({',
      '  store,',
      '  tenantId: config.tenantId,',
      '  runDeadlineMs: config.runDeadlineMs,',
      '  heartbeatIntervalMs: config.heartbeatIntervalMs,',
      '});',
      '',
      'const server = createRuntimeServer({',
      '  registry,',
      '  tenantId: config.tenantId,',
      '  capabilities: CAPABILITY_IDS,',
      '  execute: createRunExecutor({ registry, issue }),',
      '  runtimeInfo,',
      '});',
      '',
      '// The topology exposes this port to the ingress; `FDE_PORT` is a local override,',
      '// not a deployment knob (the renderer maps container port to host port). `FDE_PORT=0`',
      '// asks the OS for one, which is what a smoke test on a shared box wants.',
      'server.listen(config.port, () => {',
      '  const address = server.address();',
      '  const port = typeof address === \'object\' && address !== null ? address.port : config.port;',
      '  console.log(',
      '    `mastra-app listening on :${port} (${report.status}; workflows: ${Object.keys(mastra.listWorkflows()).sort().join(\', \')})`,',
      '  );',
      '});',
      '',
      'const shutdown = (signal: string): void => {',
      '  console.log(`mastra-app: ${signal}, shutting down`);',
      '  server.close(() => {',
      '    registry.close();',
      '    store.close();',
      '    process.exit(0);',
      '  });',
      '};',
      '',
      "process.on('SIGTERM', () => shutdown('SIGTERM'));",
      "process.on('SIGINT', () => shutdown('SIGINT'));",
      '',
    ].join('\n'),
  };
}

function mastraModule(input: RuntimeGenerateInput, generatorVersion: string): GeneratedFile {
  const agents = Object.keys(input.spec.spec.agents ?? {}).sort();
  const workflows = Object.keys(input.spec.spec.workflows ?? {}).sort();

  return {
    path: `${APP_DIR}/src/mastra.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      generatedHeader(generatorVersion, 'solution.yaml#/spec/agents + solution.yaml#/spec/workflows'),
      "import { Mastra } from '@mastra/core/mastra';",
      '',
      ...agents.map((agentId) => `import { ${identifier(agentId)} } from './agents/${agentId}.ts';`),
      ...workflows.map((workflowId) => `import { ${identifier(workflowId)} } from './workflows/${workflowId}.ts';`),
      '',
      '/**',
      ' * The generated Mastra instance: the Agents and workflows the Run executor runs.',
      ' * Run state is the generated SQLite registry (`runtime/state-store.ts`), because',
      ' * the Runtime Profile pins no storage provider; this instance is the composition',
      ' * root, not a second source of runtime state.',
      ' */',
      'export const mastra = new Mastra({',
      `  agents: { ${agents.map(identifier).join(', ')} },`,
      `  workflows: { ${workflows.map(identifier).join(', ')} },`,
      '});',
      '',
    ].join('\n'),
  };
}

function agentModule(
  input: RuntimeGenerateInput,
  agentId: string,
  generatorVersion: string,
  models: Map<string, ModelBinding>,
): GeneratedFile {
  const agent = (input.spec.spec.agents ?? {})[agentId];
  if (agent === undefined) throw new Error(`agent ${agentId} is not declared`);
  if (agent.instructions === undefined) {
    throw new Error(`agent ${agentId} declares no instructions; a generated Agent cannot invent its prompt`);
  }

  const model = models.get(agentId);
  if (model === undefined) throw new Error(`agent ${agentId} has no resolved Model Profile`);

  const instructions = readSpecFile(input, agent.instructions);
  const tools = (agent.tools ?? []).slice().sort();
  const settings = Object.keys(model.settings).length === 0 ? [] : [
    '  defaultOptions: {',
    `    modelSettings: ${jsonLiteral(model.settings, 6)},`,
    '  },',
  ];

  return {
    path: `${APP_DIR}/src/agents/${agentId}.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      generatedHeader(generatorVersion, `solution.yaml#/spec/agents/${agentId} + ${agent.instructions}`),
      "import { Agent } from '@mastra/core/agent';",
      '',
      ...tools.map((name) => `import { ${identifier(name)} } from '../tools/${name}.ts';`),
      '',
      '/**',
      ` * Model Profile \`${model.reference}\`, pinned by solution.lock: provider, immutable`,
      ' * model version and params are baked here. An Environment supplies the endpoint',
      ' * and the secret, never the model.',
      ' */',
      `export const ${identifier(agentId)} = new Agent({`,
      `  id: '${agentId}',`,
      // The Spec has no display name for an Agent, so the authored id is the only label.
      `  name: '${agentId}',`,
      `  instructions: \`${templateLiteral(instructions.replace(/\n$/, ''))}\`,`,
      `  model: '${model.id}',`,
      ...settings,
      `  tools: { ${tools.map(identifier).join(', ')} },`,
      '});',
      '',
    ].join('\n'),
  };
}

function toolModule(input: RuntimeGenerateInput, name: string, generatorVersion: string): GeneratedFile {
  const tool = input.spec.spec.tools?.[name];
  if (tool === undefined) throw new Error(`tool ${name} is not declared`);

  const exported = identifier(name);
  const shared = [
    generatedHeader(generatorVersion, `solution.yaml#/spec/tools/${name}`),
    "import { createTool } from '@mastra/core/tools';",
    '',
    "import { sha256Digest } from '../runtime/canonical.ts';",
    "import { contextClient } from '../runtime/context-client.ts';",
    "import { runContext, type RunContext } from '../runtime/execution-context.ts';",
  ];

  if (tool.builtin !== undefined) {
    const builtin = BUILTIN_TOOLS[tool.builtin];
    if (builtin === undefined) throw new Error(`builtin ${tool.builtin} is not published by this generator`);
    return {
      path: `${APP_DIR}/src/tools/${name}.ts`,
      mode: GENERATED_FILE_MODE,
      content: [
        ...shared,
        "import type { RetrieveRequest } from '../runtime/retrieval.ts';",
        "import { retrieveRequestSchema, retrieveResponseSchema } from '../runtime/retrieval.ts';",
        '',
        '/**',
        ` * Builtin read-only Tool \`${tool.builtin}\`: the platform owns the implementation and`,
        ' * its schemas, so the Spec carries neither (`prototype/11-solution-spec/GAPS.md` GAP-1).',
        ' */',
        `export const ${exported} = createTool({`,
        `  id: '${name}',`,
        `  description: ${singleQuoted(builtin.description)},`,
        '  inputSchema: retrieveRequestSchema,',
        '  outputSchema: retrieveResponseSchema,',
        `  execute: async (inputData, context) =>`,
        `    ${exported}Run(inputData, runContext(context.requestContext, context.abortSignal)),`,
        '});',
        '',
        '/**',
        ' * The Tool body, callable from a workflow step without a Mastra tool context.',
        ' * Progress is published on the Run stream (§7.5): a Tool the client cannot see',
        ' * is a Tool whose latency looks like a hung Run.',
        ' */',
        `export async function ${exported}Run(input: unknown, context: RunContext) {`,
        `  context.emit?.('tool.call', { tool: '${name}', input_digest: sha256Digest(input) });`,
        '  const result = await contextClient.retrieve(context, input as RetrieveRequest);',
        `  context.emit?.('tool.result', { tool: '${name}', output_digest: sha256Digest(result) });`,
        '  return result;',
        '}',
        '',
      ].join('\n'),
    };
  }

  const inputSchema = tool.inputSchema;
  const outputSchema = tool.outputSchema;
  if (inputSchema === undefined || outputSchema === undefined) {
    throw new Error(
      `connector-backed Tool ${name} declares no ${inputSchema === undefined ? 'inputSchema' : 'outputSchema'}; the typed operation seam needs both`,
    );
  }

  return {
    path: `${APP_DIR}/src/tools/${name}.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      ...shared,
      `import { ${schemaExportName(inputSchema)} } from '../schemas/${moduleName(inputSchema)}.ts';`,
      `import { ${schemaExportName(outputSchema)} } from '../schemas/${moduleName(outputSchema)}.ts';`,
      '',
      '/**',
      ` * Connector-backed read-only Tool: \`${tool.connectorRef}.${tool.operation}\` is a typed`,
      ' * operation reached through context-service. The app never opens a customer',
      ' * database itself (#17 D6).',
      ' */',
      `export const ${exported} = createTool({`,
      `  id: '${name}',`,
      `  description: 'Read through the ${tool.connectorRef} Connector operation ${tool.operation}.',`,
      `  inputSchema: ${schemaExportName(inputSchema)},`,
      `  outputSchema: ${schemaExportName(outputSchema)},`,
      `  execute: async (inputData, context) =>`,
      `    ${exported}Run(inputData, runContext(context.requestContext, context.abortSignal)),`,
      '});',
      '',
      '/** The Tool body, callable from a workflow step without a Mastra tool context. */',
      `export async function ${exported}Run(input: unknown, context: RunContext) {`,
      `  context.emit?.('tool.call', { tool: '${name}', input_digest: sha256Digest(input) });`,
      '  const result = await contextClient.connectorOperation(context, {',
      `    connector_id: '${tool.connectorRef}',`,
      `    operation: '${tool.operation}',`,
      '    input: input as Record<string, unknown>,',
      '  });',
      `  context.emit?.('tool.result', { tool: '${name}', output_digest: sha256Digest(result) });`,
      '  return result;',
      '}',
      '',
    ].join('\n'),
  };
}

function interfaceOf(name: string, fields: ReadonlyArray<PlatformField>, doc: string): string {
  return [
    `/** ${doc} */`,
    `export interface ${name} {`,
    ...fields.map((field) => {
      const property = `  ${field.name}${field.optional === true ? '?' : ''}: ${field.type};`;
      return field.doc === undefined ? property : `${property} /** ${field.doc} */`;
    }),
    '}',
    '',
  ].join('\n');
}

function retrievalModule(generatorVersion: string): GeneratedFile {
  return {
    path: `${APP_DIR}/src/runtime/retrieval.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      generatedHeader(generatorVersion, 'contracts/context-service-v1.openapi.yaml → schemas/retrieval.schema.json'),
      "import type { PublicSchema } from '@mastra/core/schema';",
      '',
      '// Wire names stay snake_case: this is the context-service boundary, and the',
      '// contract is the vocabulary both sides speak. The JSON Schema is the contract',
      '// (`test/contract-drift.test.ts` compares it property by property); the',
      '// interfaces are its TypeScript view.',
      '',
      interfaceOf('RetrievalItem', RETRIEVAL.item.fields, 'One retrieved fact, with the citation an answer must carry.'),
      interfaceOf('RetrieveSubject', RETRIEVAL.subject.fields, 'Who the retrieval runs as.'),
      interfaceOf('RetrieveBudget', RETRIEVAL.budget.fields, 'How much one recipe call may spend.'),
      interfaceOf('RetrieveBudgetUsed', RETRIEVAL.budgetUsed.fields, 'What the recipe actually spent.'),
      interfaceOf('PolicyEvaluation', RETRIEVAL.policyEvaluation.fields, 'A policy the retrieval pipeline evaluated.'),
      interfaceOf('RetrieveRequest', RETRIEVAL.request.fields, '`POST /v1/context/retrieve`.'),
      interfaceOf('RetrieveResponse', RETRIEVAL.response.fields, 'The Retrieval Snapshot a Run records and cites.'),
      `export const retrieveRequestSchema: PublicSchema = ${jsonLiteral(RETRIEVAL.request.schema)};`,
      '',
      `export const retrieveResponseSchema: PublicSchema = ${jsonLiteral(RETRIEVAL.response.schema)};`,
      '',
    ].join('\n'),
  };
}

function schemaModule(input: RuntimeGenerateInput, specPath: string, generatorVersion: string): GeneratedFile {
  const digest = input.lock.spec.files[specPath];
  const body = readSpecFile(input, specPath);
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${specPath} is not a JSON Schema object, so the generated Tool has no contract to carry`);
  }

  return {
    path: `${APP_DIR}/src/schemas/${moduleName(specPath)}.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      generatedHeader(
        generatorVersion,
        `${specPath}${digest === undefined ? '' : ` (pinned by solution.lock as ${digest})`}`,
      ),
      "import type { PublicSchema } from '@mastra/core/schema';",
      '',
      '/**',
      ' * The JSON Schema is the contract: it is what the model is told the shape is and',
      ' * what validates at the Tool boundary, so it is carried verbatim rather than',
      ' * restated as a hand-written type that could drift from it.',
      ' */',
      `export const ${schemaExportName(specPath)}: PublicSchema = ${jsonLiteral(parsed)};`,
      '',
    ].join('\n'),
  };
}

/** `semantic.recipeBindings.<recipe>.budget` → the retrieval budget the contract speaks. */
function budgetOf(binding: { budget?: { maxNodes?: number; maxTokens?: number; maxHops?: number } } | undefined): Record<string, unknown> {
  const budget: Record<string, unknown> = {};
  if (binding?.budget?.maxNodes !== undefined) budget['max_nodes'] = binding.budget.maxNodes;
  if (binding?.budget?.maxTokens !== undefined) budget['max_tokens'] = binding.budget.maxTokens;
  if (binding?.budget?.maxHops !== undefined) budget['max_hops'] = binding.budget.maxHops;
  return budget;
}

/** One workflow step, resolved once: its identifier and the schema constants it needs. */
interface StepPlan {
  /** Never an `approval` step: the gate refuses those before generation. */
  step: Exclude<WorkflowStep, { type: 'approval' }>;
  constName: string;
  outputSchema: string;
  /** The Spec file that schema came from, when it came from one. */
  schemaPath?: string;
}

/** Steps the emitter will write, in declared order. The gate has already refused `approval`. */
function planSteps(workflow: Workflow, tools: Record<string, Tool>): StepPlan[] {
  return workflow.steps.flatMap((step) => {
    if (step.type === 'approval') return [];

    const declared =
      step.type === 'context' ? undefined : (step.outputSchema ?? (step.type === 'tool' ? tools[step.tool]?.outputSchema : undefined));
    const outputSchema =
      step.type === 'context' ? 'retrieveResponseSchema' : declared === undefined ? OPEN_OUTPUT : schemaExportName(declared);

    return [{ step, constName: `${identifier(step.id)}Step`, outputSchema, ...(declared === undefined ? {} : { schemaPath: declared }) }];
  });
}

function workflowModule(
  input: RuntimeGenerateInput,
  workflowId: string,
  generatorVersion: string,
): GeneratedFile {
  const workflow = (input.spec.spec.workflows ?? {})[workflowId] as Workflow;
  const recipes = input.spec.spec.semantic?.recipeBindings ?? {};
  const tools = input.spec.spec.tools ?? {};
  const plans = planSteps(workflow, tools);

  const usedAgents = [...new Set(plans.flatMap(({ step }) => (step.type === 'agent' ? [step.agent] : [])))].sort();
  const usedTools = [...new Set(plans.flatMap(({ step }) => (step.type === 'tool' ? [step.tool] : [])))].sort();
  const usedSchemas = [...new Set(plans.flatMap(({ schemaPath }) => (schemaPath === undefined ? [] : [schemaPath])))].sort();
  const openOutputUsed = plans.some((plan) => plan.outputSchema === OPEN_OUTPUT);

  const stepBlocks: string[] = [];
  let upstream = 'workflowInputSchema';

  for (const { step, constName, outputSchema } of plans) {
    if (step.type === 'context') {
      stepBlocks.push(
        [
          `const ${constName} = createStep({`,
          `  id: '${step.id}',`,
          `  inputSchema: ${upstream},`,
          '  outputSchema: retrieveResponseSchema,',
          '  execute: async ({ inputData, requestContext, abortSignal }) => {',
          '    const { query, ...filters } = inputData as WorkflowInput;',
          '    return contextClient.retrieve(runContext(requestContext, abortSignal), {',
          `      recipe_id: '${step.recipe}',`,
          '      query,',
          '      filters,',
          `      budget: ${jsonLiteral(budgetOf(recipes[step.recipe]), 6)},`,
          '    });',
          '  },',
          '});',
        ].join('\n'),
      );
      upstream = 'retrieveResponseSchema';
      continue;
    }

    if (step.type === 'agent') {
      stepBlocks.push(
        [
          `const ${constName} = createStep({`,
          `  id: '${step.id}',`,
          `  inputSchema: ${upstream},`,
          `  outputSchema: ${outputSchema},`,
          '  execute: async ({ inputData, requestContext, abortSignal }) => {',
          "    // The retrieved context is the agent's only evidence: the prompt carries the",
          '    // snapshot id, the degraded flag and every item, in retrieval order.',
          '    const context = inputData as RetrieveResponse;',
          '    const evidence = context.items',
          '      .map((item) => `${item.entity_id} [${item.source_ref}@${item.version}]: ${item.content}`)',
          "      .join('\\n');",
          '    const prompt = [',
          '      `Retrieval ${context.retrieval_id} (snapshot ${context.snapshot_digest}, degraded=${context.degraded}${',
          "        context.reason === undefined ? '' : `, reason=${context.reason}`",
          '      }).`,',
          "      evidence.length === 0 ? 'No context was retrieved.' : evidence,",
          "    ].join('\\n\\n');",
          `    const result = await ${identifier(step.agent)}.generate(prompt, {`,
          `      structuredOutput: { schema: ${outputSchema} },`,
          '      requestContext,',
          '      abortSignal,',
          '    });',
          '    return result.object;',
          '  },',
          '});',
        ].join('\n'),
      );
      upstream = outputSchema;
      continue;
    }

    // `tool`: a read-only Tool called with the upstream step's output. The Spec has no
    // per-step input mapping yet, so the previous step's output is the input.
    stepBlocks.push(
      [
        `const ${constName} = createStep({`,
        `  id: '${step.id}',`,
        `  inputSchema: ${upstream},`,
        `  outputSchema: ${outputSchema},`,
        '  execute: async ({ inputData, requestContext, abortSignal }) =>',
        `    ${identifier(step.tool)}Run(inputData, runContext(requestContext, abortSignal)),`,
        '});',
      ].join('\n'),
    );
    upstream = outputSchema;
  }

  const chain = plans.map(({ constName }) => `.then(${constName})`).join('\n  ');
  const imports = [
    "import type { PublicSchema } from '@mastra/core/schema';",
    "import { createStep, createWorkflow } from '@mastra/core/workflows';",
    '',
    ...[
      ...usedAgents.map((agentId) => `import { ${identifier(agentId)} } from '../agents/${agentId}.ts';`),
      "import { contextClient } from '../runtime/context-client.ts';",
      "import { runContext } from '../runtime/execution-context.ts';",
      "import type { RetrieveResponse } from '../runtime/retrieval.ts';",
      "import { retrieveResponseSchema } from '../runtime/retrieval.ts';",
      ...usedSchemas.map((path) => `import { ${schemaExportName(path)} } from '../schemas/${moduleName(path)}.ts';`),
      ...usedTools.map((name) => `import { ${identifier(name)}Run } from '../tools/${name}.ts';`),
    ].sort(),
  ];

  return {
    path: `${APP_DIR}/src/workflows/${workflowId}.ts`,
    mode: GENERATED_FILE_MODE,
    content: [
      generatedHeader(generatorVersion, `solution.yaml#/spec/workflows/${workflowId}`),
      ...imports,
      '',
      '/**',
      ' * The Run input: the retrieval query plus whatever filters the bound recipe',
      ' * understands (`RunCreateRequest.input` is an open object). Everything but',
      ' * `query` reaches context-service as a filter.',
      ' */',
      'interface WorkflowInput {',
      '  query: string;',
      '  [key: string]: unknown;',
      '}',
      '',
      'const workflowInputSchema: PublicSchema = {',
      "  type: 'object',",
      "  required: ['query'],",
      "  properties: { query: { type: 'string', minLength: 1, maxLength: 8000 } },",
      '  additionalProperties: true,',
      '};',
      ...(openOutputUsed ? ['', `const ${OPEN_OUTPUT}: PublicSchema = ${jsonLiteral(OPEN_OBJECT)};`] : []),
      '',
      ...stepBlocks.flatMap((block) => [block, '']),
      `export const ${identifier(workflowId)} = createWorkflow({`,
      `  id: '${workflowId}',`,
      '  inputSchema: workflowInputSchema,',
      `  outputSchema: ${upstream},`,
      '})',
      `  ${chain}`,
      '  .commit();',
      '',
    ].join('\n'),
  };
}
