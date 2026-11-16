import {
  CAPABILITY_GROUPS,
  DURABILITY_MODES,
  EXTENSION_ARTIFACT_KINDS,
  STATE_STORE_KINDS,
  SUPPORT_LEVELS,
  TOPOLOGY_MODES,
} from '@fde/spec';
import type { CapabilityDetails, CapabilityGroup, RuntimeCapabilities, Support } from '@fde/spec';

/**
 * Capability normalization and the group/user-visible consistency rule
 * (`docs/runtime-adapter.md` §5, §5.2).
 *
 * The ten groups describe the *generated* runtime app. Each group's `support`
 * summarizes its members, and §5.2 gives only three build-visible classes:
 * `native` and `adapter` both *satisfy* a requirement, `degraded` fails a `must`
 * and `none` is not generable. So the consistency check orders those three
 * classes, not `native` and `adapter` against each other: the reference profile
 * legitimately declares `durableWorkflow: native` with `autoResume: adapter`.
 * What it may never do is let a satisfied group mask a `degraded`/`none` member —
 * the `hitl.consume: degraded` behind `hitl.support: native` case the doc names.
 */

/** Member fields whose value is a `Support` level; every other field is data. */
const GRADED_MEMBERS: Record<CapabilityGroup, readonly string[]> = {
  durableWorkflow: ['autoResume'],
  hitl: ['interrupt', 'resume', 'approvalResource', 'expiry', 'multipleInterrupts', 'consume'],
  streaming: ['tokenStream', 'toolEvents', 'interruptEvents', 'transport'],
  observability: ['otel'],
  memory: ['thread', 'longTerm', 'ttl'],
  tools: ['native', 'mcp', 'connectorOperations'],
  extensions: [],
  stateStore: ['encryption', 'retention'],
  topology: [],
  offline: [],
};

/** Field order inside a normalized group; arrays use the contract's own order. */
const GROUP_FIELDS: Record<CapabilityGroup, readonly string[]> = {
  durableWorkflow: ['durabilityModes', 'autoResume'],
  hitl: GRADED_MEMBERS.hitl,
  streaming: GRADED_MEMBERS.streaming,
  observability: ['otel', 'evalHooks'],
  memory: GRADED_MEMBERS.memory,
  tools: GRADED_MEMBERS.tools,
  extensions: ['artifactKinds'],
  stateStore: ['kinds', 'schemaVersion', 'encryption', 'retention'],
  topology: ['modes', 'singleWriter'],
  offline: [],
};

const ARRAY_ORDERS: Partial<Record<CapabilityGroup, Record<string, readonly string[]>>> = {
  durableWorkflow: { durabilityModes: DURABILITY_MODES },
  extensions: { artifactKinds: EXTENSION_ARTIFACT_KINDS },
  stateStore: { kinds: STATE_STORE_KINDS },
  topology: { modes: TOPOLOGY_MODES },
};

/**
 * How much a level costs the build: 0 satisfies, 1 satisfies with a declared
 * loss, 2 cannot be generated. `native` and `adapter` are deliberately equal.
 */
const SEVERITY: Record<Support, number> = { native: 0, adapter: 0, degraded: 1, none: 2 };

export interface CapabilityInconsistency {
  group: CapabilityGroup;
  /** The level the artifact declares for the group. */
  declared: Support;
  /** The severest member level, when the group has graded members. */
  worst?: Support;
  /** The members that contradict the declared level, as `<group>.<member>` paths. */
  members: Array<{ path: string; support: Support }>;
  reason: 'support_mismatch' | 'limitations_missing';
}

export type CapabilitySupport = { found: true; support: Support } | { found: false };

const isGroup = (name: string): name is CapabilityGroup =>
  (CAPABILITY_GROUPS as readonly string[]).includes(name);

const nodeOf = (capabilities: RuntimeCapabilities, group: CapabilityGroup): Record<string, unknown> =>
  capabilities[group] as unknown as Record<string, unknown>;

function memberSupport(capabilities: RuntimeCapabilities, group: CapabilityGroup, member: string): Support | undefined {
  // The member list is fixed above and every listed field is a `Support` in the
  // schema, so anything else means the caller bypassed `@fde/spec`. A missing
  // member is reported as not declared, never silently treated as available.
  const value = nodeOf(capabilities, group)[member];
  return typeof value === 'string' && (SUPPORT_LEVELS as readonly string[]).includes(value)
    ? (value as Support)
    : undefined;
}

const gradedMembers = (
  capabilities: RuntimeCapabilities,
  group: CapabilityGroup,
): Array<{ path: string; support: Support }> =>
  GRADED_MEMBERS[group].flatMap((member) => {
    const support = memberSupport(capabilities, group, member);
    return support === undefined ? [] : [{ path: `${group}.${member}`, support }];
  });

