import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

/**
 * Repo-relative fixture loading. The build gate is tested against the checked-in
 * artifacts, not copies, so the Runtime Profile and the Acme Spec cannot drift
 * from what `fde build` will read.
 */
export const repoRoot = resolve(import.meta.dirname, '../../../..');

export function readText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

export function readYaml<T = unknown>(path: string): T {
  return parse(readText(path)) as T;
}

export const paths = {
  exampleSpec: 'examples/spec/acme/claims-triage/solution.yaml',
  exampleLock: 'examples/spec/acme/claims-triage/solution.lock',
  exampleSpecDir: 'examples/spec/acme/claims-triage',
  exampleConnector: 'examples/spec/acme/customer/connectors/claims-db.yaml',
  exampleExtension: 'platform/extensions/acme-claims-connector/1.0.0/extension.yaml',
  exampleRuntimeProfile: 'platform/runtime-profiles/mastra-1.83-node22.yaml',
  exampleIdentity: 'examples/identity/acme/acme-prod.yaml',
} as const;
