import { canonicalJson, digestFiles } from '@fde/spec';
import type { Digest } from '@fde/spec';

import type { GeneratedFile } from './port.js';

/**
 * Helpers every generator needs to honour A11: the same pinned inputs produce
 * the same bytes, in the same order, with the same content address.
 *
 * These are deliberately small and shared rather than re-implemented per
 * generator, because "deterministic" is a property the whole build has or does
 * not have — a second generator that sorts differently would make the bundle
 * digest depend on which component happened to be generated last.
 */

/** Every generated file declares this mode, so generation never depends on the umask. */
export const GENERATED_FILE_MODE = 0o644;

/**
 * JSON as it lands in a bundle: canonical (keys sorted by code unit) and
 * indented, with one trailing newline.
 *
 * Canonical form is what makes two builds byte-identical; indentation is what
 * makes a generated manifest reviewable in a diff. Both are fixed here so no
 * generator has to choose, and `canonicalJson` stays the single serializer that
 * decides order.
 */
export function canonicalJsonFile(value: unknown): string {
  // `canonicalJson` rejects anything JSON cannot round-trip and sorts keys; the
  // round-trip through `JSON.parse` is what turns it back into pretty output
  // without re-deciding order.
  return `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;
}

/**
 * Sort by path, and refuse a duplicate: two files at one path is a generator bug
 * that would otherwise depend on write order to be visible.
 */
export function sortedFiles(files: ReadonlyArray<GeneratedFile>): GeneratedFile[] {
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new Error(`duplicate generated path: ${file.path}`);
    paths.add(file.path);
  }
  return [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * The content address of a generated tree: `digestFiles` over the sorted
 * `path → sha256` manifest, the same rule `solution.lock.spec.digest` uses. It
 * covers content, not mode, which is why modes are explicit constants — a mode
 * that could vary would be a byte of the artifact the digest cannot see.
 */
export function sourceDigest(files: ReadonlyArray<GeneratedFile>): Digest {
  return digestFiles(files.map(({ path, content }) => ({ path, content }))).digest;
}
