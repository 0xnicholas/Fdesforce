// Seam: the package boundary.
//
// `@fde/runtime-generator` is a pure build-time port (`docs/runtime-adapter.md`
// §4.1): it depends only on `@fde/spec`'s types and pure utilities, never on
// Mastra, a Node runtime, Python, the network or the filesystem. A build that
// reads a clock or writes a file stops being reproducible (A11); a generator
// that imports its own runtime SDK stops being portable to the Python shim.
//
// The scan reads the sources rather than the built output, so a dependency can
// never sneak in through a transitive import that this package did not declare.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');
const sourceDir = join(packageRoot, 'src');
const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();

const read = (name: string): string => readFileSync(join(sourceDir, name), 'utf8');

/** Comments talk about the runtime; only code can depend on it. */
const code = (name: string): string =>
  read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

const importSpecifiers = (name: string): string[] => [
  ...code(name).matchAll(/(?:from|import)\s+'([^']+)'/g),
].map((match) => match[1] as string);

const FORBIDDEN_APIS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bprocess\.(env|argv|cwd)\b/, why: 'process state (the output would depend on the machine)' },
  { pattern: /\bfetch\s*\(/, why: 'network access' },
  { pattern: /\bnew\s+Date\b/, why: 'the clock (A11 requires determinism)' },
  { pattern: /\bDate\.now\b/, why: 'the clock (A11 requires determinism)' },
  { pattern: /\bMath\.random\b/, why: 'randomness (A11 requires determinism)' },
  { pattern: /\b(child_process|readFile|writeFile|createServer)\b/, why: 'disk, process or network side effects' },
  { pattern: /\brequire\s*\(/, why: 'CommonJS loading' },
];

/**
 * The port's data types may not use a container JSON cannot round-trip. Local
 * indexes inside an implementation may (`Set`, `Map`), the wire shape may not.
 */
const NON_JSON_TOKENS = /\b(Date|Map|Set|WeakMap|WeakSet|bigint|symbol)\b/;

describe('package boundary', () => {
  it('scans every source file', () => {
    expect(sources.length).toBeGreaterThanOrEqual(6);
  });

  it('declares @fde/spec as its only runtime dependency', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@fde/spec']);
    expect(manifest.peerDependencies).toBeUndefined();
  });

  it('imports only @fde/spec and its own modules', () => {
    const offenders = sources.flatMap((name) =>
      importSpecifiers(name)
        .filter((specifier) => !specifier.startsWith('.') && specifier !== '@fde/spec')
        .map((specifier) => `${name} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it('does not reach for the network, the disk, the clock or randomness', () => {
    const offenders = sources.flatMap((name) =>
      FORBIDDEN_APIS.flatMap(({ pattern, why }) => {
        const match = pattern.exec(code(name));
        return match === null ? [] : [`${name}: ${match[0]} (${why})`];
      }),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the port data types free of containers JSON cannot round-trip', () => {
    const match = NON_JSON_TOKENS.exec(code('port.ts'));

    expect(match?.[0]).toBeUndefined();
  });
});
