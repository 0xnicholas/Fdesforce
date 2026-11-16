// Seam: the A11 helpers every generator uses (`files.ts`).
//
// These are the difference between "the same inputs produced the same output" and
// "the same inputs happened to produce the same output on this machine": sorted
// paths, canonical JSON, explicit modes and a content address that covers exactly
// the files returned.
import { describe, expect, it } from 'vitest';

import { canonicalJson, digestFiles } from '@fde/spec';

import { GENERATED_FILE_MODE, canonicalJsonFile, sortedFiles, sourceDigest } from '../src/index.js';

const file = (path: string, content: string, mode = GENERATED_FILE_MODE) => ({ path, content, mode });

describe('canonicalJsonFile', () => {
  it('sorts keys, indents, and ends with exactly one newline', () => {
    const written = canonicalJsonFile({ zulu: 1, alpha: { beta: [2, 3] } });

    expect(written).toBe('{\n  "alpha": {\n    "beta": [\n      2,\n      3\n    ]\n  },\n  "zulu": 1\n}\n');
  });

  it('is the canonical form, only indented', () => {
    const value = { b: [1, { d: 4, c: 3 }], a: 'x' };

    expect(JSON.parse(canonicalJsonFile(value))).toEqual(JSON.parse(canonicalJson(value)));
    expect(canonicalJsonFile(value).replace(/\s+/g, '')).toBe(canonicalJson(value));
  });

  it('refuses a value JSON cannot round-trip, instead of dropping it', () => {
    expect(() => canonicalJsonFile({ when: new Date(0) })).toThrow();
    expect(() => canonicalJsonFile({ missing: undefined })).toThrow();
  });

  it('is stable for a value whose keys were inserted in another order', () => {
    expect(canonicalJsonFile({ a: 1, b: 2 })).toBe(canonicalJsonFile({ b: 2, a: 1 }));
  });
});

describe('sortedFiles', () => {
  it('sorts by path without touching content or mode', () => {
    const sorted = sortedFiles([file('b/c.ts', 'second'), file('a.ts', 'first')]);

    expect(sorted.map((entry) => entry.path)).toEqual(['a.ts', 'b/c.ts']);
    expect(sorted[0]).toEqual(file('a.ts', 'first'));
  });

  it('refuses two files at one path: a duplicate is a generator bug, not an ordering choice', () => {
    expect(() => sortedFiles([file('a.ts', 'one'), file('a.ts', 'two')])).toThrow(/duplicate/);
  });
});

describe('sourceDigest', () => {
  const files = [file('a.ts', 'export const a = 1;\n'), file('b/c.json', '{}\n')];

  it('is the digest of the file set, by the rule the lock uses', () => {
    expect(sourceDigest(files)).toBe(digestFiles(files).digest);
  });

  it('does not depend on the order the files were produced in', () => {
    expect(sourceDigest([...files].reverse())).toBe(sourceDigest(files));
  });

  it('moves when any file content moves', () => {
    expect(sourceDigest([file('a.ts', 'export const a = 2;\n'), files[1] as (typeof files)[number]])).not.toBe(
      sourceDigest(files),
    );
  });

  it('covers the whole path, not just the file name', () => {
    expect(sourceDigest([file('a/b.ts', 'x'), file('b/b.ts', 'x')])).not.toBe(
      sourceDigest([file('a/b.ts', 'x'), file('c/b.ts', 'x')]),
    );
  });
});
