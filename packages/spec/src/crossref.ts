import { digestFiles, digestOf } from './canonical.js';
import type { Diagnostic } from './parse.js';
import type { ModelProfile } from './schema/model-profile.js';
import type { RuntimeProfile } from './schema/runtime-profile.js';
import type { SolutionLock } from './schema/solution-lock.js';
import type {
  CapabilityBinding,
  EvidenceSelector,
  PolicyRef,
  SolutionSpec,
  Tool,
  Workflow,
  WorkflowStep,
} from './schema/solution-spec.js';

/**
 * Cross-document validation — the resolution and governance half of
 * `fde spec validate`, and the port of `prototype/11-solution-spec/inspect.rb`.
 *
 * `parse*` answers "is this document shaped correctly?". This answers "do the
 * documents agree?": every reference resolves, every build input is pinned, every
 * side-effecting Tool has evidence and coverage, and the lock is still fresh.
 *
 * Pure function: no filesystem, no network. Loaders belong to the CLI (#25).
 */

export interface PolicyTemplateView {
  metadata?: { name?: string; version?: string };
  spec?: {
    enforcementPoint?: string;
    parameters?: Record<string, { type?: string; direction?: string }>;
    predicate?: { kind?: string; parameter?: string };
  };
}

export interface ConnectorView {
  metadata?: { name?: string };
  spec?: { allowedOperations?: string[] };
}

export interface EvalSuiteView {
  metadata?: { name?: string; version?: string };
  spec?: { datasetRef?: { id?: string; version?: string; digest?: string } };
}

export interface ContextPackageView {
  manifest?: { metadata?: { name?: string; version?: string } };
  /** Context Recipes inside the package, keyed by recipe name. */
  recipes?: Record<string, { metadata?: { name?: string; version?: string } }>;
  /**
   * The frozen revision, when the package has one. A Spec may only reference a
   * frozen Context Package (`docs/semantic-modeling.md` §3.4), so its absence is
   * a build error rather than a silently mutable dependency.
   */
  revision?: { metadata?: { version?: string }; spec?: { digest?: string } };
}

export interface CheckSolutionInput {
  spec: SolutionSpec;
  lock: SolutionLock;
  /** The pinned Runtime Profile artifact; supplying it turns the pin into a verified digest. */
  runtimeProfile?: RuntimeProfile;
  /**
   * Spec-local files as text, keyed exactly like `lock.spec.files`
   * (`solution.yaml`, `files/prompts/triage.md`, …). Omit to skip freshness.
   */
  specFiles?: Record<string, string>;
  policies?: Record<string, PolicyTemplateView>;
  connectors?: Record<string, ConnectorView>;
  modelProfiles?: Record<string, ModelProfile>;
  evalSuites?: Record<string, EvalSuiteView>;
  contextPackage?: ContextPackageView;
}

export interface ValidationReport {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

interface Context {
  input: CheckSolutionInput;
  report: ValidationReport;
}

function error(report: ValidationReport, code: string, path: string, message: string, remediation?: string): void {
  report.errors.push(remediation ? { code, path, message, remediation } : { code, path, message });
}

function warn(report: ValidationReport, code: string, path: string, message: string): void {
  report.warnings.push({ code, path, message });
}

/** `name@^1.2.3` → `{ name, range }`. */
function splitRef(ref: string): { name: string; range: string } {
  const at = ref.indexOf('@');
  if (at < 0) return { name: ref, range: '' };
  return { name: ref.slice(0, at), range: ref.slice(at + 1) };
}

/** `name@1.2.3@sha256:…` → `{ name, version, digest }`. */
function splitPin(pin: string): { name: string; version: string; digest?: string } {
  const at = pin.indexOf('@');
  if (at < 0) return { name: pin, version: '' };
  return { name: pin.slice(0, at), ...splitVersionDigest(pin.slice(at + 1)) };
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => Number.parseInt(part, 10));
}

/** Range satisfaction for the forms `ArtifactRefSchema` allows. */
export function satisfiesRange(range: string, version: string): boolean {
  const pinned = versionParts(version);
  const wanted = versionParts(range.replace(/^[\^~]/, ''));
  const major = pinned[0] ?? 0;
  const minor = pinned[1] ?? 0;
  const patch = pinned[2] ?? 0;
  const [wantMajor = 0, wantMinor, wantPatch] = wanted;

  if (range.startsWith('^')) {
    if (major !== wantMajor) return false;
    if (wantMajor > 0) return true;
    if (wantMinor === undefined) return true;
    return minor === wantMinor && (wantPatch === undefined || patch >= wantPatch);
  }
  if (range.startsWith('~')) {
    return major === wantMajor && minor === (wantMinor ?? 0) && (wantPatch === undefined || patch >= wantPatch);
  }
  if (wantMinor === undefined) return major === wantMajor;
  if (wantPatch === undefined) return major === wantMajor && minor === wantMinor;
  return major === wantMajor && minor === wantMinor && patch === wantPatch;
}

function policyRefName(entry: PolicyRef): string {
  return splitRef(typeof entry === 'string' ? entry : entry.ref).name;
}

