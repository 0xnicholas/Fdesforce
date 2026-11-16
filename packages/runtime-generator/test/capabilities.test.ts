// Seam: capability normalization (`normalizeCapabilities`, `capabilityDetails`,
// `capabilitySupport`, `capabilityInconsistencies`).
//
// A Runtime Profile declares ten capability groups; the build reads the group
// level, the handshake reads the flat `capability_details` map, and both must
// agree with the sub-items. `docs/runtime-adapter.md` §5.2 defines the levels:
// `native` and `adapter` are both satisfied, `degraded` fails a `must` and
// `none` is not generable. That trichotomy is what this file pins.
import { describe, expect, it } from 'vitest';

import { CAPABILITY_GROUPS, CapabilityDetailsSchema, parseRuntimeCapabilities } from '@fde/spec';
import type { RuntimeCapabilities } from '@fde/spec';

import {
  capabilityDetails,
  capabilityInconsistencies,
  capabilityLimitations,
  capabilitySupport,
  normalizeCapabilities,
} from '../src/index.js';

/** The reference profile's declaration: native groups with adapter sub-items. */
const reference = (): Record<string, unknown> => ({
  durableWorkflow: { support: 'native', durabilityModes: ['sync', 'async'], autoResume: 'adapter' },
  hitl: {
    support: 'adapter',
    interrupt: 'native',
    resume: 'native',
    approvalResource: 'adapter',
    expiry: 'adapter',
    multipleInterrupts: 'native',
    consume: 'adapter',
  },
  streaming: {
    support: 'native',
    tokenStream: 'native',
    toolEvents: 'native',
    interruptEvents: 'adapter',
    transport: 'native',
  },
  observability: { support: 'native', otel: 'native', evalHooks: 'native' },
  memory: { support: 'native', thread: 'native', longTerm: 'native', ttl: 'adapter' },
  tools: { support: 'native', native: 'native', mcp: 'adapter', connectorOperations: 'adapter' },
  extensions: { support: 'adapter', artifactKinds: ['ts-package'] },
  stateStore: {
    support: 'native',
    kinds: ['sqlite', 'postgres'],
    schemaVersion: '1',
    encryption: 'adapter',
    retention: 'adapter',
  },
  topology: { support: 'native', modes: ['split'], singleWriter: true },
  offline: { support: 'native' },
});

/** A declaration the schema itself rejects; `validate` must still catch it. */
const unvalidated = (group: string, declaration: unknown): RuntimeCapabilities => {
  const document = reference();
  document[group] = declaration;
  return document as unknown as RuntimeCapabilities;
};

const capabilities = (overrides: Record<string, unknown> = {}): RuntimeCapabilities => {
  const parsed = parseRuntimeCapabilities({ ...reference(), ...overrides });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
};

describe('normalizing a profile declaration', () => {
  it('reports the ten groups in contract order whatever the artifact order', () => {
    const reversed = Object.fromEntries(Object.entries(reference()).reverse()) as unknown as RuntimeCapabilities;

    expect(Object.keys(normalizeCapabilities(reversed))).toEqual([...CAPABILITY_GROUPS]);
  });

  it('orders multi-valued capability lists the way the contract enumerates them', () => {
    const normalized = normalizeCapabilities(
      capabilities({
        durableWorkflow: { support: 'native', durabilityModes: ['async', 'sync'], autoResume: 'adapter' },
        extensions: { support: 'adapter', artifactKinds: ['http', 'ts-package'] },
        stateStore: {
          support: 'native',
          kinds: ['postgres', 'sqlite'],
          schemaVersion: '1',
          encryption: 'adapter',
          retention: 'adapter',
        },
        topology: { support: 'native', modes: ['agent-server', 'split'], singleWriter: true },
      }),
    );

    expect(normalized.durableWorkflow.durabilityModes).toEqual(['sync', 'async']);
    expect(normalized.extensions.artifactKinds).toEqual(['ts-package', 'http']);
    expect(normalized.stateStore.kinds).toEqual(['sqlite', 'postgres']);
    expect(normalized.topology.modes).toEqual(['split', 'agent-server']);
  });

  it('keeps limitation prose in the order the author wrote it', () => {
    const normalized = normalizeCapabilities(
      capabilities({
        observability: {
          support: 'degraded',
          otel: 'degraded',
          evalHooks: 'external',
          limitations: ['otel-only path unverified', 'OTel-only path unverified'],
        },
      }),
    );

    expect(normalized.observability.limitations).toEqual([
      'otel-only path unverified',
      'OTel-only path unverified',
    ]);
  });

  it('drops duplicate limitations without dropping the declaration', () => {
    const normalized = normalizeCapabilities(
      unvalidated('observability', {
        support: 'degraded',
        otel: 'degraded',
        evalHooks: 'external',
        limitations: ['collector egress blocked', 'collector egress blocked'],
      }),
    );

    expect(normalized.observability.limitations).toEqual(['collector egress blocked']);
  });

  it('returns a copy; normalizing never rewrites the parsed artifact', () => {
    const parsed = capabilities();
    const before = structuredClone(parsed);
    const normalized = normalizeCapabilities(parsed);
    (normalized.durableWorkflow.durabilityModes as string[]).push('exit');

    expect(parsed).toEqual(before);
    expect(normalized).not.toBe(parsed);
  });
});

