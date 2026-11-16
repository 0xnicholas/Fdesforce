import type { SolutionSpec } from '@fde/spec';

import type { RequirementLevel, RuntimeRequirement } from './port.js';

/**
 * `must / should` derivation (`docs/runtime-adapter.md` §7.1).
 *
 * Two rules decide a level. The Spec decides what the Solution needs: a
 * `durable` workflow needs durable execution and a state store, an `approval`
 * step needs the HITL paths it will call, a Connector-backed Tool needs the
 * operation seam. The contract decides what every Solution needs: the Run API
 * always streams and v0 always builds the split topology. `should` is reserved
 * for platform defaults worth recording (`observability`, `offline`), which
 * `spec.build.requirements` can promote to `must` — never the other way round.
 *
 * Every requirement keeps its source, because `fde build` writes requirements
 * into build provenance: a requirement nobody can trace back to a construct is a
 * requirement nobody can fix.
 */

/** `contract:<ref>#<anchor>` — implied by the wire contract, not written by the author. */
const contractSource = (anchor: string): string => `contract:fde.runtime/v1#${anchor}`;

/** `build:<key>` — a platform default, promotable through `spec.build.requirements`. */
const buildSource = (key: string): string => `build:${key}`;

/** An `approval` step calls each of these; §7.1 names four, `expiry` follows from `expiresAfter`. */
const APPROVAL_CAPABILITIES = ['hitl.interrupt', 'hitl.resume', 'hitl.approvalResource', 'hitl.expiry', 'hitl.consume'];

export interface DeriveRequirementsInput {
  spec: SolutionSpec;
  /** The Environment this build targets. Its `networkClass` decides the offline gate. */
  environment?: { name: string; networkClass?: string };
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Sort by code unit, not locale: two machines must derive the same list in the
 * same order, or build provenance would depend on the platform (`A11`).
 */
const compareRequirements = (left: RuntimeRequirement, right: RuntimeRequirement): number =>
  compare(left.capability, right.capability) ||
  compare(left.source, right.source) ||
  compare(left.level, right.level) ||
  compare(left.note ?? '', right.note ?? '');

export function deriveRequirements(input: DeriveRequirementsInput): RuntimeRequirement[] {
  const body = input.spec.spec;
  const collected: RuntimeRequirement[] = [];
  const add = (capability: string, level: RequirementLevel, source: string, note?: string): void => {
    collected.push(note === undefined ? { capability, level, source } : { capability, level, source, note });
  };

  add(
    'streaming',
    'must',
    contractSource('run-api-sse'),
    'the Run API always streams; the generated app must emit the contract SSE envelope',
  );
  add('topology', 'must', contractSource('split-topology'), 'v0 builds the split topology only');

  for (const [name, workflow] of Object.entries(body.workflows ?? {})) {
    const path = `spec.workflows.${name}`;
    if (workflow.durable === true) {
      add('durableWorkflow', 'must', path, 'durable: true needs state that survives a restart');
      add('stateStore', 'must', path);
    }
    for (const [index, step] of workflow.steps.entries()) {
      if (step.type !== 'approval') continue;
      for (const capability of APPROVAL_CAPABILITIES) add(capability, 'must', `${path}.steps[${index}]`);
    }
  }

  for (const [name, agent] of Object.entries(body.agents ?? {})) {
    if (agent.memory === undefined) continue;
    const path = `spec.agents.${name}.memory`;
    if (agent.memory.thread !== undefined) {
      add('memory.thread', 'must', path, 'thread memory lives in the runtime state store');
      add('stateStore', 'must', path);
    }
    if (agent.memory.longTerm !== undefined) add('memory.longTerm', 'must', path);
  }

  for (const [name, tool] of Object.entries(body.tools ?? {})) {
    const path = `spec.tools.${name}`;
    const note =
      tool.sideEffects === 'read'
        ? undefined
        : 'side-effecting: the generated app must wrap the call in record-before-act (A4)';
    if (tool.connectorRef !== undefined) add('tools.connectorOperations', 'must', path, note);
    else add('tools.native', 'must', path, note);
  }

  if ((body.extensions ?? []).length > 0) add('extensions', 'must', 'spec.extensions');

  deriveOfflineRequirements(input, (capability, level, source, note) => add(capability, level, source, note));

  if (body.build.requirements?.observability?.otel === 'required') {
    add('observability.otel', 'must', 'spec.build.requirements.observability.otel');
  } else {
    add('observability', 'should', buildSource('observability'));
  }

  return finalize(collected);
}

/**
 * `offline` is the one requirement with four independent triggers; the doc lists
 * the delivery target, a restricted network class, the legacy `airgap` target and
 * an explicit build requirement. Any of them makes it a `must`; with none of
 * them it stays a recorded `should`, because v0's targets are air-gapped.
 */
function deriveOfflineRequirements(
  input: DeriveRequirementsInput,
  add: (capability: string, level: RequirementLevel, source: string, note?: string) => void,
): void {
  const body = input.spec.spec;
  const environmentName = input.environment?.name;
  const declared =
    environmentName === undefined ? undefined : body.environments?.[environmentName];
  const networkClass = input.environment?.networkClass ?? declared?.networkClass;

  let forced = false;
  if (networkClass === 'restricted') {
    const source =
      declared?.networkClass !== undefined
        ? `spec.environments.${environmentName}.networkClass`
        : `environment:${environmentName ?? 'unknown'}`;
    add('offline', 'must', source, 'restricted network: the app may not rely on egress');
    forced = true;
  }
  if (body.build.delivery === 'offline-bundle') {
    add('offline', 'must', 'spec.build.delivery');
    forced = true;
  }
  if ((body.build.targets ?? []).includes('airgap')) {
    add('offline', 'must', 'spec.build.targets', 'build.targets is the pre-#17 shape; use build.delivery');
    forced = true;
  }
  if (body.build.requirements?.offline === true) {
    add('offline', 'must', 'spec.build.requirements.offline');
    forced = true;
  }
  if (!forced) add('offline', 'should', buildSource('offline'));
}

/**
 * Keep one entry per `(capability, source, level)`, let a `must` from any source
 * retire the `should` default for the same capability, then sort. Deduplicating
 * after the fact (rather than guarding each `add`) means a construct can be
 * derived by two rules without changing the provenance.
 */
function finalize(requirements: ReadonlyArray<RuntimeRequirement>): RuntimeRequirement[] {
  const seen = new Set<string>();
  const unique: RuntimeRequirement[] = [];
  for (const requirement of requirements) {
    const key = `${requirement.capability}\u0000${requirement.source}\u0000${requirement.level}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(requirement);
  }

  const required = new Set(unique.filter((item) => item.level === 'must').map((item) => item.capability));
  return unique
    .filter((item) => item.level === 'must' || !required.has(item.capability))
    .sort(compareRequirements);
}
