import { emitJsonSchema } from './schema-emit.js';
import { BundleTopologySchema, RuntimeTopologySchema } from './schema/bundle-topology.js';
import { IdentityProfileSchema } from './schema/identity-profile.js';
import { ModelProfileSchema } from './schema/model-profile.js';
import { RuntimeCapabilitiesSchema } from './schema/runtime-capabilities.js';
import { RuntimeProfileSchema } from './schema/runtime-profile.js';
import { SolutionLockSchema } from './schema/solution-lock.js';
import { SolutionSpecSchema } from './schema/solution-spec.js';

/**
 * The exported JSON Schema documents. `@fde/spec` is the single definition
 * source; these are the same artifacts an editor, a CI validator or a second
 * language consumes — never a hand-maintained second copy.
 *
 * `contract-drift.test.ts` compares the ones that also live in `contracts/`
 * (`runtime-profile`, `runtime-capabilities`, `bundle-topology`).
 */
export interface DocumentSchema {
  /** `kind` as it appears in the YAML document header. */
  kind: string;
  /** Stable artifact name; safe to write next to a Spec for editor validation. */
  file: string;
  schema: Record<string, unknown>;
}

export function documentSchemas(): DocumentSchema[] {
  const entries: Array<[string, string, Parameters<typeof emitJsonSchema>[0]]> = [
    ['SolutionSpec', 'solution-spec.schema.json', SolutionSpecSchema],
    ['SolutionLock', 'solution-lock.schema.json', SolutionLockSchema],
    ['RuntimeProfile', 'runtime-profile.schema.json', RuntimeProfileSchema],
    ['RuntimeCapabilities', 'runtime-capabilities.schema.json', RuntimeCapabilitiesSchema],
    ['RuntimeTopology', 'runtime-topology.schema.json', RuntimeTopologySchema],
    ['BundleTopology', 'bundle-topology.schema.json', BundleTopologySchema],
    ['ModelProfile', 'model-profile.schema.json', ModelProfileSchema],
    ['IdentityProfile', 'identity-profile.schema.json', IdentityProfileSchema],
  ];

  return entries.map(([kind, file, schema]) => ({ kind, file, schema: emitJsonSchema(schema) }));
}
