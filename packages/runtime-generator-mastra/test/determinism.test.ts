// Seam: A11 — the same pinned inputs must produce the same bytes.
//
// A `sourceDigest` that moves between two builds of the same Spec destroys the
// audit and signature story: nobody can tell a real change from noise, and
// `fde verify` cannot tell drift from a fresh build. So generation may not read
// the clock, randomness, environment values, the network or the disk, and it may
// not depend on the order a YAML file happens to list its map keys.
import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@fde/spec';

import { mastraGenerator } from '../src/index.js';
import { generateInput, mutatedGenerateInput, specBody } from './support/fixtures.js';

const generate = (input = generateInput()) => mastraGenerator.generateApp(input);

const reverseKeys = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).reverse());

describe('generation is a pure function of its input', () => {
  it('produces the same tree twice', () => {
    const first = generate();
    const second = generate();

    expect(canonicalJson(second)).toBe(canonicalJson(first));
  });

  it('does not depend on the key order of the Spec maps', () => {
    // Reordering `agents`/`tools`/`workflows` is not a semantic change, so it must
    // not be a build change either.
    const input = generateInput();
    const reordered = {
      ...input,
      spec: {
        ...input.spec,
        spec: {
          ...input.spec.spec,
          agents: reverseKeys(input.spec.spec.agents ?? {}),
          tools: reverseKeys(input.spec.spec.tools ?? {}),
          workflows: reverseKeys(input.spec.spec.workflows ?? {}),
        },
      },
    };

    expect(generate(reordered as typeof input).sourceDigest).toBe(generate(input).sourceDigest);
  });

  it('changes when a pinned input changes', () => {
    const changed = mutatedGenerateInput((draft) => {
      draft['files']['files/prompts/triage.md'] = `${draft['files']['files/prompts/triage.md']}\nEighth rule.\n`;
    });

    expect(generate(changed).sourceDigest).not.toBe(generate().sourceDigest);
  });

  it('changes when the Model Profile changes', () => {
    const changed = mutatedGenerateInput((draft) => {
      draft['modelProfiles']['standard'].spec.params.temperature = 0.9;
    });

    expect(generate(changed).sourceDigest).not.toBe(generate().sourceDigest);
  });
});

describe('the generated files carry no build-time entropy', () => {
  // A runtime needs a clock and randomness (Run ids are ULIDs, traces are random,
  // heartbeats have timestamps, backoff has jitter) and a deployment needs
  // configuration. What must not happen is entropy *anywhere else*: a timestamp
  // baked into a prompt, a random id in a manifest, an environment value that
  // changes the tree. So the scan names the four modules allowed to look at the
  // world at runtime, and everything else has to be a pure function of the input.
  const RUNTIME_INPUTS: Record<string, ReadonlyArray<string>> = {
    'mastra-app/src/runtime/ids.ts': ['new Date', 'Date.now'],
    'mastra-app/src/runtime/context-client.ts': ['Date.now', 'Math.random'],
    'mastra-app/src/runtime/run-registry.ts': ['Date.now'],
    'mastra-app/src/runtime/config.ts': ['process.env'],
  };

  it('reads the clock, randomness or the environment only in the modules that must', () => {
    const offenders = generate().files.flatMap((entry) =>
      [
        { pattern: /\bnew Date\b/, why: 'a timestamp' },
        { pattern: /\bDate\.now\b/, why: 'a timestamp' },
        { pattern: /\bMath\.random\b/, why: 'randomness' },
        { pattern: /\brandomUUID\b/, why: 'a random ID' },
        { pattern: /\bprocess\.env\b/, why: 'an environment read' },
      ]
        .filter(({ pattern }) => pattern.test(entry.content))
        .filter(({ pattern }) => {
          const allowed = RUNTIME_INPUTS[entry.path] ?? [];
          return !allowed.some((token) => pattern.test(token));
        })
        .map(({ why }) => `${entry.path}: ${why}`),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the manifests themselves free of the clock and the machine', () => {
    for (const path of ['mastra-app/package.json', 'mastra-app/tsconfig.json', 'mastra-app/Dockerfile']) {
      const body = generate().files.find((entry) => entry.path === path)?.content ?? '';

      expect(body).not.toMatch(/\bDate\b|\brandom|process\.env/);
    }
  });

  it('writes JSON in canonical form: sorted keys, two spaces, one trailing newline', () => {
    for (const path of ['mastra-app/package.json', 'mastra-app/tsconfig.json']) {
      const body = generate().files.find((entry) => entry.path === path)?.content ?? '';

      expect(body.endsWith('}\n')).toBe(true);
      expect(body).not.toMatch(/\r/);
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
    }
  });
});

describe('the grammar the slice does not implement is refused, not degraded', () => {
  it('refuses to generate at all when the gate would fail', () => {
    const input = mutatedGenerateInput((draft) => {
      (specBody(draft)['workflows']['document-triage-flow'].steps as Record<string, unknown>[]).splice(1, 0, {
        id: 'approve',
        type: 'approval',
        gates: 'triage',
        approverRoles: ['claims-adjuster'],
        expiresAfter: 'PT1H',
        evidenceFrom: ['context'],
      });
    });

    expect(() => mastraGenerator.generateApp(input)).toThrow(/runtime_grammar_unsupported/);
  });
});
