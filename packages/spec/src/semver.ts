/**
 * Version ordering, shared by everything that has to pick or rank a version string:
 * `fde spec lock`'s range resolution, the platform store's "highest published
 * version", and any consumer reading a directory name as a version.
 *
 * `SemverSchema` says what a version string looks like; this says which one is
 * newer. Pre-release suffixes sort before the release they precede (`1.1.0-rc.1` <
 * `1.1.0`), which is what stops a vendored release candidate from being adopted as
 * "latest" over the release it is a candidate for.
 */
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
