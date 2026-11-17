// Seam: `contracts/schemas` vs `@fde/spec`.
//
// The published contract and the executable Zod definition must describe the
// same document. Two mechanisms, because neither is sufficient alone:
//
//  1. structural diff — catches shape drift in both directions;
//  2. differential corpus — every document here is validated by both the contract
//     (Ajv) and the definition (`parse*`), and both must agree. This is what
//     pins the rules the structural diff cannot see (`uniqueItems`, `if/then`,
//     presence-exclusivity `oneOf`, `minProperties`).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  CapabilityIdSchema,
  ClassificationSchema,
  DigestSchema,
  diffContractShape,
  documentSchemas,
  emitJsonSchema,
  EntityIdSchema,
  RetentionClassSchema,
  RunIdSchema,
  SchemaVersionSchema,
  SemverSchema,
  SolutionIdSchema,
  TenantIdSchema,
  TraceIdSchema,
  UlidSchema,
  parseBundleTopology,
  parseRuntimeCapabilities,
  parseRuntimeProfile,
  parseRuntimeTopology,
  RuntimeCapabilitiesSchema,
  RuntimeProfileSchema,
  RuntimeTopologySchema,
  BundleTopologySchema,
} from '../src/index.js';
import type { ContractShapeInput } from '../src/index.js';
import type { ParseResult } from '../src/index.js';
import { paths, repoRoot } from './support/repo.js';

const schemaDir = join(repoRoot, paths.contractsSchemas);
const contractDocs = new Map<string, unknown>(
  readdirSync(schemaDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file, JSON.parse(readFileSync(join(schemaDir, file), 'utf8')) as unknown]),
);

// Ajv resolves relative refs against `$id`, so compile `$ref`s with the full URL.
// The contracts are trusted input; Ajv's strict-mode style opinions (`if` needs an
// explicit type, `required` must be declared on the same object) do not apply.
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const doc of contractDocs.values()) ajv.addSchema(doc as object);

const idOf = (file: string): string => {
  const doc = contractDocs.get(file) as { $id?: string } | undefined;
  if (doc?.$id === undefined) throw new Error(`contract ${file} has no $id`);
  return doc.$id;
};

const contractValidator = (file: string, root?: string) => {
  const key = `${idOf(file)}${root ?? ''}`;
  return ajv.getSchema(key) ?? ajv.compile({ $ref: key });
};

const shape = (definition: Parameters<typeof emitJsonSchema>[0], contractFile: string, contractRoot?: string): ContractShapeInput =>
  contractRoot === undefined
    ? { definition: emitJsonSchema(definition), contractFile }
    : { definition: emitJsonSchema(definition), contractFile, contractRoot };

const describeDiffs = (input: ContractShapeInput): string => {
  const report = diffContractShape(input, contractDocs);
  return JSON.stringify(report.diffs, null, 2);
};

describe('exported JSON Schema documents', () => {
  it('exports one schema per document kind, all draft 2020-12', () => {
    const schemas = documentSchemas();

    expect(schemas.map((entry) => entry.kind)).toEqual([
      'SolutionSpec',
      'SolutionLock',
      'RuntimeProfile',
      'RuntimeCapabilities',
      'RuntimeTopology',
      'BundleTopology',
      'ModelProfile',
      'IdentityProfile',
    ]);
    for (const entry of schemas) {
      expect(entry.schema['$schema']).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(entry.file.endsWith('.schema.json')).toBe(true);
    }
  });

  it('keeps every document that also lives in contracts/ in the comparison', () => {
    const mirrored = new Set(['runtime-profile.schema.json', 'runtime-capabilities.schema.json', 'bundle-topology.schema.json']);
    const exported = documentSchemas().map((entry) => entry.file);

    // Solution Spec, lock, Model Profile and the identity profile are workbench
    // documents with no published wire contract; everything else must be compared below.
    expect(exported.filter((file) => mirrored.has(file)).sort()).toEqual([...mirrored].sort());
    expect(exported.filter((file) => !mirrored.has(file)).sort()).toEqual([
      'identity-profile.schema.json',
      'model-profile.schema.json',
      'runtime-topology.schema.json',
      'solution-lock.schema.json',
      'solution-spec.schema.json',
    ]);
  });
});

