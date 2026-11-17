// Seam: `mastraGenerator.generateApp` — the generated mastra-app source tree.
//
// The tree is the deliverable: it is reviewed by an FDE engineer, diffed between
// builds and shipped to a customer. So the tests assert the properties the build
// contract promises — bundle-root-relative sorted paths, explicit modes, JSON in
// canonical form, every version taken from the lock or the Profile, and a
// `sourceDigest` that is exactly the digest of the files returned — and then the
// content that makes the read-only slice real: one agent, one two-step workflow,
// two read-only Tools, and a Dockerfile that boots it.
import { describe, expect, it } from 'vitest';

import { digestFiles } from '@fde/spec';
import type { GeneratedFile } from '@fde/runtime-generator';

import { mastraGenerator } from '../src/index.js';
import { generateInput, mutatedGenerateInput, specBody } from './support/fixtures.js';

const app = () => mastraGenerator.generateApp(generateInput());

const file = (files: ReadonlyArray<GeneratedFile>, path: string): GeneratedFile => {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`${path} was not generated; got:\n${files.map((f) => f.path).join('\n')}`);
  return found;
};

const content = (files: ReadonlyArray<GeneratedFile>, path: string): string => file(files, path).content;

const json = (files: ReadonlyArray<GeneratedFile>, path: string): Record<string, any> =>
  JSON.parse(content(files, path)) as Record<string, any>;

