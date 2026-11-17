// Seam: the generated tree must build, and the generator must stay a build-time
// pure function.
//
// Two separate promises (`#27`):
//
// 1. The tree a customer receives compiles against the pinned `@mastra/core`
//    without anyone hand-editing it. This test materialises the tree in a
//    scratch directory and runs the TypeScript compiler over it. It is the only
//    honest check: the generator's own types say nothing about the *generated*
//    code.
// 2. `@fde/runtime-generator-mastra` never imports the runtime it generates for,
//    never reads a clock or the disk. A generator that needed Mastra installed to
//    emit Mastra code could not run in the offline toolchain, and would stop
//    being portable to the JSON/CLI shim `docs/runtime-adapter.md` §4.1 promises.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mastraGenerator } from '../src/index.js';
import { generateInput } from './support/fixtures.js';

const packageRoot = resolve(import.meta.dirname, '..');

// --- 1. the generated tree compiles -----------------------------------------

/**
 * Write the generated tree to a scratch directory *inside this package*, so the
 * compiler resolves `@mastra/core` and `@types/node` from the versions this
 * package pins — the same versions the Runtime Profile pins.
 */
function materialize(): { dir: string; cleanup: () => void } {
  mkdirSync(join(packageRoot, 'node_modules/.cache'), { recursive: true });
  const dir = mkdtempSync(join(packageRoot, 'node_modules/.cache/generated-'));
  for (const entry of mastraGenerator.generateApp(generateInput()).files) {
    const target = join(dir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the generated app compiles', () => {
  it('installs the exact @mastra/core the app pins', () => {
    // "dependency install and compile" has two halves: the pinned version must be
    // the version that is actually installed, or the check proves nothing about the
    // artifact a customer receives.
    const { dir, cleanup } = materialize();
    try {
      const generated = JSON.parse(
        readFileSync(join(dir, 'mastra-app/package.json'), 'utf8'),
      ) as { dependencies: Record<string, string> };
      const installed = JSON.parse(
        readFileSync(join(packageRoot, 'node_modules/@mastra/core/package.json'), 'utf8'),
      ) as { version: string };

      expect(installed.version).toBe(generated.dependencies['@mastra/core']);
    } finally {
      cleanup();
    }
  });

  // Typechecking a real tree against the real runtime types is not instant; the
  // budget here is generous so a slow CI box reports type errors, not a timeout.
  it('typechecks against the pinned @mastra/core with no hand edits', { timeout: 120_000 }, () => {
    const { dir, cleanup } = materialize();
    try {
      const tsc = join(packageRoot, 'node_modules/typescript/bin/tsc');
      const run = (): { ok: boolean; output: string } => {
        try {
          execFileSync(process.execPath, [tsc, '--project', join(dir, 'mastra-app/tsconfig.json')], {
            cwd: join(dir, 'mastra-app'),
            encoding: 'utf8',
            stdio: 'pipe',
          });
          return { ok: true, output: '' };
        } catch (error) {
          const failure = error as { stdout?: string; stderr?: string };
          return { ok: false, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
        }
      };

      const result = run();
      expect(result.ok, result.output).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe('the compiler check is meaningful', () => {
  it('would fail if the generated source did not match the runtime API', { timeout: 120_000 }, () => {
    const { dir, cleanup } = materialize();
    try {
      // Prove the compile check is not vacuous: a call the pinned runtime does not
      // have must break it. Without this, a stale `tsconfig` could pass everything.
      const entry = join(dir, 'mastra-app/src/mastra.ts');
      writeFileSync(entry, `${readFileSync(entry, 'utf8')}\nmastra.startServer();\n`);

      expect(() =>
        execFileSync(
          process.execPath,
          [join(packageRoot, 'node_modules/typescript/bin/tsc'), '--project', join(dir, 'mastra-app/tsconfig.json')],
          { cwd: join(dir, 'mastra-app'), stdio: 'pipe' },
        ),
      ).toThrow();
    } finally {
      cleanup();
    }
  });
});

// --- 2. the generator's own boundary ----------------------------------------

const sourceDir = join(packageRoot, 'src');
const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith('.ts'))
  .sort();

const read = (name: string): string => readFileSync(join(sourceDir, name), 'utf8');

/**
 * Blank everything that is not the generator's own code: comments (they *talk*
 * about the runtime and about the generated text) and literals (the emitted tree
 * is data, and it is scanned separately — `determinism.test.ts` for the app,
 * `runtime-info.test.ts` for the handshake).
 *
 * A character walk, not a stack of regexes. The regex version blanked comments
 * first — which deletes the rest of a line that *contains* `//` inside a string,
 * such as an emitted `'// …'` banner — and then blanked template literals before
 * strings, which ate the backticks inside an emitted `'… fetch(`${url}`) …'`. Both
 * left emitted code looking like the generator's own, and the same desync could
 * hide a real `process.env` just as easily.
 *
 * Template literals are skipped wholesale, `${…}` interpolations included: this
 * scan needs to know what is inside a literal, not to parse the expression in it.
 */
function withoutCommentsOrLiterals(source: string): string {
  const out: string[] = [];
  let index = 0;

  const blank = (from: number, to: number): void => {
    out.push(source.slice(index, from), source.slice(from, to).replace(/[^\n]/g, ' '));
    index = to;
  };

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      blank(index, end < 0 ? source.length : end);
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      blank(index, end < 0 ? source.length : end + 2);
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === char) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      blank(index, Math.min(cursor, source.length));
      continue;
    }

    out.push(char);
    index += 1;
  }

  return out.join('');
}

const generatorCode = (name: string): string => withoutCommentsOrLiterals(read(name));

const FORBIDDEN_APIS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /\bprocess\.(env|argv|cwd)\b/, why: 'process state (the output would depend on the machine)' },
  { pattern: /\bfetch\s*\(/, why: 'network access' },
  { pattern: /\bnew\s+Date\b/, why: 'the clock (A11 requires determinism)' },
  { pattern: /\bDate\.now\b/, why: 'the clock (A11 requires determinism)' },
  { pattern: /\bMath\.random\b/, why: 'randomness (A11 requires determinism)' },
  { pattern: /\b(child_process|readFile|writeFile|createServer)\b/, why: 'disk, process or network side effects' },
];

describe('the generator package boundary', () => {
  it('scans every source file', () => {
    expect(sources.length).toBeGreaterThanOrEqual(4);
  });

  it('imports only its two workspace dependencies and its own modules', () => {
    const offenders = sources.flatMap((name) =>
      [...generatorCode(name).matchAll(/(?:from|import)\s+'([^']+)'/g)]
        .map((match) => match[1] as string)
        .filter(
          (specifier) =>
            !specifier.startsWith('.') && specifier !== '@fde/spec' && specifier !== '@fde/runtime-generator',
        )
        .map((specifier) => `${name} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  it('does not depend on Mastra to generate Mastra code', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@fde/runtime-generator', '@fde/spec']);
    // It is a devDependency on purpose: the *generated* code is typechecked
    // against the pinned runtime, the generator itself never loads it.
    expect(manifest.devDependencies?.['@mastra/core']).toBe('1.83.0');
  });

  it('does not reach for the network, the disk, the clock or randomness', () => {
    const offenders = sources.flatMap((name) =>
      FORBIDDEN_APIS.flatMap(({ pattern, why }) => {
        const match = pattern.exec(generatorCode(name));
        return match === null ? [] : [`${name}: ${match[0]} (${why})`];
      }),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the pinned runtime version and the Profile's package pin in agreement", () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };

    expect(manifest.devDependencies['@mastra/core']).toBe(generateInput().profile.spec.packages['@mastra/core']);
  });
});