describe('reading one capability path', () => {
  it('reads a group level', () => {
    expect(capabilitySupport(capabilities(), 'hitl')).toEqual({ found: true, support: 'adapter' });
  });

  it('reads a graded sub-item', () => {
    expect(capabilitySupport(capabilities(), 'streaming.interruptEvents')).toEqual({
      found: true,
      support: 'adapter',
    });
  });

  it('reports a path the profile does not declare', () => {
    expect(capabilitySupport(capabilities(), 'hitl.batchApprove')).toEqual({ found: false });
  });

  it('does not pretend a non-level field is a capability level', () => {
    expect(capabilitySupport(capabilities(), 'extensions.artifactKinds')).toEqual({ found: false });
  });
});

describe('explaining a degraded path', () => {
  it('reads the limitations from the group the path belongs to', () => {
    const capabilities = capabilitiesWithLimitations();

    expect(capabilityLimitations(capabilities, 'observability.otel')).toEqual(['otel-only path unverified']);
    expect(capabilityLimitations(capabilities, 'observability')).toEqual(['otel-only path unverified']);
  });

  it('has nothing to say about a path outside the ten groups', () => {
    expect(capabilityLimitations(capabilities(), 'unknown.path')).toEqual([]);
  });
});

const capabilitiesWithLimitations = (): RuntimeCapabilities =>
  capabilities({
    observability: {
      support: 'degraded',
      otel: 'degraded',
      evalHooks: 'external',
      limitations: ['otel-only path unverified'],
    },
  });

describe('group support against its members', () => {
  it('accepts the reference declaration: a satisfied group may have adapter members', () => {
    expect(capabilityInconsistencies(capabilities())).toEqual([]);
  });

  it('rejects a satisfied group masking a degraded member', () => {
    const [inconsistency, ...rest] = capabilityInconsistencies(
      capabilities({
        hitl: {
          support: 'native',
          interrupt: 'native',
          resume: 'native',
          approvalResource: 'adapter',
          expiry: 'adapter',
          multipleInterrupts: 'native',
          consume: 'degraded',
        },
      }),
    );

    expect(rest).toEqual([]);
    expect(inconsistency).toMatchObject({
      group: 'hitl',
      reason: 'support_mismatch',
      declared: 'native',
      worst: 'degraded',
      members: [{ path: 'hitl.consume', support: 'degraded' }],
    });
  });

  it('rejects a satisfied group masking a missing member', () => {
    const [inconsistency] = capabilityInconsistencies(
      capabilities({
        tools: { support: 'native', native: 'native', mcp: 'none', connectorOperations: 'adapter' },
      }),
    );

    expect(inconsistency).toMatchObject({ group: 'tools', worst: 'none', members: [{ path: 'tools.mcp' }] });
  });

  it('rejects a degraded group that still claims a missing member is available', () => {
    const [inconsistency] = capabilityInconsistencies(
      capabilities({
        memory: {
          support: 'degraded',
          thread: 'native',
          longTerm: 'none',
          ttl: 'adapter',
          limitations: ['no long-term recall'],
        },
      }),
    );

    expect(inconsistency).toMatchObject({ group: 'memory', declared: 'degraded', worst: 'none' });
  });

  it('accepts a conservative declaration: none may hide a usable member', () => {
    expect(
      capabilityInconsistencies(
        capabilities({
          offline: { support: 'none' },
          extensions: { support: 'none', artifactKinds: ['ts-package'] },
        }),
      ),
    ).toEqual([]);
  });

  it('requires limitations on a degraded group even when the schema was bypassed', () => {
    const [inconsistency] = capabilityInconsistencies(
      unvalidated('observability', { support: 'degraded', otel: 'degraded', evalHooks: 'external' }),
    );

    expect(inconsistency).toEqual({
      group: 'observability',
      reason: 'limitations_missing',
      declared: 'degraded',
      members: [],
    });
  });

  it('ignores the fields that are not capability levels', () => {
    // `evalHooks` is `native | external | none`, `artifactKinds`/`modes`/`kinds` are
    // value lists and `singleWriter` is a constraint, so none of them ranks a group.
    expect(
      capabilityInconsistencies(
        capabilities({
          observability: { support: 'native', otel: 'native', evalHooks: 'none' },
          extensions: { support: 'adapter', artifactKinds: ['ts-package'] },
          topology: { support: 'native', modes: ['split'], singleWriter: false },
        }),
      ),
    ).toEqual([]);
  });
});

describe('the flat capability map the runtime-info handshake reports', () => {
  it('parses as the contract capability_details shape', () => {
    const parsed = CapabilityDetailsSchema.safeParse(capabilityDetails(capabilities()));

    expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it('reports every group plus every graded sub-item', () => {
    const details = capabilityDetails(capabilities());

    expect(Object.keys(details).sort()).toEqual(
      [
        ...CAPABILITY_GROUPS,
        'durableWorkflow.autoResume',
        'hitl.interrupt',
        'hitl.resume',
        'hitl.approvalResource',
        'hitl.expiry',
        'hitl.multipleInterrupts',
        'hitl.consume',
        'streaming.tokenStream',
        'streaming.toolEvents',
        'streaming.interruptEvents',
        'streaming.transport',
        'observability.otel',
        'memory.thread',
        'memory.longTerm',
        'memory.ttl',
        'tools.native',
        'tools.mcp',
        'tools.connectorOperations',
        'stateStore.encryption',
        'stateStore.retention',
      ].sort(),
    );
  });

  it('gives a degraded sub-item the group limitations it belongs to', () => {
    const details = capabilityDetails(
      capabilities({
        observability: {
          support: 'degraded',
          otel: 'degraded',
          evalHooks: 'external',
          limitations: ['otel-only path unverified'],
        },
      }),
    );

    expect(details['observability.otel']).toEqual({
      support: 'degraded',
      limitations: ['otel-only path unverified'],
    });
    expect(details['observability']).toEqual({
      support: 'degraded',
      limitations: ['otel-only path unverified'],
    });
  });
});