/** The severest of the given levels; `undefined` when the group has no members to rank. */
function worstSupport(supports: ReadonlyArray<Support>): Support | undefined {
  let worst: Support | undefined;
  for (const support of supports) {
    if (worst === undefined || SEVERITY[support] > SEVERITY[worst]) worst = support;
  }
  return worst;
}

/**
 * Read one `capability.path`. Group paths report the group level, graded
 * sub-items their own, and anything else is reported as not declared — a `must`
 * for a path the artifact does not declare is missing, not satisfied.
 */
export function capabilitySupport(capabilities: RuntimeCapabilities, path: string): CapabilitySupport {
  const segments = path.split('.');
  const [group, member] = segments;
  if (group === undefined || !isGroup(group) || segments.length > 2) return { found: false };
  if (member === undefined) return { found: true, support: capabilities[group].support };
  if (!GRADED_MEMBERS[group].includes(member)) return { found: false };
  const support = memberSupport(capabilities, group, member);
  return support === undefined ? { found: false } : { found: true, support };
}

function limitationsOf(capabilities: RuntimeCapabilities, group: CapabilityGroup): string[] | undefined {
  const value = (capabilities[group] as { limitations?: string[] }).limitations;
  return value === undefined ? undefined : [...new Set(value)];
}

/** What is lost for one path: the contract states limitations once, on the group. */
export function capabilityLimitations(capabilities: RuntimeCapabilities, path: string): string[] {
  const group = path.split('.')[0];
  if (group === undefined || !isGroup(group)) return [];
  return limitationsOf(capabilities, group) ?? [];
}

/**
 * Every place a group level contradicts its members, or a `degraded` group
 * forgot to say what is lost. Empty means the declaration is trustworthy.
 */
export function capabilityInconsistencies(capabilities: RuntimeCapabilities): CapabilityInconsistency[] {
  const problems: CapabilityInconsistency[] = [];
  for (const group of CAPABILITY_GROUPS) {
    const declared = capabilities[group].support;
    const limitations = limitationsOf(capabilities, group) ?? [];
    if (declared === 'degraded' && limitations.length === 0) {
      problems.push({ group, reason: 'limitations_missing', declared, members: [] });
    }
    if (declared === 'none') continue;

    const members = gradedMembers(capabilities, group);
    const masked = members.filter((member) => SEVERITY[member.support] > SEVERITY[declared]);
    if (masked.length === 0) continue;

    const worst = worstSupport(members.map((member) => member.support));
    const inconsistency: CapabilityInconsistency = {
      group,
      reason: 'support_mismatch',
      declared,
      members: masked,
    };
    if (worst !== undefined) inconsistency.worst = worst;
    problems.push(inconsistency);
  }
  return problems;
}

/**
 * Canonical order for a declaration: group order from the contract, fixed field
 * order inside each group, value lists in the contract's enumeration order and
 * limitations deduped in the author's order. Digest identity is computed over the
 * artifact, never over this value, so normalizing cannot change a pin.
 */
export function normalizeCapabilities(capabilities: RuntimeCapabilities): RuntimeCapabilities {
  const normalized: Record<string, Record<string, unknown>> = {};
  for (const group of CAPABILITY_GROUPS) {
    const source = nodeOf(capabilities, group);
    const target: Record<string, unknown> = { support: source['support'] };
    const limitations = limitationsOf(capabilities, group);
    if (limitations !== undefined) target['limitations'] = limitations;

    for (const field of GROUP_FIELDS[group]) {
      const value = source[field];
      if (value === undefined) continue;
      const order = ARRAY_ORDERS[group]?.[field];
      target[field] = order === undefined ? value : orderValues(value as string[], order);
    }
    normalized[group] = target;
  }
  return normalized as unknown as RuntimeCapabilities;
}

/** Sort by the contract's enumeration order, keeping unknown members first-stable. */
function orderValues(values: ReadonlyArray<string>, order: ReadonlyArray<string>): string[] {
  const rank = (value: string): number => {
    const index = order.indexOf(value);
    return index < 0 ? -1 : index;
  };
  return [...values].sort((left, right) => rank(left) - rank(right));
}

/**
 * The flat `capability_details` map the `runtime-info` handshake reports
 * (`contracts/schemas/runtime-capabilities.schema.json`). A degraded sub-item
 * carries its group's limitations, because that is where the contract puts what
 * is lost.
 */
export function capabilityDetails(capabilities: RuntimeCapabilities): CapabilityDetails {
  const details: Record<string, { support: Support; limitations?: string[] }> = {};
  for (const group of CAPABILITY_GROUPS) {
    const limitations = limitationsOf(capabilities, group);
    details[group] =
      limitations === undefined
        ? { support: capabilities[group].support }
        : { support: capabilities[group].support, limitations };

    for (const member of gradedMembers(capabilities, group)) {
      const inherited = member.support === 'degraded' && limitations !== undefined ? { limitations } : {};
      details[member.path] = { support: member.support, ...inherited };
    }
  }
  return details;
}
