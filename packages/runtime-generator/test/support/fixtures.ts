import { parseSolutionLock, parseSolutionSpec, parseRuntimeProfile } from '@fde/spec';
import type { RuntimeProfile, SolutionLock, SolutionSpec } from '@fde/spec';

import type { RuntimeValidationInput } from '../../src/index.js';
import { paths, readYaml } from './repo.js';

/** Test mutations are intentionally loose; the Spec is re-parsed after each one. */
export type Mutable = Record<string, any>;

export const exampleSpecDocument = (): Mutable => readYaml<Mutable>(paths.exampleSpec);

export const parseSpec = (document: Mutable): SolutionSpec => {
  const parsed = parseSolutionSpec(document);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
  return parsed.value;
};

export const exampleSpec = (): SolutionSpec => parseSpec(exampleSpecDocument());

/** Apply a mutation to a fresh copy of the checked-in Acme Spec and re-parse it. */
export const mutatedSpec = (change: (document: Mutable) => void): SolutionSpec => {
  const document = structuredClone(exampleSpecDocument());
  change(document);
  return parseSpec(document);
};

export const specBody = (document: Mutable): Mutable => document['spec'] as Mutable;

export const exampleProfile = (): RuntimeProfile => {
  const parsed = parseRuntimeProfile(readYaml(paths.exampleRuntimeProfile));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
  return parsed.value;
};

export const exampleLock = (): SolutionLock => {
  const parsed = parseSolutionLock(readYaml(paths.exampleLock));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors, null, 2));
  return parsed.value;
};

/**
 * The build gate's input for the reference path: the checked-in Profile and
 * lock, the Acme read-only Spec, the `acme-prod` Environment (restricted
 * network, `sqlite` state store) and the Connector's typed operation.
 */
export const validationInput = (): RuntimeValidationInput => ({
  spec: exampleSpec(),
  lock: exampleLock(),
  profile: exampleProfile(),
  environment: { name: 'acme-prod', networkClass: 'restricted', stateStore: { kind: 'sqlite', schemaVersion: '1' } },
  generator: { family: 'mastra', version: '1.0.0' },
  extensions: [
    { name: 'acme-claims-connector', version: '1.0.0', interface: 'connector', artifactKind: 'ts-package' },
  ],
  connectors: {
    'claims-db': {
      name: 'claims-db',
      operations: {
        lookupClaim: {
          inputSchema: 'files/schemas/claims-lookup.input.json',
          outputSchema: 'files/schemas/claims-lookup.output.json',
          sideEffects: 'read',
          scopes: ['claims:read'],
        },
        recordDecision: { sideEffects: 'write', scopes: ['claims:write'] },
      },
    },
  },
});