describe('shared scalars match common.schema.json', () => {
  const scalars: Record<string, Parameters<typeof emitJsonSchema>[0]> = {
    Ulid: UlidSchema,
    RunId: RunIdSchema,
    TenantId: TenantIdSchema,
    SolutionId: SolutionIdSchema,
    CapabilityId: CapabilityIdSchema,
    EntityId: EntityIdSchema,
    TraceId: TraceIdSchema,
    Digest: DigestSchema,
    Semver: SemverSchema,
    SchemaVersion: SchemaVersionSchema,
    Classification: ClassificationSchema,
    RetentionClass: RetentionClassSchema,
  };

  for (const [name, schema] of Object.entries(scalars)) {
    it(name, () => {
      const input: ContractShapeInput = {
        definition: emitJsonSchema(schema),
        contractFile: 'common.schema.json',
        contractRoot: `#/$defs/${name}`,
      };
      expect(diffContractShape(input, contractDocs).diffs, describeDiffs(input)).toEqual([]);
    });
  }
});

describe('structural drift: @fde/spec vs contracts/', () => {
  it('RuntimeProfile matches runtime-profile.schema.json', () => {
    const input = shape(RuntimeProfileSchema, 'runtime-profile.schema.json');
    expect(diffContractShape(input, contractDocs).diffs, describeDiffs(input)).toEqual([]);
  });

  it('RuntimeCapabilities matches runtime-capabilities.schema.json', () => {
    const input = shape(RuntimeCapabilitiesSchema, 'runtime-capabilities.schema.json');
    expect(diffContractShape(input, contractDocs).diffs, describeDiffs(input)).toEqual([]);
  });

  it('RuntimeTopology matches bundle-topology.schema.json#/$defs/RuntimeTopology', () => {
    const input = shape(RuntimeTopologySchema, 'bundle-topology.schema.json', '#/$defs/RuntimeTopology');
    expect(diffContractShape(input, contractDocs).diffs, describeDiffs(input)).toEqual([]);
  });

  it('BundleTopology matches bundle-topology.schema.json#/$defs/BundleTopology', () => {
    const input = shape(BundleTopologySchema, 'bundle-topology.schema.json', '#/$defs/BundleTopology');
    expect(diffContractShape(input, contractDocs).diffs, describeDiffs(input)).toEqual([]);
  });

  it('names every rule it cannot compare structurally', () => {
    // A new entry here means a new contract rule needs a corpus case before the
    // drift check is honest; a missing entry means the comparison silently started
    // covering (or ignoring) something.
    const capabilities = diffContractShape(
      shape(RuntimeCapabilitiesSchema, 'runtime-capabilities.schema.json'),
      contractDocs,
    ).stripped.map((rule) => rule.rule);
    expect(new Set(capabilities)).toEqual(new Set(['if/then', 'uniqueItems']));
    // One `degraded ⇒ limitations` rule per capability group.
    expect(capabilities.filter((rule) => rule === 'if/then')).toHaveLength(10);

    const profile = diffContractShape(shape(RuntimeProfileSchema, 'runtime-profile.schema.json'), contractDocs).stripped;
    expect(profile.map((rule) => rule.rule)).toContain('minProperties');

    const topology = diffContractShape(
      shape(RuntimeTopologySchema, 'bundle-topology.schema.json', '#/$defs/RuntimeTopology'),
      contractDocs,
    ).stripped;
    // `EnvVar` and `ImageSpec` express "exactly one of" as a `oneOf`.
    expect(topology.filter((rule) => rule.rule === 'presence-oneOf')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Differential corpus
// ---------------------------------------------------------------------------

interface Case {
  name: string;
  document: unknown;
  parse: (document: unknown) => ParseResult<unknown>;
  contract: () => (data: unknown) => boolean;
}

const profileDocument = (): Record<string, unknown> => ({
  apiVersion: 'fde.dev/v0',
  kind: 'RuntimeProfile',
  metadata: { name: 'mastra-1.83-node22', version: '1.0.0' },
  spec: {
    generator: { name: 'mastra', version: '1.0.0' },
    family: 'mastra',
    language: 'typescript',
    runtimeVersion: '1.83.0',
    contractVersion: '1.4.0',
    packages: { '@mastra/core': '1.83.0' },
    capabilities: {
      durableWorkflow: { support: 'native', durabilityModes: ['sync'], autoResume: 'native' },
      hitl: {
        support: 'native',
        interrupt: 'native',
        resume: 'native',
        approvalResource: 'adapter',
        expiry: 'adapter',
        multipleInterrupts: 'native',
        consume: 'adapter',
      },
      streaming: { support: 'native', tokenStream: 'native', toolEvents: 'native', interruptEvents: 'adapter', transport: 'native' },
      observability: { support: 'native', otel: 'native', evalHooks: 'native' },
      memory: { support: 'native', thread: 'native', longTerm: 'native', ttl: 'adapter' },
      tools: { support: 'native', native: 'native', mcp: 'adapter', connectorOperations: 'adapter' },
      extensions: { support: 'adapter', artifactKinds: ['ts-package'] },
      stateStore: { support: 'native', kinds: ['sqlite'], schemaVersion: '1', encryption: 'adapter', retention: 'adapter' },
      topology: { support: 'native', modes: ['split'], singleWriter: true },
      offline: { support: 'native' },
    },
    licensing: { runtime: 'Apache-2.0', requiresLicenseKey: false, egress: false },
  },
});

type Mutable = Record<string, any>; // corpus mutations are intentionally loose

const withProfileSpec = (mutate: (spec: Mutable) => void): Record<string, unknown> => {
  const document = profileDocument() as Mutable;
  mutate(document['spec'] as Mutable);
  return document;
};

const capabilitiesDocument = (): Record<string, unknown> =>
  ({ ...(profileDocument() as Mutable)['spec'] })['capabilities'] as Record<string, unknown>;

const topologyDocument = (): Record<string, unknown> => ({
  apiVersion: 'fde.dev/v0',
  kind: 'RuntimeTopology',
  metadata: {
    profile: 'mastra-1.83-node22@1.0.0',
    profileDigest: `sha256:${'a'.repeat(64)}`,
    generatorVersion: '1.0.0',
  },
  spec: {
    components: [
      {
        name: 'mastra-app',
        role: 'runtime-app',
        image: { image: 'ghcr.io/acme/fde-mastra@sha256:abc' },
        env: [
          { name: 'LOG_LEVEL', value: 'info' },
          { name: 'CONTEXT_TOKEN', secretRef: { store: 'vault', key: 'token' } },
        ],
        ports: [{ name: 'http', containerPort: 4111, expose: true }],
        volumes: [{ name: 'mastra-state', mountPath: '/data' }],
      },
    ],
    volumes: [{ name: 'mastra-state', size: '10Gi', backup: true }],
    jobs: [{ name: 'migrate', owner: 'platform', steps: [{ id: 'migrate', command: ['/bin/migrate'] }] }],
    startupOrder: ['mastra-app'],
    secretBindings: [{ secretRef: { store: 'vault', key: 'token' }, target: 'env', name: 'CONTEXT_TOKEN' }],
    deploymentNaming: { componentNameTemplate: '{{component}}' },
  },
});

const bundleTopologyDocument = (): Record<string, unknown> => {
  const document = topologyDocument() as Mutable;
  document['kind'] = 'BundleTopology';
  document['metadata'] = {
    solution: 'claims-triage',
    revision: 1,
    profile: 'mastra-1.83-node22@1.0.0',
    profileDigest: `sha256:${'b'.repeat(64)}`,
  };
  (document['spec'] as Mutable)['networks'] = [{ name: 'internal', internal: true }];
  return document;
};

const cases: Case[] = [
  {
    name: 'runtime profile: valid',
    document: profileDocument(),
    parse: parseRuntimeProfile,
    contract: () => contractValidator('runtime-profile.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime profile: empty package pins (minProperties)',
    document: withProfileSpec((spec) => {
      spec['packages'] = {};
    }),
    parse: parseRuntimeProfile,
    contract: () => contractValidator('runtime-profile.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime profile: degraded group without limitations (if/then)',
    document: withProfileSpec((spec) => {
      (spec['capabilities'] as Mutable)['hitl']['support'] = 'degraded';
    }),
    parse: parseRuntimeProfile,
    contract: () => contractValidator('runtime-profile.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime profile: duplicate limitations (uniqueItems)',
    document: withProfileSpec((spec) => {
      (spec['capabilities'] as Mutable)['hitl']['support'] = 'degraded';
      (spec['capabilities'] as Mutable)['hitl']['limitations'] = ['no expiry job', 'no expiry job'];
    }),
    parse: parseRuntimeProfile,
    contract: () => contractValidator('runtime-profile.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime profile: unknown field',
    document: withProfileSpec((spec) => {
      spec['runtimeFamily'] = 'mastra';
    }),
    parse: parseRuntimeProfile,
    contract: () => contractValidator('runtime-profile.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime capabilities: valid',
    document: capabilitiesDocument(),
    parse: parseRuntimeCapabilities,
    contract: () => contractValidator('runtime-capabilities.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime capabilities: missing group',
    document: (() => {
      const document = capabilitiesDocument() as Mutable;
      delete document['offline'];
      return document;
    })(),
    parse: parseRuntimeCapabilities,
    contract: () => contractValidator('runtime-capabilities.schema.json') as (data: unknown) => boolean,
  },
  {
    name: 'runtime topology: valid, both env var forms',
    document: topologyDocument(),
    parse: parseRuntimeTopology,
    // The topology root is a `oneOf`; RuntimeTopology has no `networks`.
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/RuntimeTopology') as (data: unknown) => boolean,
  },
  {
    name: 'runtime topology: env var with value and secretRef (presence oneOf)',
    document: (() => {
      const document = topologyDocument() as Mutable;
      ((document['spec'] as Mutable)['components'] as Mutable[])[0]!['env'] = [
        { name: 'TOKEN', value: 'x', secretRef: { store: 'vault', key: 'token' } },
      ];
      return document;
    })(),
    parse: parseRuntimeTopology,
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/RuntimeTopology') as (data: unknown) => boolean,
  },
  {
    name: 'runtime topology: image with pinned image and build (presence oneOf)',
    document: (() => {
      const document = topologyDocument() as Mutable;
      ((document['spec'] as Mutable)['components'] as Mutable[])[0]!['image'] = {
        image: 'ghcr.io/acme/fde-mastra@sha256:abc',
        build: { context: '.', dockerfile: 'Dockerfile' },
      };
      return document;
    })(),
    parse: parseRuntimeTopology,
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/RuntimeTopology') as (data: unknown) => boolean,
  },
  {
    name: 'runtime topology: component without image',
    document: (() => {
      const document = topologyDocument() as Mutable;
      delete (((document['spec'] as Mutable)['components'] as Mutable[])[0] as Mutable)['image'];
      return document;
    })(),
    parse: parseRuntimeTopology,
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/RuntimeTopology') as (data: unknown) => boolean,
  },
  {
    name: 'runtime topology: duplicate startup order (uniqueItems)',
    document: (() => {
      const document = topologyDocument() as Mutable;
      (document['spec'] as Mutable)['startupOrder'] = ['mastra-app', 'mastra-app'];
      return document;
    })(),
    parse: parseRuntimeTopology,
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/RuntimeTopology') as (data: unknown) => boolean,
  },
  {
    name: 'bundle topology: valid',
    document: bundleTopologyDocument(),
    parse: parseBundleTopology,
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/BundleTopology') as (data: unknown) => boolean,
  },
  {
    name: 'bundle topology: wrong kind for the root',
    document: (() => {
      const document = bundleTopologyDocument() as Mutable;
      document['kind'] = 'RuntimeTopology';
      return document;
    })(),
    parse: parseBundleTopology,
    contract: () => contractValidator('bundle-topology.schema.json', '#/$defs/BundleTopology') as (data: unknown) => boolean,
  },
];

describe('differential corpus: contract and definition agree', () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const validate = testCase.contract();
      const contractAccepts = validate(testCase.document);
      const result = testCase.parse(testCase.document);

      expect(result.ok, `definition rejected a document the contract accepts: ${JSON.stringify((result as { errors: unknown }).errors ?? [])}`).toBe(
        contractAccepts,
      );
    });
  }
});