describe('the file set', () => {
  it('is bundle-root-relative and sorted by path', () => {
    const paths = app().files.map((entry) => entry.path);

    expect(paths).toEqual([...paths].sort());
    expect(paths.every((path) => path.startsWith('mastra-app/'))).toBe(true);
    expect(paths).toContain('mastra-app/Dockerfile');
    expect(paths).toContain('mastra-app/package.json');
  });

  it('gives every file an explicit mode, so generation never depends on the umask', () => {
    expect(app().files.every((entry) => entry.mode === 0o644)).toBe(true);
  });

  it('generates exactly the read-only slice plus its Run API: no approval, no write Tool, no memory', () => {
    const paths = app().files.map((entry) => entry.path);

    expect(paths).toEqual([
      'mastra-app/Dockerfile',
      'mastra-app/package.json',
      'mastra-app/src/agents/triage-agent.ts',
      'mastra-app/src/index.ts',
      'mastra-app/src/mastra.ts',
      'mastra-app/src/migrate.ts',
      'mastra-app/src/runtime/canonical.ts',
      'mastra-app/src/runtime/config.ts',
      'mastra-app/src/runtime/context-client.ts',
      'mastra-app/src/runtime/errors.ts',
      'mastra-app/src/runtime/execution-context.ts',
      'mastra-app/src/runtime/identity.ts',
      'mastra-app/src/runtime/ids.ts',
      'mastra-app/src/runtime/retrieval.ts',
      'mastra-app/src/runtime/roles.ts',
      'mastra-app/src/runtime/router.ts',
      'mastra-app/src/runtime/run-registry.ts',
      'mastra-app/src/runtime/run-service.ts',
      'mastra-app/src/runtime/runtime-info.ts',
      'mastra-app/src/runtime/sse.ts',
      'mastra-app/src/runtime/state-store.ts',
      'mastra-app/src/runtime/wire.ts',
      'mastra-app/src/schemas/claims_lookup_input.ts',
      'mastra-app/src/schemas/claims_lookup_output.ts',
      'mastra-app/src/schemas/triage_output.ts',
      'mastra-app/src/tools/claims-lookup.ts',
      'mastra-app/src/tools/retrieve-context.ts',
      'mastra-app/src/workflows/document-triage-flow.ts',
      'mastra-app/tsconfig.json',
    ]);
  });

  it('bakes the Customer and the Solution, which a token asserts and an install cannot change', () => {
    const config = content(app().files, 'mastra-app/src/runtime/config.ts');

    expect(config).toContain("export const TENANT_ID = 'acme';");
    expect(config).toContain("export const SOLUTION_ID = 'claims-triage';");
    // One bundle is one Customer (ADR-0006 §4.5): no environment variable renames the tenant.
    expect(config).not.toContain('FDE_TENANT_ID');
  });

  it('names the Spec construct each file came from, so the tree is reviewable', () => {
    const agent = content(app().files, 'mastra-app/src/agents/triage-agent.ts');
    const workflow = content(app().files, 'mastra-app/src/workflows/document-triage-flow.ts');

    expect(agent).toMatch(/solution\.yaml#\/spec\/agents\/triage-agent/);
    expect(workflow).toMatch(/solution\.yaml#\/spec\/workflows\/document-triage-flow/);
  });
});

describe('the digest', () => {
  it('is the digest of exactly the files returned', () => {
    const { files, sourceDigest } = app();
    const recomputed = digestFiles(files.map(({ path, content: body }) => ({ path, content: body })));

    expect(sourceDigest).toBe(recomputed.digest);
  });

  it('covers the Dockerfile, which is part of the tree and not a side channel', () => {
    const generated = app();

    expect(generated.files.map((entry) => entry.path)).toContain(generated.dockerfile.path);
    expect(content(generated.files, generated.dockerfile.path)).toBe(generated.dockerfile.content);
  });
});

describe('the emitted app', () => {
  it('pins every dependency from the Runtime Profile, with no range', () => {
    const pkg = json(app().files, 'mastra-app/package.json');

    expect(pkg['dependencies']).toEqual({ '@mastra/core': '1.83.0' });
    expect(Object.values(pkg['dependencies'] as Record<string, string>).every((version) => /^\d+\.\d+\.\d+$/.test(version))).toBe(
      true,
    );
  });

  it('pins the Node runtime from the lock, not from the generator', () => {
    const pkg = json(app().files, 'mastra-app/package.json');

    expect(pkg['engines']).toEqual({ node: '22.13.0' });
  });

  it('boots the Mastra instance from a Dockerfile that runs the generated entrypoint', () => {
    const generated = app();
    const dockerfile = generated.dockerfile.content;

    expect(generated.entrypoint).toEqual(['node', '--experimental-strip-types', 'src/index.ts']);
    expect(dockerfile).toMatch(/^FROM node:22\.13\.0-bookworm-slim$/m);
    expect(dockerfile).toMatch(/^COPY src \.\/src$/m);
    expect(dockerfile).toContain('CMD ["node", "--experimental-strip-types", "src/index.ts"]');
    expect(dockerfile).not.toMatch(/\blatest\b/);
  });

  it('declares the runtime app component without inventing topology the slice does not own', () => {
    const { components } = app();

    expect(components).toEqual([
      {
        name: 'mastra-app',
        role: 'runtime-app',
        image: { build: { context: 'mastra-app', dockerfile: 'Dockerfile' } },
        ports: [{ name: 'http', containerPort: 4111, expose: true }],
        // Readiness, not liveness: the container is checked against the handshake (§9.3),
        // with the probe command the image's own runtime can execute.
        healthCheck: {
          path: '/readyz',
          port: 4111,
          command: [
            'node',
            '-e',
            "fetch('http://127.0.0.1:4111/readyz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))",
          ],
        },
      },
    ]);
  });

  it('carries the profile identity as build args, all of them pinned inputs', () => {
    const input = generateInput();
    const { buildArgs } = mastraGenerator.generateApp(input);

    expect(buildArgs).toEqual({
      FDE_CONTRACT_VERSION: input.lock.runtime.contractVersion,
      FDE_GENERATOR_VERSION: input.profile.spec.generator.version,
      FDE_PROFILE_DIGEST: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      FDE_RUNTIME_PROFILE: 'mastra-1.83-node22@1.0.0',
    });
  });
});

describe('the agent', () => {
  it('bakes the pinned instructions verbatim', () => {
    const input = generateInput();
    const prompt = input.files?.['files/prompts/triage.md'];
    const agent = content(app().files, 'mastra-app/src/agents/triage-agent.ts');

    expect(prompt).toBeDefined();
    for (const line of (prompt ?? '').split('\n').filter((text) => text.trim().length > 20)) {
      expect(agent.replace(/\\`/g, '`')).toContain(line.trim());
    }
  });

  it('bakes the Model Profile: provider, model version and params come from the platform artifact', () => {
    const input = generateInput();
    const agent = content(app().files, 'mastra-app/src/agents/triage-agent.ts');
    const model = input.modelProfiles?.['standard'];

    expect(model?.spec.provider).toBe('azure-openai');
    expect(agent).toContain(`model: '${model?.spec.provider}/${model?.spec.model}'`);
    expect(agent).toMatch(/"temperature": 0\.1/);
    expect(agent).toMatch(/"maxOutputTokens": 2000/);
  });

  it('offers exactly the Tools the Spec lists', () => {
    const agent = content(app().files, 'mastra-app/src/agents/triage-agent.ts');

    expect(agent).toMatch(/tools: \{ claimsLookup, retrieveContext \}/);
    expect(agent).not.toMatch(/claimDecision/);
  });
});

describe('the workflow', () => {
  it('has the two steps the read-only slice declares, in order, with the declared ids', () => {
    const workflow = content(app().files, 'mastra-app/src/workflows/document-triage-flow.ts');

    expect(workflow).toMatch(/id: 'context'/);
    expect(workflow).toMatch(/id: 'triage'/);
    expect(workflow.indexOf("id: 'context'")).toBeLessThan(workflow.indexOf("id: 'triage'"));
    expect(workflow).toMatch(/\.then\(contextStep\)\s*\.then\(triageStep\)\s*\.commit\(\)/);
  });

  it('bakes the recipe and the budget declared by the recipeBinding', () => {
    const workflow = content(app().files, 'mastra-app/src/workflows/document-triage-flow.ts');
    const binding = generateInput().spec.spec.semantic?.recipeBindings['claims-context'];

    expect(binding?.budget).toEqual({ maxNodes: 50, maxTokens: 4000, maxHops: 2 });
    expect(workflow).toContain("recipe_id: 'claims-context'");
    expect(workflow).toMatch(/"max_nodes": 50/);
    expect(workflow).toMatch(/"max_hops": 2/);
  });

  it("uses the agent step's pinned output schema as the agent's structured output", () => {
    const workflow = content(app().files, 'mastra-app/src/workflows/document-triage-flow.ts');

    expect(workflow).toMatch(/from '\.\.\/schemas\/triage_output\.ts'/);
    expect(workflow).toMatch(/structuredOutput: \{ schema: triageOutputSchema \}/);
  });
});

describe('the tools', () => {
  it('defines the builtin Tool from the platform catalog, not from a Spec schema', () => {
    const tool = content(app().files, 'mastra-app/src/tools/retrieve-context.ts');

    expect(tool).toMatch(/id: 'retrieve-context'/);
    expect(tool).toMatch(/read-only/);
    expect(tool).toContain('contextClient.retrieve');
  });

  it('defines the connector Tool against the pinned JSON Schema and the typed operation', () => {
    const tool = content(app().files, 'mastra-app/src/tools/claims-lookup.ts');

    expect(tool).toMatch(/from '\.\.\/schemas\/claims_lookup_input\.ts'/);
    expect(tool).toMatch(/from '\.\.\/schemas\/claims_lookup_output\.ts'/);
    expect(tool).toMatch(/connector_id: 'claims-db'/);
    expect(tool).toMatch(/operation: 'lookupClaim'/);
  });

  it('bakes each referenced schema file as its own module, with the pinned digest in the header', () => {
    const input = generateInput();
    const schema = content(app().files, 'mastra-app/src/schemas/claims_lookup_input.ts');

    expect(schema).toContain(input.lock.spec.files['files/schemas/claims-lookup.input.json']);
    expect(schema).toMatch(/export const claimsLookupInputSchema: PublicSchema = \{/);
    const literal = /export const claimsLookupInputSchema: PublicSchema = ([\s\S]*);\n$/u.exec(schema)?.[1] ?? '';
    expect(JSON.parse(literal)).toEqual(JSON.parse(input.files?.['files/schemas/claims-lookup.input.json'] ?? '{}'));
  });

  it('keeps every call behind one context-service client, so the seam stays single', () => {
    const client = content(app().files, 'mastra-app/src/runtime/context-client.ts');
    const config = content(app().files, 'mastra-app/src/runtime/config.ts');

    expect(client).toMatch(/\/v1\/context\/retrieve/);
    expect(client).toMatch(/\/v1\/connectors\//);
    // The address lives in `config.ts`, because the handshake and the data plane must
    // resolve the same one (`FDE_CONTEXT_SERVICE_URL` moves both or neither).
    expect(config).toMatch(/export const CONTEXT_SERVICE_URL = 'http:\/\/context-service:8011'/);
    expect(client).toMatch(/this\.baseUrl = options\.baseUrl \?\? loadConfig\(\)\.contextServiceUrl/);
  });
});

describe('a second shape of the same slice', () => {
  it('emits a tool step for a read-only Tool, which the slice does support', () => {
    const input = mutatedGenerateInput((draft) => {
      (specBody(draft)['workflows']['document-triage-flow'].steps as Record<string, unknown>[]).push({
        id: 'lookup',
        type: 'tool',
        tool: 'claims-lookup',
      });
    });

    const workflow = content(mastraGenerator.generateApp(input).files, 'mastra-app/src/workflows/document-triage-flow.ts');

    expect(workflow).toMatch(/id: 'lookup'/);
    expect(workflow).toMatch(/\.then\(lookupStep\)/);
  });

  it('follows the Spec when it drops a Tool from the agent, leaving an unused definition', () => {
    const input = mutatedGenerateInput((draft) => {
      specBody(draft)['agents']['triage-agent'].tools = ['retrieve-context'];
    });

    const generated = mastraGenerator.generateApp(input);

    expect(content(generated.files, 'mastra-app/src/agents/triage-agent.ts')).toMatch(/tools: \{ retrieveContext \}/);
    expect(generated.files.map((entry) => entry.path)).not.toContain('mastra-app/src/tools/claims-lookup.ts');
  });
});
