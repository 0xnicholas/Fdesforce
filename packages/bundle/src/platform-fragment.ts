import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { compareVersions, parseContextServiceTopology } from '@fde/spec';
import type { ContextServiceTopology, Diagnostic } from '@fde/spec';
import { parse as parseYaml } from 'yaml';

/**
 * Reading the platform's fragment out of the offline store (`platform/README.md`).
 *
 * The store is versioned directories with a descriptor file, and a published version
 * is immutable. Resolution is by exact version when the caller pins one (a build that
 * composed a different fragment than the one it recorded is not reproducible), or by
 * the highest published version. Nothing here reaches the network: an unvendored
 * version is a hard error, exactly like an unvendored Template.
 */

/** The store directory the fragment lives under. */
export const CONTEXT_SERVICE_TOPOLOGY_DIR = 'context-service';

/** The descriptor file name inside a version directory. */
const DESCRIPTOR = 'topology.yaml';

export type LoadContextServiceTopologyResult =
  | { ok: true; topology: ContextServiceTopology; path: string }
  | { ok: false; errors: Diagnostic[] };

function publishedVersions(root: string): string[] {
  const dir = join(root, CONTEXT_SERVICE_TOPOLOGY_DIR);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersions);
  } catch {
    return [];
  }
}

export function loadContextServiceTopology(input: {
  platformRoot: string;
  version?: string;
}): LoadContextServiceTopologyResult {
  const versions = publishedVersions(input.platformRoot);
  const version = input.version ?? versions.at(-1);
  if (version === undefined || !versions.includes(version)) {
    return {
      ok: false,
      errors: [
        {
          code: 'platform_fragment_missing',
          path: `${CONTEXT_SERVICE_TOPOLOGY_DIR}/${version ?? '<latest>'}/${DESCRIPTOR}`,
          message:
            versions.length === 0
              ? `the platform store has no ${CONTEXT_SERVICE_TOPOLOGY_DIR} topology fragment`
              : `${CONTEXT_SERVICE_TOPOLOGY_DIR}@${version} is not vendored; the store has ${versions.join(', ')}`,
          remediation: `vendor ${CONTEXT_SERVICE_TOPOLOGY_DIR}@${version ?? '<version>'} under platform/ or pin a published version`,
        },
      ],
    };
  }

  const path = join(input.platformRoot, CONTEXT_SERVICE_TOPOLOGY_DIR, version, DESCRIPTOR);
  let document: unknown;
  try {
    document = parseYaml(readFileSync(path, 'utf8'));
  } catch (cause) {
    return {
      ok: false,
      errors: [
        {
          code: 'platform_fragment_invalid',
          path,
          message: `${CONTEXT_SERVICE_TOPOLOGY_DIR}@${version} does not read as YAML: ${(cause as Error).message}`,
        },
      ],
    };
  }

  const parsed = parseContextServiceTopology(document);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  // The directory is the published identity: a fragment that renames itself without
  // its directory (or vice versa) would make two builds of one version disagree.
  const { name, version: declared } = parsed.value.metadata;
  if (declared !== version) {
    return {
      ok: false,
      errors: [
        {
          code: 'platform_fragment_invalid',
          path: `${CONTEXT_SERVICE_TOPOLOGY_DIR}/${version}/${DESCRIPTOR}`,
          message: `the fragment declares version ${declared} but sits in ${version}/; a published version is immutable`,
          remediation: 'bump the metadata and the directory together, in a new version directory',
        },
      ],
    };
  }
  if (name !== CONTEXT_SERVICE_TOPOLOGY_DIR) {
    return {
      ok: false,
      errors: [
        {
          code: 'platform_fragment_invalid',
          path: `${CONTEXT_SERVICE_TOPOLOGY_DIR}/${version}/${DESCRIPTOR}`,
          message: `the fragment declares name ${name} but describes ${CONTEXT_SERVICE_TOPOLOGY_DIR}`,
        },
      ],
    };
  }

  return { ok: true, topology: parsed.value, path };
}
