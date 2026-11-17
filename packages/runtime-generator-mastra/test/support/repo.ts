import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

/**
 * Repo-relative fixture loading. The Mastra generator is tested against the
 * checked-in reference path — the Acme read-only Spec, its lock, the Runtime
 * Profile, the Model Profiles and the Spec's own `files/**` — so a change to any
 * of them shows up as a generator test failure rather than a silent drift.
 */
export const repoRoot = resolve(import.meta.dirname, '../../../..');
export const packageRoot = resolve(import.meta.dirname, '../..');

export function readText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

export function readYaml<T = unknown>(path: string): T {
  return parse(readText(path)) as T;
}

/** Every file under `dir` as POSIX relative path → UTF-8 content, path-sorted. */
export function readTree(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(repoRoot, dir, relative), { withFileTypes: true })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files[path] = readText(join(dir, path));
    }
  };
  walk('');
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => (left < right ? -1 : 1)));
}

export const paths = {
  exampleSpec: 'examples/spec/acme/claims-triage/solution.yaml',
  exampleLock: 'examples/spec/acme/claims-triage/solution.lock',
  exampleSpecDir: 'examples/spec/acme/claims-triage',
  exampleRuntimeProfile: 'platform/runtime-profiles/mastra-1.83-node22.yaml',
  modelProfile: 'platform/model-profiles/standard.yaml',
  exampleIdentity: 'examples/identity/acme/acme-prod.yaml',
  fallbackModelProfile: 'platform/model-profiles/standard-fallback.yaml',
} as const;
