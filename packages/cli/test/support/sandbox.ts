import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { CliIO } from '../../src/index.js';
import { runCli } from '../../src/index.js';

/** Repo root, resolved from `packages/cli/test/support`. */
export const repoRoot = resolve(import.meta.dirname, '../../../..');

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export interface Sandbox {
  /** Temporary repository root: `examples/` and `platform/` copied verbatim. */
  root: string;
  workspace: string;
  specDir: string;
  /** The Acme Customer Context Package (`examples/semantic/acme`). */
  contextPackage: string;
  platform: string;
  path(relative: string): string;
  read(relative: string): string;
  write(relative: string, text: string): void;
  exists(relative: string): boolean;
  run(args: readonly string[], cwd?: string): Promise<RunResult>;
  cleanup(): void;
}

/**
 * A disposable copy of the repo's reference artifacts. Tests mutate the copy, so
 * a failed test can never leave the checked-in example drifted.
 */
export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'fde-cli-'));
  cpSync(join(repoRoot, 'examples'), join(root, 'examples'), { recursive: true });
  cpSync(join(repoRoot, 'platform'), join(root, 'platform'), { recursive: true });

  const workspace = join(root, 'examples/spec/acme');
  const specDir = join(workspace, 'claims-triage');
  const path = (relative: string): string => join(root, relative);

  return {
    root,
    workspace,
    specDir,
    contextPackage: join(root, 'examples/semantic/acme'),
    platform: join(root, 'platform'),
    path,
    read: (relative) => readFileSync(path(relative), 'utf8'),
    write: (relative, text) => {
      mkdirSync(join(path(relative), '..'), { recursive: true });
      writeFileSync(path(relative), text);
    },
    exists: (relative) => existsSync(path(relative)),
    async run(args, cwd = root) {
      const out: string[] = [];
      const err: string[] = [];
      const io: CliIO = {
        cwd,
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      };
      const code = await runCli(args, io);
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
}
