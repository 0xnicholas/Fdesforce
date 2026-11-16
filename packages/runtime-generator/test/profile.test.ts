// Seam: the Runtime Profile artifact (`resolveRuntimeProfile`).
//
// The Profile is versioned and content-addressed (`docs/runtime-adapter.md`
// §5.1): `solution.lock` pins `name@version@sha256:…`, and the digest is the
// canonical JSON of the parsed document (`platform/README.md`). Resolving it is
// also where the declaration is normalized — but only *after* the digest, so a
// pin never depends on normalization.
import { describe, expect, it } from 'vitest';

import { digestOf, CapabilityDetailsSchema } from '@fde/spec';

import { pinnedProfileDigest, pinnedProfileRef, profileDigest, profileRef, resolveRuntimeProfile } from '../src/index.js';
import { exampleLock, exampleProfile } from './support/fixtures.js';

describe('the checked-in Runtime Profile', () => {
  it('is addressed by name, version and the canonical digest of the document', () => {
    const profile = exampleProfile();

    expect(profileRef(profile)).toBe('mastra-1.83-node22@1.0.0');
    expect(profileDigest(profile)).toBe(digestOf(profile));
  });

  it('is pinned by the Acme lock under exactly that address', () => {
    const profile = exampleProfile();
    const lock = exampleLock();

    expect(lock.runtime.profile).toBe(`${profileRef(profile)}@${profileDigest(profile)}`);
  });

  it('resolves to normalized capabilities and the handshake map', () => {
    const resolved = resolveRuntimeProfile(exampleProfile());

    expect(resolved.ref).toBe(profileRef(resolved.profile));
    expect(resolved.digest).toBe(profileDigest(resolved.profile));
    expect(resolved.capabilities.durableWorkflow.durabilityModes).toEqual(['sync', 'async']);
    expect(CapabilityDetailsSchema.safeParse(resolved.details).success).toBe(true);
  });
});

describe('reading a lock pin', () => {
  it('reads a digest folded into the reference', () => {
    const lock = exampleLock();

    expect(pinnedProfileDigest(lock.runtime)).toBe(profileDigest(exampleProfile()));
    expect(pinnedProfileRef(lock.runtime)).toEqual({ name: 'mastra-1.83-node22', version: '1.0.0' });
  });

  it('reads a digest held beside the reference', () => {
    const lock = exampleLock();
    const digest = profileDigest(exampleProfile());

    expect(
      pinnedProfileDigest({ ...lock.runtime, profile: 'mastra-1.83-node22@1.0.0', profileDigest: digest }),
    ).toBe(digest);
    expect(pinnedProfileRef({ ...lock.runtime, profile: 'mastra-1.83-node22@1.0.0' })).toEqual({
      name: 'mastra-1.83-node22',
      version: '1.0.0',
    });
  });

  it('reports no digest when the pin carries none', () => {
    const lock = exampleLock();

    expect(pinnedProfileDigest({ ...lock.runtime, profile: 'mastra-1.83-node22@1.0.0' })).toBeUndefined();
  });
});
