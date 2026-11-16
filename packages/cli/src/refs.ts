import { satisfiesRange } from '@fde/spec';

/** `name@range` — artifact names may contain dots, never `@`. */
export interface ArtifactRef {
  name: string;
  range: string;
}

export function parseRef(ref: string): ArtifactRef {
  const at = ref.indexOf('@');
  if (at < 0) return { name: ref, range: '' };
  return { name: ref.slice(0, at), range: ref.slice(at + 1) };
}

/** Numeric semver comparison; pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const [aCore = '0', aPre] = a.split('-');
  const [bCore = '0', bPre] = b.split('-');
  const aParts = aCore.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const bParts = bCore.split('.').map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
    const difference = (aParts[index] ?? 0) - (bParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}

/**
 * The highest vendored version that satisfies the Spec's range. Offline
 * resolution is deterministic: versions are immutable and the highest match
 * wins, so the lock is a function of the vendored tree.
 */
export function highestSatisfying(versions: ReadonlyArray<string>, range: string): string | undefined {
  const matching = versions.filter((version) => range === '' || satisfiesRange(range, version));
  matching.sort(compareVersions);
  return matching.at(-1);
}