function policyRefApplies(entry: PolicyRef, toolId: string): boolean {
  if (typeof entry === 'string') return true;
  return entry.appliesTo === undefined || entry.appliesTo.includes(toolId);
}

function isSideEffecting(tool: Tool | undefined): boolean {
  return tool !== undefined && tool.sideEffects !== 'read';
}

/** Resolve a restricted dot path (`output.citedSources[0].id`) against a JSON Schema document. */
export function resolveSchemaPath(schema: unknown, path: string): unknown {
  const segments = path.replace(/^(output|input)\./, '').split('.');
  let cursor: unknown = schema;

  for (const segment of segments) {
    const [property = '', ...indices] = segment.split('[');
    cursor = childSchema(cursor, property);
    for (const _index of indices) {
      cursor = childSchema(cursor, null);
    }
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function childSchema(node: unknown, property: string | null): unknown {
  if (typeof node !== 'object' || node === null) return undefined;
  const record = node as Record<string, unknown>;
  // `null` descends an array's item schema (`a[0]`, `a[*]`).
  if (property === null) return record['items'];

  const direct = (record['properties'] as Record<string, unknown> | undefined)?.[property];
  if (direct !== undefined) return direct;
  if (record['type'] === 'array') {
    const items = record['items'] as Record<string, unknown> | undefined;
    return (items?.['properties'] as Record<string, unknown> | undefined)?.[property];
  }
  return undefined;
}

function stepIndex(workflow: Workflow, id: string): number {
  return workflow.steps.findIndex((step) => step.id === id);
}

function parseJsonFile(files: Record<string, string> | undefined, path: string): unknown {
  const text = files?.[path];
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Lock freshness and pin coverage
// ---------------------------------------------------------------------------

function checkLockFreshness({ input, report }: Context): void {
  const files = input.specFiles;
  if (files === undefined) return;

  const entries: Array<{ path: string; content: string }> = [];
  for (const path of Object.keys(input.lock.spec.files)) {
    const content = files[path];
    if (content === undefined) {
      error(report, 'lock_file_missing', `spec.files.${path}`, `solution.lock pins ${path}, which is not in the Spec tree`, 're-run `fde spec lock`');
      continue;
    }
    entries.push({ path, content });
  }

  if (entries.length > 0) {
    const recomputed = digestFiles(entries);
    for (const [path, digest] of Object.entries(recomputed.files)) {
      if (input.lock.spec.files[path] !== digest) {
        error(
          report,
          'lock_digest_mismatch',
          `spec.files.${path}`,
          `${path} has digest ${digest} but solution.lock pins ${String(input.lock.spec.files[path])}`,
          're-run `fde spec lock`',
        );
      }
    }
    if (recomputed.digest !== input.lock.spec.digest) {
      error(
        report,
        'lock_digest_mismatch',
        'spec.digest',
        `solution.yaml + referenced files digest to ${recomputed.digest}, lock pins ${input.lock.spec.digest}`,
        're-run `fde spec lock`',
      );
    }
  }

  for (const path of Object.keys(files)) {
    if (!Object.hasOwn(input.lock.spec.files, path)) {
      error(
        report,
        'spec_file_unpinned',
        `spec.files.${path}`,
        `${path} exists in the Spec tree but solution.lock does not pin it`,
        're-run `fde spec lock`; a file outside the digest is outside the build',
      );
    }
  }
}

interface PinValue {
  version: string;
  digest?: string;
}

interface PinLookup {
  has(category: PinCategory, name: string): boolean;
  pin(category: PinCategory, name: string): PinValue | undefined;
}

type PinCategory = 'policy' | 'eval' | 'capability' | 'overlay' | 'extension' | 'modelProfile' | 'dataset';

/** `1.2.3@sha256:…` → `{version, digest}` (Template pins carry no name). */
function splitVersionDigest(pin: string): PinValue {
  const at = pin.indexOf('@');
  return at < 0 ? { version: pin } : { version: pin.slice(0, at), digest: pin.slice(at + 1) };
}

function pinLookup(lock: SolutionLock): PinLookup {
  const tables = {
    policy: { ...lock.templates.policy, ...lock.assets?.policies },
    eval: { ...lock.templates.eval, ...lock.assets?.evalSuites },
    capability: lock.templates.capability ?? {},
    overlay: lock.overlays ?? {},
    extension: lock.extensions ?? {},
    modelProfile: lock.modelProfiles ?? {},
    dataset: lock.evalDatasets ?? {},
  } as const;

  const pinOf = (category: PinCategory, name: string): PinValue | undefined => {
    const entry = (tables[category] as Record<string, unknown>)[name];
    if (entry === undefined) return undefined;
    if (typeof entry === 'string') return splitVersionDigest(entry);
    const concrete = entry as { version?: string; digest?: string };
    if (concrete.version === undefined) return undefined;
    return concrete.digest === undefined
      ? { version: concrete.version }
      : { version: concrete.version, digest: concrete.digest };
  };

  return {
    has: (category, name) => pinOf(category, name) !== undefined,
    pin: pinOf,
  };
}

function requirePin(
  { report }: Context,
  pins: PinLookup,
  category: Exclude<PinCategory, 'capability'>,
  ref: string,
  path: string,
): void {
  const { name, range } = splitRef(ref);
  const pin = pins.pin(category, name);
  if (pin === undefined) {
    error(report, 'lock_pin_missing', path, `${category} ${ref} is referenced but not pinned in solution.lock`, 're-run `fde spec lock`');
    return;
  }
  if (range !== '' && !satisfiesRange(range, pin.version)) {
    error(report, 'lock_pin_mismatch', path, `solution.lock pins ${category} ${name}@${pin.version}, which does not satisfy ${range}`);
  }
}

function checkUnusedPins({ input, report }: Context): void {
  const referenced = new Set<string>();
  const add = (ref: string): void => {
    referenced.add(splitRef(ref).name);
  };

  for (const ref of input.spec.spec.overlays ?? []) add(ref);
  for (const ref of input.spec.spec.extensions ?? []) add(ref);
  for (const ref of input.spec.spec.governance?.policies ?? []) add(ref);
  for (const ref of input.spec.spec.governance?.evalSuites ?? []) add(ref);
  for (const binding of Object.values(input.spec.spec.capabilities)) {
    add(binding.template);
    for (const entry of binding.policyRefs ?? []) add(policyRefName(entry));
    for (const ref of binding.evalRefs ?? []) add(ref);
  }
  for (const agent of Object.values(input.spec.spec.agents ?? {})) {
    add(agent.modelProfile);
    for (const fallback of input.modelProfiles?.[splitRef(agent.modelProfile).name]?.spec.fallback ?? []) {
      add(fallback.profile);
    }
    for (const entry of agent.policyRefs ?? []) add(policyRefName(entry));
  }
  for (const workflow of Object.values(input.spec.spec.workflows ?? {})) {
    for (const entry of workflow.policyRefs ?? []) add(policyRefName(entry));
  }
  if (input.spec.spec.semantic) add(input.spec.spec.semantic.contextPackageRef);
  add(input.spec.spec.build.runtimeProfile);
  for (const suite of Object.values(input.evalSuites ?? {})) {
    const datasetId = suite.spec?.datasetRef?.id;
    if (datasetId !== undefined) add(datasetId);
  }

  const check = (category: 'overlay' | 'extension' | 'modelProfile' | 'dataset', table: Record<string, unknown> | undefined): void => {
    for (const name of Object.keys(table ?? {})) {
      if (!referenced.has(name)) {
        warn(report, 'lock_pin_unused', `${category}.${name}`, `solution.lock pins ${category} ${name}, but the Spec does not reference it`);
      }
    }
  };

  check('overlay', input.lock.overlays);
  check('extension', input.lock.extensions);
  check('modelProfile', input.lock.modelProfiles);
  check('dataset', input.lock.evalDatasets);
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function capabilitySideEffectingTools(input: CheckSolutionInput, binding: CapabilityBinding): string[] {
  const { implementation } = binding;
  const tools = input.spec.spec.tools ?? {};
  const found = new Set<string>();

  if (implementation.type === 'agent') {
    for (const toolId of input.spec.spec.agents?.[implementation.ref]?.tools ?? []) {
      if (isSideEffecting(tools[toolId])) found.add(toolId);
    }
    return [...found];
  }

  for (const step of input.spec.spec.workflows?.[implementation.ref]?.steps ?? []) {
    if (step.type === 'tool' && isSideEffecting(tools[step.tool])) found.add(step.tool);
  }
  return [...found];
}

function checkEvidenceSelector(
  { input, report }: Context,
  subject: { capabilityPath: string; toolId: string; workflow?: Workflow },
  selector: EvidenceSelector,
  index: number,
): void {
  const path = `${subject.capabilityPath}.audit.evidence.${subject.toolId}[${index}]`;

  if (selector.from === 'retrieval') {
    if (selector.recipe !== undefined && input.spec.spec.semantic?.recipeBindings[selector.recipe] === undefined) {
      error(report, 'unresolved_reference', `${path}.recipe`, `evidence selector names recipe ${selector.recipe}, which is not bound in spec.semantic.recipeBindings`);
    }
    return;
  }
  if (selector.from === 'input') return;

  const workflow = subject.workflow;
  if (workflow === undefined) {
    error(report, 'audit_binding_invalid', path, 'from: step needs a workflow implementation; an agent capability has no steps');
    return;
  }
  const sourceIndex = stepIndex(workflow, selector.step);
  const targetIndex = workflow.steps.findIndex((step) => step.type === 'tool' && step.tool === subject.toolId);
  if (sourceIndex < 0) {
    error(report, 'unresolved_reference', `${path}.step`, `evidence selector step ${selector.step} does not exist in the workflow`);
    return;
  }
  if (targetIndex >= 0 && sourceIndex >= targetIndex) {
    error(report, 'audit_binding_invalid', `${path}.step`, `evidence selector step ${selector.step} must run before ${subject.toolId}`);
  }
  const source = workflow.steps[sourceIndex];
  if (source?.type === 'approval') {
    error(report, 'audit_binding_invalid', `${path}.step`, 'an approval step produces no artifact to select');
    return;
  }
  const schemaPath = source?.outputSchema;
  if (schemaPath === undefined) {
    error(report, 'audit_binding_invalid', `${path}.step`, `step ${selector.step} declares no outputSchema, so ${selector.path} cannot be resolved`);
    return;
  }
  const schema = parseJsonFile(input.specFiles, schemaPath);
  if (schema === undefined) {
    if (input.specFiles !== undefined) {
      error(report, 'spec_file_missing', schemaPath, `output schema ${schemaPath} for step ${selector.step} is not in the Spec tree`);
    }
    return;
  }
  const target = resolveSchemaPath(schema, selector.path);
  if (target === undefined) {
    error(report, 'audit_binding_invalid', `${path}.path`, `${selector.path} does not exist in ${schemaPath}`);
    return;
  }
  if (selector.as === 'citations' && (target as { type?: string }).type !== 'array') {
    error(report, 'audit_binding_invalid', `${path}.as`, `as: citations needs an array at ${selector.path}, found ${String((target as { type?: string }).type)}`);
  }
}

function checkCapabilities({ input, report }: Context): void {
  const pins = pinLookup(input.lock);

  for (const [capabilityId, binding] of Object.entries(input.spec.spec.capabilities)) {
    const path = `spec.capabilities.${capabilityId}`;

    const templateName = splitRef(binding.template).name;
    if (!pins.has('capability', templateName)) {
      error(report, 'lock_pin_missing', `${path}.template`, `capability template ${binding.template} is not pinned in solution.lock`);
    }

    const { implementation } = binding;
    const workflow =
      implementation.type === 'workflow' ? input.spec.spec.workflows?.[implementation.ref] : undefined;
    if (implementation.type === 'workflow' && workflow === undefined) {
      error(report, 'unresolved_reference', `${path}.implementation.ref`, `workflow ${implementation.ref} is not defined in spec.workflows`);
    }
    if (implementation.type === 'agent' && input.spec.spec.agents?.[implementation.ref] === undefined) {
      error(report, 'unresolved_reference', `${path}.implementation.ref`, `agent ${implementation.ref} is not defined in spec.agents`);
    }

    for (const [index, entry] of (binding.policyRefs ?? []).entries()) {
      requirePin({ input, report }, pins, 'policy', policyRefName(entry), `${path}.policyRefs[${index}]`);
    }
    for (const [index, ref] of (binding.evalRefs ?? []).entries()) {
      requirePin({ input, report }, pins, 'eval', ref, `${path}.evalRefs[${index}]`);
    }

    if ((binding.policyRefs ?? []).length === 0) {
      error(report, 'capability_governance_missing', `${path}.policyRefs`, `capability ${capabilityId} must bind at least one Policy`);
    }
    if ((binding.evalRefs ?? []).length === 0) {
      error(report, 'capability_governance_missing', `${path}.evalRefs`, `capability ${capabilityId} must bind at least one Eval Suite`);
    }

    const sideEffecting = capabilitySideEffectingTools(input, binding);
    const evidence = binding.audit?.evidence ?? {};

    if (sideEffecting.length > 0 && binding.audit?.runOutcomeDecision === 'omitted') {
      error(
        report,
        'audit_binding_invalid',
        `${path}.audit.runOutcomeDecision`,
        `capability ${capabilityId} calls side-effecting ${sideEffecting.join(', ')}; a run outcome Decision cannot be omitted`,
      );
    }

    for (const toolId of sideEffecting) {
      const selectors = evidence[toolId];
      if (selectors === undefined || selectors.length === 0) {
        error(
          report,
          'audit_evidence_missing',
          `${path}.audit.evidence.${toolId}`,
          `side-effecting tool ${toolId} has no evidence selector; use \`from: input\` if the action truly has no external evidence`,
        );
      } else {
        for (const [index, selector] of selectors.entries()) {
          checkEvidenceSelector({ input, report }, { capabilityPath: path, toolId, workflow }, selector, index);
        }
      }

      const covering = (binding.policyRefs ?? []).filter((entry) => {
        if (!policyRefApplies(entry, toolId)) return false;
        const template = input.policies?.[policyRefName(entry)];
        return template?.spec?.enforcementPoint === 'tool.pre_invoke';
      });
      if (input.policies !== undefined && covering.length === 0) {
        error(
          report,
          'policy_coverage_missing',
          `${path}.policyRefs`,
          `side-effecting tool ${toolId} has no tool.pre_invoke Policy bound to capability ${capabilityId}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

function checkAgents({ input, report }: Context): void {
  const pins = pinLookup(input.lock);
  const tools = input.spec.spec.tools ?? {};
  const workflows = Object.values(input.spec.spec.workflows ?? {});

  for (const [agentId, agent] of Object.entries(input.spec.spec.agents ?? {})) {
    const path = `spec.agents.${agentId}`;

    for (const [index, toolId] of (agent.tools ?? []).entries()) {
      if (tools[toolId] === undefined) {
        error(report, 'unresolved_reference', `${path}.tools[${index}]`, `tool ${toolId} is not defined in spec.tools`);
      }
    }
    for (const [index, entry] of (agent.policyRefs ?? []).entries()) {
      requirePin({ input, report }, pins, 'policy', policyRefName(entry), `${path}.policyRefs[${index}]`);
    }

    requirePin({ input, report }, pins, 'modelProfile', agent.modelProfile, `${path}.modelProfile`);
    const profileName = splitRef(agent.modelProfile).name;
    const profilePin = pins.pin('modelProfile', profileName);
    const profile = input.modelProfiles?.[profileName];
    if (input.modelProfiles !== undefined && profile === undefined) {
      error(report, 'model_profile_missing', `${path}.modelProfile`, `Model Profile ${profileName} pin has no artifact`);
    }
    if (profile !== undefined && profilePin !== undefined) {
      if (profile.metadata.version !== profilePin.version) {
        error(
          report,
          'lock_pin_mismatch',
          `${path}.modelProfile`,
          `Model Profile ${profileName} artifact is ${profile.metadata.version}, lock pins ${profilePin.version}`,
        );
      }
      for (const [index, fallback] of (profile.spec.fallback ?? []).entries()) {
        requirePin({ input, report }, pins, 'modelProfile', fallback.profile, `${path}.modelProfile.fallback[${index}]`);
      }
    }

    if (agent.instructions !== undefined) {
      if (input.specFiles !== undefined && input.specFiles[agent.instructions] === undefined) {
        error(report, 'spec_file_missing', `${path}.instructions`, `instructions file ${agent.instructions} does not exist`);
      }
      if (!Object.hasOwn(input.lock.spec.files, agent.instructions)) {
        error(report, 'spec_file_unpinned', `${path}.instructions`, `instructions file ${agent.instructions} is not pinned in solution.lock`);
      }
    }

    if (agent.memory?.thread !== undefined) {
      const durableHost = workflows.some(
        (workflow) =>
          workflow.durable === true &&
          workflow.steps.some((step) => step.type === 'agent' && step.agent === agentId),
      );
      if (!durableHost) {
        error(
          report,
          'memory_thread_unsupported',
          `${path}.memory.thread`,
          `agent ${agentId} uses thread memory but no durable workflow runs it; thread history needs a durable state store`,
        );
      }
    }
    if (agent.memory?.longTerm?.scope === 'agent') {
      warn(
        report,
        'memory_scope_agent',
        `${path}.memory.longTerm.scope`,
        `agent ${agentId} opts out of per-end-user memory isolation (scope: agent)`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

function checkWorkflows({ input, report }: Context): void {
  const pins = pinLookup(input.lock);
  const agents = input.spec.spec.agents ?? {};
  const tools = input.spec.spec.tools ?? {};
  const recipeBindings = input.spec.spec.semantic?.recipeBindings ?? {};

  for (const [workflowId, workflow] of Object.entries(input.spec.spec.workflows ?? {})) {
    const path = `spec.workflows.${workflowId}`;
    const seen = new Set<string>();

    for (const [index, step] of workflow.steps.entries()) {
      const stepPath = `${path}.steps[${index}]`;
      if (seen.has(step.id)) {
        error(report, 'workflow_step_duplicate', `${stepPath}.id`, `step id ${step.id} is used twice in ${workflowId}`);
      }
      seen.add(step.id);

      switch (step.type) {
        case 'context':
          if (recipeBindings[step.recipe] === undefined) {
            error(report, 'unresolved_reference', `${stepPath}.recipe`, `recipe ${step.recipe} is not bound in spec.semantic.recipeBindings`);
          }
          break;
        case 'agent':
          if (agents[step.agent] === undefined) {
            error(report, 'unresolved_reference', `${stepPath}.agent`, `agent ${step.agent} is not defined in spec.agents`);
          }
          break;
        case 'tool':
          if (tools[step.tool] === undefined) {
            error(report, 'unresolved_reference', `${stepPath}.tool`, `tool ${step.tool} is not defined in spec.tools`);
          }
          break;
        case 'approval':
          checkApprovalStep({ input, report }, { workflowId, workflow, step, stepPath, index, pins });
          break;
      }

      if ((step.type === 'agent' || step.type === 'context' || step.type === 'tool') && step.outputSchema !== undefined) {
        if (input.specFiles !== undefined && input.specFiles[step.outputSchema] === undefined) {
          error(report, 'spec_file_missing', `${stepPath}.outputSchema`, `output schema ${step.outputSchema} does not exist`);
        }
        if (!Object.hasOwn(input.lock.spec.files, step.outputSchema)) {
          error(report, 'spec_file_unpinned', `${stepPath}.outputSchema`, `output schema ${step.outputSchema} is not pinned in solution.lock`);
        }
      }
    }
  }
}

function checkApprovalStep(
  { input, report }: Context,
  subject: {
    workflowId: string;
    workflow: Workflow;
    step: Extract<WorkflowStep, { type: 'approval' }>;
    stepPath: string;
    index: number;
    pins: PinLookup;
  },
): void {
  const { workflow, step, stepPath, index, pins } = subject;

  if (workflow.durable !== true) {
    error(
      report,
      'approval_gate_invalid',
      stepPath,
      `workflow ${subject.workflowId} is not durable, so the approval gate cannot suspend and resume`,
    );
  }

  const next = workflow.steps[index + 1];
  if (next === undefined || next.id !== step.gates) {
    error(report, 'approval_gate_invalid', `${stepPath}.gates`, `an approval step must gate the step immediately after it; expected ${next?.id ?? '<end of workflow>'}`);
  } else if (next.type !== 'tool') {
    error(report, 'approval_gate_invalid', `${stepPath}.gates`, `an approval gate must block a tool step, not a ${next.type} step`);
  } else if (!isSideEffecting(input.spec.spec.tools?.[next.tool])) {
    error(report, 'approval_gate_invalid', `${stepPath}.gates`, `an approval gate must block a side-effecting tool; ${next.tool} is read-only or undefined`);
  }

  if (step.requiredWhen !== undefined) {
    const { predicate } = step.requiredWhen;
    requirePin({ input, report }, pins, 'policy', predicate, `${stepPath}.requiredWhen.predicate`);
    const predicateName = splitRef(predicate).name;
    const predicatePolicy = input.policies?.[predicateName];
    if (predicatePolicy !== undefined && predicatePolicy.spec?.predicate === undefined) {
      error(
        report,
        'predicate_unknown',
        `${stepPath}.requiredWhen.predicate`,
        `Policy ${predicateName} declares no predicate; an approval gate can only bind a named Policy predicate`,
        'bind a Policy Template whose spec.predicate names the predicate kind, or drop requiredWhen',
      );
    }
    const binding = Object.entries(input.spec.spec.capabilities).find(
      ([, candidate]) => candidate.implementation.type === 'workflow' && candidate.implementation.ref === subject.workflowId,
    )?.[1];
    const bound = (binding?.policyRefs ?? []).map(policyRefName);
    if (binding !== undefined && !bound.includes(splitRef(predicate).name)) {
      error(
        report,
        'approval_gate_invalid',
        `${stepPath}.requiredWhen.predicate`,
        `predicate ${predicate} is not bound to the capability that owns ${subject.workflowId}`,
      );
    }
    for (const [arg, value] of Object.entries(step.requiredWhen.args ?? {})) {
      if (typeof value !== 'object' || value === null || !('step' in value)) continue;
      const ref = value as { step: string; path: string };
      const sourceIndex = stepIndex(workflow, ref.step);
      if (sourceIndex < 0 || sourceIndex >= subject.index) {
        error(report, 'approval_gate_invalid', `${stepPath}.requiredWhen.args.${arg}`, `${ref.step} must be an upstream step`);
        continue;
      }
      const sourceStep = workflow.steps[sourceIndex];
      const schemaPath = sourceStep !== undefined && 'outputSchema' in sourceStep ? sourceStep.outputSchema : undefined;
      if (schemaPath === undefined) {
        error(report, 'approval_gate_invalid', `${stepPath}.requiredWhen.args.${arg}`, `upstream step ${ref.step} declares no outputSchema`);
        continue;
      }
      const schema = parseJsonFile(input.specFiles, schemaPath);
      if (schema !== undefined && resolveSchemaPath(schema, ref.path) === undefined) {
        error(report, 'approval_gate_invalid', `${stepPath}.requiredWhen.args.${arg}`, `${ref.path} does not exist in ${schemaPath}`);
      }
    }
  }

  for (const [position, source] of step.evidenceFrom.entries()) {
    const sourceIndex = stepIndex(workflow, source);
    if (sourceIndex < 0 || sourceIndex >= subject.index) {
      error(report, 'approval_gate_invalid', `${stepPath}.evidenceFrom[${position}]`, `${source} must be an upstream step`);
      continue;
    }
    const sourceStep = workflow.steps[sourceIndex];
    if (sourceStep?.type !== 'context' && sourceStep?.type !== 'tool') {
      error(report, 'approval_gate_invalid', `${stepPath}.evidenceFrom[${position}]`, `approval evidence must come from a context or tool step, not ${String(sourceStep?.type)}`);
    }
  }

  if (step.summaryFrom !== undefined) {
    const sourceIndex = stepIndex(workflow, step.summaryFrom.step);
    if (sourceIndex < 0 || sourceIndex >= subject.index) {
      error(report, 'approval_gate_invalid', `${stepPath}.summaryFrom.step`, `${step.summaryFrom.step} must be an upstream step`);
      return;
    }
    const sourceStep = workflow.steps[sourceIndex];
    const schemaPath = sourceStep !== undefined && 'outputSchema' in sourceStep ? sourceStep.outputSchema : undefined;
    if (schemaPath === undefined) {
      error(report, 'approval_gate_invalid', `${stepPath}.summaryFrom.step`, `summary source ${step.summaryFrom.step} declares no outputSchema`);
      return;
    }
    const schema = parseJsonFile(input.specFiles, schemaPath);
    if (schema === undefined) return;
    const target = resolveSchemaPath(schema, step.summaryFrom.path) as { type?: string } | undefined;
    if (target === undefined) {
      error(report, 'approval_gate_invalid', `${stepPath}.summaryFrom.path`, `${step.summaryFrom.path} does not exist in ${schemaPath}`);
    } else if (target.type !== 'string') {
      error(report, 'approval_gate_invalid', `${stepPath}.summaryFrom.path`, `approver summary must resolve to a string, found ${String(target.type)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tools, semantic layer, governance, runtime pin
// ---------------------------------------------------------------------------

function checkTools({ input, report }: Context): void {
  for (const [toolId, tool] of Object.entries(input.spec.spec.tools ?? {})) {
    const path = `spec.tools.${toolId}`;

    if (tool.builtin !== undefined) {
      warn(
        report,
        'builtin_tool_field',
        `${path}.builtin`,
        'builtin is a prototype-only field (GAPS.md GAP-1); the typed connector-operation seam has no documented built-in discriminator yet',
      );
    }

    if (tool.connectorRef !== undefined) {
      const connector = input.connectors?.[tool.connectorRef];
      if (input.connectors !== undefined && connector === undefined) {
        error(report, 'unresolved_reference', `${path}.connectorRef`, `connector ${tool.connectorRef} is not a known Customer asset`);
      } else if (connector !== undefined && tool.operation !== undefined) {
        const allowed = connector.spec?.allowedOperations ?? [];
        if (!allowed.includes(tool.operation)) {
          error(report, 'connector_operation_not_allowed', `${path}.operation`, `connector ${tool.connectorRef} does not allow operation ${tool.operation}`);
        }
      }
    }

    for (const field of ['inputSchema', 'outputSchema'] as const) {
      const file = tool[field];
      if (file === undefined) continue;
      if (input.specFiles !== undefined && input.specFiles[file] === undefined) {
        error(report, 'spec_file_missing', `${path}.${field}`, `${file} does not exist in the Spec tree`);
      }
      if (!Object.hasOwn(input.lock.spec.files, file)) {
        error(report, 'spec_file_unpinned', `${path}.${field}`, `${file} is not pinned in solution.lock`);
      }
    }

    if (tool.sideEffects !== 'read') {
      if (tool.audit === undefined) {
        error(report, 'tool_audit_missing', `${path}.audit`, `side-effecting tool ${toolId} must declare classification and retentionClass`);
      }
      if (tool.rateLimit === undefined) {
        error(report, 'tool_rate_limit_missing', `${path}.rateLimit`, `side-effecting tool ${toolId} must declare perRunMax and perActorPerHourMax`);
      }
    }
  }
}

function checkSemantic({ input, report }: Context): void {
  const semantic = input.spec.spec.semantic;
  if (semantic === undefined) {
    const contextSteps = Object.values(input.spec.spec.workflows ?? {}).flatMap((workflow) =>
      workflow.steps.filter((step) => step.type === 'context'),
    );
    if (contextSteps.length > 0) {
      error(report, 'semantic_missing', 'spec.semantic', 'workflows call context steps but spec.semantic declares no Context Package');
    }
    return;
  }

  const packageRef = splitRef(semantic.contextPackageRef);
  const packagePin = input.lock.assets?.customerContextPackage?.[packageRef.name];
  if (packagePin === undefined) {
    error(report, 'lock_pin_missing', 'spec.semantic.contextPackageRef', `Context Package ${semantic.contextPackageRef} is not pinned in solution.lock`);
  } else {
    const pinnedPackage = splitVersionDigest(packagePin);
    if (!satisfiesRange(packageRef.range, pinnedPackage.version)) {
      error(report, 'lock_pin_mismatch', 'spec.semantic.contextPackageRef', `solution.lock pins ${packageRef.name}@${pinnedPackage.version}, which does not satisfy ${semantic.contextPackageRef}`);
    }
  }

  const contextPackage = input.contextPackage;
  const usedRecipes = new Set(
    Object.values(input.spec.spec.workflows ?? {}).flatMap((workflow) =>
      workflow.steps.filter((step) => step.type === 'context').map((step) => step.recipe),
    ),
  );

  if (contextPackage !== undefined && contextPackage.revision === undefined) {
    error(
      report,
      'context_package_unfrozen',
      'spec.semantic.contextPackageRef',
      `Context Package ${packageRef.name} has no frozen revision, so a build would compile semantics that no digest addresses`,
      'run `fde context freeze` in the package, then `fde spec lock`',
    );
  }

  for (const [recipeName, binding] of Object.entries(semantic.recipeBindings)) {
    const { name, range } = splitRef(binding.recipeRef);
    if (name !== recipeName) {
      warn(report, 'recipe_binding_mismatch', `spec.semantic.recipeBindings.${recipeName}.recipeRef`, `binding ${recipeName} points at recipe ${name}`);
    }
    if (!usedRecipes.has(recipeName)) {
      warn(report, 'recipe_binding_unused', `spec.semantic.recipeBindings.${recipeName}`, `recipe binding ${recipeName} is not used by any workflow step`);
    }
    const recipe = contextPackage?.recipes?.[recipeName];
    if (contextPackage !== undefined && recipe === undefined) {
      error(report, 'unresolved_reference', `spec.semantic.recipeBindings.${recipeName}.recipeRef`, `recipe ${recipeName} is not in Context Package ${packageRef.name}`);
    } else if (recipe !== undefined && range !== '' && !satisfiesRange(range, recipe.metadata?.version ?? '0.0.0')) {
      error(
        report,
        'context_package_invalid',
        `spec.semantic.recipeBindings.${recipeName}.recipeRef`,
        `recipe ${recipeName} in the package is ${String(recipe.metadata?.version)}, which does not satisfy ${range}`,
      );
    }
  }
}

function checkGovernance({ input, report }: Context): void {
  const pins = pinLookup(input.lock);
  const governance = input.spec.spec.governance;

  for (const [index, ref] of (governance?.policies ?? []).entries()) {
    requirePin({ input, report }, pins, 'policy', ref, `spec.governance.policies[${index}]`);
  }
  for (const [index, ref] of (governance?.evalSuites ?? []).entries()) {
    requirePin({ input, report }, pins, 'eval', ref, `spec.governance.evalSuites[${index}]`);
  }
  for (const [index, ref] of (input.spec.spec.overlays ?? []).entries()) {
    requirePin({ input, report }, pins, 'overlay', ref, `spec.overlays[${index}]`);
  }
  for (const [index, ref] of (input.spec.spec.extensions ?? []).entries()) {
    requirePin({ input, report }, pins, 'extension', ref, `spec.extensions[${index}]`);
  }

  for (const [name, suite] of Object.entries(input.evalSuites ?? {})) {
    const datasetRef = suite.spec?.datasetRef;
    if (datasetRef === undefined) continue;
    const pin = pins.pin('dataset', datasetRef.id ?? '');
    if (pin === undefined) {
      error(report, 'lock_pin_missing', `evalSuites.${name}.spec.datasetRef`, `Eval Suite ${name} references dataset ${String(datasetRef.id)}, which is not pinned in solution.lock evalDatasets`);
      continue;
    }
    const { version, digest } = pin;
    if (version !== datasetRef.version || digest !== datasetRef.digest) {
      error(
        report,
        'lock_pin_mismatch',
        `evalSuites.${name}.spec.datasetRef`,
        `Eval Suite ${name} pins ${String(datasetRef.id)}@${String(datasetRef.version)} (${String(datasetRef.digest)}), lock pins ${version} (${String(digest)})`,
      );
    }
  }
}

function checkRuntimePin({ input, report }: Context): void {
  const specRef = input.spec.spec.build.runtimeProfile;
  const lockPin = input.lock.runtime.profile;
  const { name, range } = splitRef(specRef);
  const pinned = splitPin(lockPin);

  if (pinned.name !== name) {
    error(report, 'lock_pin_mismatch', 'runtime.profile', `spec.build.runtimeProfile is ${specRef} but solution.lock pins ${lockPin}`);
    return;
  }
  if (!satisfiesRange(range, pinned.version)) {
    error(report, 'lock_pin_mismatch', 'runtime.profile', `solution.lock pins ${lockPin}, which does not satisfy ${specRef}`);
  }

  const profile = input.runtimeProfile;
  if (profile !== undefined) {
    if (profile.metadata.name !== pinned.name) {
      error(report, 'lock_pin_mismatch', 'runtime.profile', `the pinned profile is ${profile.metadata.name}@${profile.metadata.version}, lock pins ${lockPin}`);
    }
    if (profile.metadata.version !== pinned.version) {
      error(report, 'lock_pin_mismatch', 'runtime.profile', `the pinned profile is ${profile.metadata.name}@${profile.metadata.version}, lock pins ${pinned.version}`);
    }
    const digest = pinned.digest ?? input.lock.runtime.profileDigest;
    if (digest !== undefined && digest !== digestOf(profile)) {
      error(
        report,
        'lock_digest_mismatch',
        'runtime.profile',
        `the Runtime Profile digest is ${digestOf(profile)} but solution.lock pins ${digest}`,
        're-run `fde spec lock` after changing the profile',
      );
    }
  }

  if (input.spec.spec.build.targets !== undefined) {
    warn(report, 'build_targets_legacy', 'spec.build.targets', 'build.targets is superseded by build.platform/build.delivery (#17 D11); switch before it is removed');
  }
}

export function checkSolution(input: CheckSolutionInput): ValidationReport {
  const report: ValidationReport = { errors: [], warnings: [] };
  const context: Context = { input, report };

  checkLockFreshness(context);
  checkUnusedPins(context);
  checkCapabilities(context);
  checkAgents(context);
  checkWorkflows(context);
  checkTools(context);
  checkSemantic(context);
  checkGovernance(context);
  checkRuntimePin(context);

  return report;
}
