// Seam: the exported JSON Schema artifacts themselves.
//
// `documentSchemas()` is the public export other tools (and future non-TS
// consumers) validate against. A Zod→JSON Schema emission bug would not show up
// in `parse*` tests, so every artifact is compiled with a real draft-2020-12
// validator here, and the checked-in documents are validated through it.
//
// Refinements (uniqueness, cross-field rules, presence-exclusivity) are not
// expressible in JSON Schema and are enforced by `parse*` + the differential
// corpus instead; this file covers the shape.
import { describe, expect, it } from 'vitest';

import { Ajv2020 } from 'ajv/dist/2020.js';

import { documentSchemas } from '../src/index.js';
import { paths, readYaml } from './support/repo.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemas = new Map(documentSchemas().map((entry) => [entry.kind, entry.schema]));

const compiled = (kind: string) => {
  const schema = schemas.get(kind);
  if (schema === undefined) throw new Error(`no exported schema for ${kind}`);
  // `compile` throws on an invalid schema document — that is the point.
  return ajv.compile(schema);
};

const accepts = (kind: string, document: unknown): void => {
  const validate = compiled(kind);
  if (!validate(document)) {
    throw new Error(`${kind} rejected a conforming document: ${ajv.errorsText(validate.errors)}`);
  }
};

const exampleCapabilities = () => {
  const profile = readYaml<{ spec: { capabilities: unknown } }>(paths.exampleRuntimeProfile);
  return profile.spec.capabilities;
};

describe('every exported schema is a compilable draft 2020-12 document', () => {
  for (const entry of documentSchemas()) {
    it(`${entry.file} compiles`, () => {
      expect(entry.schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(() => ajv.compile(entry.schema)).not.toThrow();
    });
  }
});

describe('exported schemas accept the checked-in documents', () => {
  it('SolutionSpec accepts the example and the prototype Spec', () => {
    accepts('SolutionSpec', readYaml(paths.exampleSpec));
    accepts('SolutionSpec', readYaml(paths.prototypeSpec));
  });

  it('SolutionLock accepts the example and the prototype lock', () => {
    accepts('SolutionLock', readYaml(paths.exampleLock));
    accepts('SolutionLock', readYaml(paths.prototypeLock));
  });

  it('RuntimeProfile and RuntimeCapabilities accept the example profile', () => {
    accepts('RuntimeProfile', readYaml(paths.exampleRuntimeProfile));
    accepts('RuntimeCapabilities', exampleCapabilities());
  });

  it('ModelProfile accepts the example and prototype profiles', () => {
    for (const path of [
      paths.exampleModelProfile,
      paths.exampleFallbackProfile,
      paths.prototypeModelProfile,
      paths.prototypeFallbackProfile,
    ]) {
      accepts('ModelProfile', readYaml(path));
    }
  });

  it('RuntimeTopology and BundleTopology accept split-topology documents', () => {
    const runtime = {
      apiVersion: 'fde.dev/v0',
      kind: 'RuntimeTopology',
      metadata: {
        profile: 'mastra-1.83-node22@1.0.0',
        profileDigest: `sha256:${'a'.repeat(64)}`,
        generatorVersion: '1.0.0',
      },
      spec: {
        components: [
          { name: 'mastra-app', role: 'runtime-app', image: { image: 'ghcr.io/acme/app@sha256:abc' } },
        ],
        volumes: [],
        jobs: [],
        startupOrder: ['mastra-app'],
        secretBindings: [],
        deploymentNaming: { componentNameTemplate: 'fde-{{deployment_id}}-{{component}}' },
      },
    };

    accepts('RuntimeTopology', runtime);
    accepts('BundleTopology', {
      apiVersion: 'fde.dev/v0',
      kind: 'BundleTopology',
      metadata: {
        solution: 'claims-triage',
        revision: 1,
        profile: 'mastra-1.83-node22@1.0.0',
        profileDigest: `sha256:${'a'.repeat(64)}`,
      },
      spec: { ...runtime.spec, networks: [{ name: 'internal', internal: true }] },
    });
  });
});

describe('exported schemas stay closed', () => {
  it('rejects unknown keys on a Solution Spec', () => {
    const spec = readYaml<Record<string, any>>(paths.exampleSpec);
    const validate = compiled('SolutionSpec');

    expect(validate({ ...spec, spec: { ...spec['spec'], capabilties: {} } })).toBe(false);
  });

  it('rejects a RuntimeProfile that omits a capability group', () => {
    const profile = readYaml<Record<string, any>>(paths.exampleRuntimeProfile);
    const capabilities = { ...profile['spec']['capabilities'] };
    delete capabilities['offline'];
    const validate = compiled('RuntimeProfile');

    expect(validate({ ...profile, spec: { ...profile['spec'], capabilities } })).toBe(false);
  });
});
