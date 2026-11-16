import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';

/**
 * Repo-relative fixture loading. Tests read the checked-in artifacts directly
 * (no copies), so a fixture can never drift from the document it claims to test.
 */
export const repoRoot = resolve(import.meta.dirname, '../../../..');

export function readText(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

export function readYaml<T = unknown>(path: string): T {
  return parse(readText(path)) as T;
}

/** Files referenced by a `solution.lock spec.files` manifest, as text. */
export function readSpecFiles(specDir: string, paths: ReadonlyArray<string>): Record<string, string> {
  return Object.fromEntries(paths.map((path) => [path, readText(join(specDir, path))]));
}

export const paths = {
  exampleSpec: 'examples/spec/acme/claims-triage/solution.yaml',
  exampleLock: 'examples/spec/acme/claims-triage/solution.lock',
  exampleSpecDir: 'examples/spec/acme/claims-triage',
  exampleConnector: 'examples/spec/acme/customer/connectors/claims-db.yaml',
  exampleConnectorContract: 'examples/spec/acme/customer/connectors/contracts/claims-db.md',
  exampleEvalSuite: 'examples/eval/acme/eval-suite.yaml',
  exampleRuntimeProfile: 'platform/runtime-profiles/mastra-1.83-node22.yaml',
  exampleModelProfile: 'platform/model-profiles/standard.yaml',
  exampleFallbackProfile: 'platform/model-profiles/standard-fallback.yaml',
  exampleContextPackage: 'examples/semantic/acme',
  prototypeSpec: 'prototype/11-solution-spec/acme/solutions/claims-triage/solution.yaml',
  prototypeLock: 'prototype/11-solution-spec/acme/solutions/claims-triage/solution.lock',
  prototypeSpecDir: 'prototype/11-solution-spec/acme/solutions/claims-triage',
  prototypeModelProfile: 'prototype/11-solution-spec/model-profiles/standard.yaml',
  prototypeFallbackProfile: 'prototype/11-solution-spec/model-profiles/standard-fallback.yaml',
  prototypeConnector: 'prototype/11-solution-spec/acme/customer/connectors/claims-db.yaml',
  prototypePolicyThreshold: 'prototype/11-solution-spec/acme/policies/claims-approval-threshold.yaml',
  prototypePolicyAllowlist: 'prototype/11-solution-spec/acme/policies/tool-allowlist.yaml',
  contracts: 'contracts',
  contractsSchemas: 'contracts/schemas',
} as const;
