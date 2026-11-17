import { z } from 'zod';

import { BundleTopologySchema, RuntimeTopologySchema, TopologySchema } from './schema/bundle-topology.js';
import { IdentityProfileSchema } from './schema/identity-profile.js';
import { ModelProfileSchema } from './schema/model-profile.js';
import { RuntimeCapabilitiesSchema } from './schema/runtime-capabilities.js';
import { RuntimeProfileSchema } from './schema/runtime-profile.js';
import { SolutionLockSchema } from './schema/solution-lock.js';
import { SolutionSpecSchema } from './schema/solution-spec.js';

/**
 * Document seams: parse a YAML/JSON document into a typed value, or return every
 * schema violation as a diagnostic. Expected validation failures never throw —
 * only programmer errors do (AGENTS: `validate` is not exception-driven).
 */

export interface Diagnostic {
  /** Stable machine code, e.g. `solution_spec_invalid`. */
  code: string;
  message: string;
  /** Document path, e.g. `spec.workflows.document-triage-flow.steps[2].approverRoles`. */
  path?: string;
  remediation?: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: Diagnostic[] };

function formatPath(segments: ReadonlyArray<PropertyKey>): string {
  let path = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      path += `[${segment}]`;
    } else if (typeof segment === 'string') {
      path += path === '' ? segment : `.${segment}`;
    } else {
      path += `[${String(segment)}]`;
    }
  }
  return path;
}

function toDiagnostics(issues: ReadonlyArray<z.core.$ZodIssue>, code: string): Diagnostic[] {
  return issues.map((issue) => {
    const path = formatPath(issue.path);
    const diagnostic: Diagnostic = { code, message: issue.message };
    if (path !== '') diagnostic.path = path;
    const remediation = remediationFor(issue, path);
    if (remediation !== undefined) diagnostic.remediation = remediation;
    return diagnostic;
  });
}

/**
 * Author guidance for the schema failures an author actually hits. The message
 * says what is wrong; this says what to write instead, in domain language.
 */
function remediationFor(issue: z.core.$ZodIssue, path: string): string | undefined {
  if (/\.approverRoles(\[\d+\])?$/.test(path)) {
    return 'business roles are Customer-defined; end_user, approver, customer_admin, deployment_operator, auditor, service and support are platform roles and cannot be granted from a Spec';
  }
  if (path.endsWith('.build.targets')) {
    return 'set build.platform (compose | helm) and build.delivery (registry | offline-bundle) instead; targets is the pre-#17 shape';
  }
  if (path.endsWith('.memory.longTerm.embeddingProfile')) {
    return 'embeddingProfile is only valid with memory.longTerm.recall: semantic, and the profile must be pinned in solution.lock';
  }
  if (issue.code === 'unrecognized_keys') {
    const keys = 'keys' in issue ? issue.keys.join(', ') : 'unknown fields';
    return `remove or rename ${keys}; documents use strict schemas, so an unknown field cannot silently become configuration`;
  }
  return undefined;
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown, code: string): ParseResult<T> {
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: toDiagnostics(result.error.issues, code) };
}

export function parseSolutionSpec(input: unknown): ParseResult<z.infer<typeof SolutionSpecSchema>> {
  return parseWith(SolutionSpecSchema, input, 'solution_spec_invalid');
}

export function parseSolutionLock(input: unknown): ParseResult<z.infer<typeof SolutionLockSchema>> {
  return parseWith(SolutionLockSchema, input, 'solution_lock_invalid');
}

export function parseRuntimeProfile(input: unknown): ParseResult<z.infer<typeof RuntimeProfileSchema>> {
  return parseWith(RuntimeProfileSchema, input, 'runtime_profile_invalid');
}

export function parseRuntimeCapabilities(input: unknown): ParseResult<z.infer<typeof RuntimeCapabilitiesSchema>> {
  return parseWith(RuntimeCapabilitiesSchema, input, 'runtime_capabilities_invalid');
}

export function parseModelProfile(input: unknown): ParseResult<z.infer<typeof ModelProfileSchema>> {
  return parseWith(ModelProfileSchema, input, 'model_profile_invalid');
}

export function parseIdentityProfile(input: unknown): ParseResult<z.infer<typeof IdentityProfileSchema>> {
  return parseWith(IdentityProfileSchema, input, 'identity_profile_invalid');
}

export function parseRuntimeTopology(input: unknown): ParseResult<z.infer<typeof RuntimeTopologySchema>> {
  return parseWith(RuntimeTopologySchema, input, 'runtime_topology_invalid');
}

export function parseBundleTopology(input: unknown): ParseResult<z.infer<typeof BundleTopologySchema>> {
  return parseWith(BundleTopologySchema, input, 'bundle_topology_invalid');
}

export function parseTopology(input: unknown): ParseResult<z.infer<typeof TopologySchema>> {
  return parseWith(TopologySchema, input, 'topology_invalid');
}
