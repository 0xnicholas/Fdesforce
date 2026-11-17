import { emitJsonSchema } from './schema-emit.js';
import { BundleTopologySchema, ContextServiceTopologySchema, RuntimeTopologySchema } from './schema/bundle-topology.js';
import { ContextEvalSuiteSchema } from './schema/context-eval-suite.js';
import { ContextPackageRevisionSchema, ContextPackageSchema } from './schema/context-package.js';
import { ContextRecipeSchema } from './schema/context-recipe.js';
import { ContextSourceSchema } from './schema/context-source.js';
import { DocumentMappingSchema, EntityMappingSchema } from './schema/entity-mapping.js';
import { IdentityProfileSchema } from './schema/identity-profile.js';
import { ModelProfileSchema } from './schema/model-profile.js';
import { PermissionProfileSchema } from './schema/permission-profile.js';
import { RuntimeCapabilitiesSchema } from './schema/runtime-capabilities.js';
import { RuntimeProfileSchema } from './schema/runtime-profile.js';
import { SemanticModelSchema } from './schema/semantic-model.js';
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
    ['ContextServiceTopology', 'context-service-topology.schema.json', ContextServiceTopologySchema],
    ['ModelProfile', 'model-profile.schema.json', ModelProfileSchema],
    ['IdentityProfile', 'identity-profile.schema.json', IdentityProfileSchema],
    ['CustomerContextPackage', 'customer-context-package.schema.json', ContextPackageSchema],
    ['ContextPackageRevision', 'context-package-revision.schema.json', ContextPackageRevisionSchema],
    ['SemanticModel', 'semantic-model.schema.json', SemanticModelSchema],
    ['ContextSource', 'context-source.schema.json', ContextSourceSchema],
    ['EntityMapping', 'entity-mapping.schema.json', EntityMappingSchema],
    ['DocumentMapping', 'document-mapping.schema.json', DocumentMappingSchema],
    ['ContextRecipe', 'context-recipe.schema.json', ContextRecipeSchema],
    ['PermissionProfile', 'permission-profile.schema.json', PermissionProfileSchema],
    ['ContextEvalSuite', 'context-eval-suite.schema.json', ContextEvalSuiteSchema],
  ];

  return entries.map(([kind, file, schema]) => ({ kind, file, schema: emitJsonSchema(schema) }));
}
