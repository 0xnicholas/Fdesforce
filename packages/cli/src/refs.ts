import { compareVersions, satisfiesRange } from '@fde/spec';

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
