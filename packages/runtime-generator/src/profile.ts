import { digestOf, isDigest } from '@fde/spec';
import type { CapabilityDetails, Digest, RuntimeCapabilities, RuntimePinBlock, RuntimeProfile } from '@fde/spec';

import { capabilityDetails, normalizeCapabilities } from './capabilities.js';

/**
 * The Runtime Profile artifact (`docs/runtime-adapter.md` §5.1).
 *
 * A Profile is platform-owned, versioned and content-addressed: identity is
 * `name@version`, address is the digest of the parsed document's canonical JSON
 * (`platform/README.md`), and `solution.lock.runtime` pins both. Resolution
 * returns the normalized declaration for the build and the flat map the
 * `runtime-info` handshake reports — after the digest, never before, so
 * normalization can never move a pin.
 */

export interface ResolvedRuntimeProfile {
  /** `name@version` — the artifact's identity. */
  ref: string;
  /** Content address of the parsed document. */
  digest: Digest;
  profile: RuntimeProfile;
  /** The ten groups in canonical order; this is what a generator's `capabilities()` returns. */
  capabilities: RuntimeCapabilities;
  /** `<group>` and `<group>.<member>` → node, the `capability_details` handshake shape. */
  details: CapabilityDetails;
}

export function profileRef(profile: RuntimeProfile): string {
  return `${profile.metadata.name}@${profile.metadata.version}`;
}

export function profileDigest(profile: RuntimeProfile): Digest {
  return digestOf(profile);
}

export function resolveRuntimeProfile(profile: RuntimeProfile): ResolvedRuntimeProfile {
  const capabilities = normalizeCapabilities(profile.spec.capabilities);
  return {
    ref: profileRef(profile),
    digest: profileDigest(profile),
    profile,
    capabilities,
    details: capabilityDetails(capabilities),
  };
}

const FOLDED_DIGEST = /@(sha256:[a-f0-9]{64})$/;

/**
 * The digest a lock pins, from either v1 shape: folded into the reference
 * (`name@version@sha256:…`) or beside it (`profileDigest`). `RuntimePinBlockSchema`
 * owns the rule; this reads it back for the gate, which must also handle a pin a
 * caller built programmatically.
 */
export function pinnedProfileDigest(pin: RuntimePinBlock): Digest | undefined {
  const folded = FOLDED_DIGEST.exec(pin.profile)?.[1];
  const candidate = folded ?? pin.profileDigest;
  return isDigest(candidate) ? candidate : undefined;
}

/** The identity a lock pins, with the digest stripped. */
export function pinnedProfileRef(pin: RuntimePinBlock): { name: string; version: string } {
  const withoutDigest = pin.profile.replace(FOLDED_DIGEST, '');
  const at = withoutDigest.indexOf('@');
  if (at < 0) return { name: withoutDigest, version: '' };
  return { name: withoutDigest.slice(0, at), version: withoutDigest.slice(at + 1) };
}
