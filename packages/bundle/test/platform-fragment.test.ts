// Seam: `loadContextServiceTopology` — the vendored platform fragment, read and
// validated the way a build reads it (`platform/README.md`).
//
// The fragment is a platform artifact, so it lives in the offline store next to the
// Runtime Profiles and Templates: versioned directory, descriptor file, immutable
// once published. A build resolves it by version and must fail closed when the
// version is absent or the document does not parse.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './support/fixtures.js';
import { PLATFORM_FRAGMENT } from './support/fixtures.js';
import { loadContextServiceTopology } from '../src/index.js';

const platformRoot = join(repoRoot, 'platform');

const fragment = (version: string, name = 'context-service'): string =>
  `apiVersion: fde.dev/v0
kind: ContextServiceTopology
metadata:
  name: ${name}
  version: ${version}
spec:
  components:
    - name: context-service
      role: context-service
      image: { image: "ghcr.io/acme/fde-context-service@sha256:abc" }
      ports: [{ name: internal, containerPort: 8011 }]
  volumes: []
  jobs: []
  secretBindings: []
  networks: [{ name: bundle, internal: true }]
`;

/** A throwaway offline store with the given version directories. */
const store = (versions: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'fde-platform-'));
  for (const [version, content] of Object.entries(versions)) {
    mkdirSync(join(root, 'context-service', version), { recursive: true });
    writeFileSync(join(root, 'context-service', version, 'topology.yaml'), content);
  }
  return root;
};

describe('the vendored platform fragment', () => {
  it('loads and validates the checked-in artifact', () => {
    const loaded = loadContextServiceTopology({ platformRoot });

    if (!loaded.ok) throw new Error(JSON.stringify(loaded.errors, null, 2));
    expect(loaded.path.endsWith(PLATFORM_FRAGMENT)).toBe(true);
    expect(loaded.topology.kind).toBe('ContextServiceTopology');
    expect(loaded.topology.metadata).toEqual({
      name: 'context-service',
      version: '1.0.0',
      description: expect.stringContaining('context-service'),
    });
  });

  it('resolves the highest published version when the caller does not pin one', () => {
    const root = store({ '1.0.0': fragment('1.0.0'), '1.2.0': fragment('1.2.0'), '1.10.0': fragment('1.10.0') });

    const loaded = loadContextServiceTopology({ platformRoot: root });

    expect(loaded.ok && loaded.topology.metadata.version).toBe('1.10.0');
  });

  it('resolves an exact version when the caller pins one', () => {
    const root = store({ '1.0.0': fragment('1.0.0'), '1.2.0': fragment('1.2.0') });

    expect(loadContextServiceTopology({ platformRoot: root, version: '1.0.0' })).toMatchObject({
      ok: true,
      topology: { metadata: { version: '1.0.0' } },
    });
  });

  it('refuses a version the store does not have, and says which ones it does', () => {
    const root = store({ '1.0.0': fragment('1.0.0') });

    const loaded = loadContextServiceTopology({ platformRoot: root, version: '9.9.9' });

    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.errors.map((error) => error.code)).toEqual(['platform_fragment_missing']);
    expect(loaded.ok ? '' : JSON.stringify(loaded.errors)).toContain('1.0.0');
  });

  it('refuses a store with no fragment at all', () => {
    const root = mkdtempSync(join(tmpdir(), 'fde-platform-empty-'));

    const loaded = loadContextServiceTopology({ platformRoot: root });

    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.errors.map((error) => error.code)).toEqual(['platform_fragment_missing']);
  });

  it('refuses a fragment whose metadata disagrees with the directory it sits in', () => {
    // Published versions are immutable and the directory is the identity; a mismatch
    // is a copy-paste, and it would make two builds of "1.0.0" different bundles.
    const root = store({ '1.0.0': fragment('1.0.0', 'context-service') });

    expect(loadContextServiceTopology({ platformRoot: root, version: '1.0.0' }).ok).toBe(true);
    expect(loadContextServiceTopology({ platformRoot: store({ '1.0.0': fragment('2.0.0') }), version: '1.0.0' }).ok).toBe(
      false,
    );
  });

  it('refuses a document that does not parse as a ContextServiceTopology', () => {
    const root = store({ '1.0.0': 'kind: Overlay\nmetadata: { name: x, version: 1.0.0 }\n' });

    const loaded = loadContextServiceTopology({ platformRoot: root, version: '1.0.0' });

    expect(loaded.ok).toBe(false);
    expect(loaded.ok ? [] : loaded.errors.map((error) => error.code)).toContain('context_service_topology_invalid');
  });
});
