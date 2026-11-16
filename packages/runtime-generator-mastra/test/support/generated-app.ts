import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { RuntimeGenerateInput } from '@fde/runtime-generator';

import { mastraGenerator } from '../../src/index.js';
import { generateInput } from './fixtures.js';

/**
 * Materialise the generated mastra-app and load its modules.
 *
 * The generated tree is the deliverable, and the Run API's acceptance criteria
 * (`#28`) are runtime behaviour: a `seq` that starts at 1, an idempotency replay
 * that returns the same Run, a `cancel` that aborts a signal. Asserting those
 * against the emitter's string literals would only prove the generator's source
 * still contains its own text; loading the emitted module proves the tree a
 * customer receives actually behaves that way.
 *
 * The tree lands inside this package's `node_modules/.cache` so its imports
 * resolve from the versions this package pins (the same ones the Runtime Profile
 * pins), and so it is never mistaken for checked-in source.
 */
export interface MaterializedTree {
  /** Absolute path of the bundle root (the directory the components sit in). */
  bundle: string;
  /** Absolute path of the generated app (`<bundle>/mastra-app`). */
  root: string;
  /** The module at `mastra-app/src/<path>`, imported from the materialised tree. */
  load<T>(path: string): Promise<T>;
  cleanup(): void;
}

export interface MaterializeOptions {
  /**
   * `cache` (default) keeps the tree inside this package so imports resolve from
   * the pinned toolchain. `tmp` is for a test that *spawns* the tree: Node refuses
   * type stripping under `node_modules`, so a child process needs a plain directory
   * — the same situation as the container, where the app sits at `/app`.
   */
  location?: 'cache' | 'tmp';
}

export function materialize(input: RuntimeGenerateInput = generateInput(), options: MaterializeOptions = {}): MaterializedTree {
  const cache =
    options.location === 'tmp'
      ? mkdtempSync(join(tmpdir(), 'fde-mastra-app-'))
      : (() => {
          const inside = join(import.meta.dirname, '../../node_modules/.cache');
          mkdirSync(inside, { recursive: true });
          return mkdtempSync(join(inside, 'tree-'));
        })();
  const dir = cache;

  // The bundle is the app tree plus the contract-test assets `generateContractTests`
  // emits: A2/A5 run from the bundle against the running app.
  const files = [
    ...mastraGenerator.generateApp(input).files,
    ...mastraGenerator.generateContractTests(input).generatedFiles,
  ];
  for (const entry of files) {
    const target = join(dir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
  }

  return {
    bundle: dir,
    root: join(dir, 'mastra-app'),
    load: async <T>(path: string): Promise<T> =>
      (await import(pathToFileURL(join(dir, 'mastra-app/src', path)).href)) as T,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A scratch state store path inside the materialised tree, so each test owns its database. */
export const statePath = (tree: MaterializedTree, name = 'state.db'): string => join(tree.root, name);
