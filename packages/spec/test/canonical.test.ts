// Seam: canonical serialization and content digests.
//
// Why this seam: `spec.digest`, `solution.lock` and the Bundle digest all rest on
// "same bytes in, same digest out" (A11). Tests here pin the serialization rules
// to digests computed outside this codebase (`shasum -a 256` and Python
// `hashlib`), so a refactor cannot silently redefine the wire digest.
import { describe, expect, it } from 'vitest';

import { canonicalJson, digestFiles, digestOf, normalizeText } from '../src/index.js';

// Known-good values, computed independently:
//   printf '%s' '<canonical>' | shasum -a 256
const SHA_EMPTY_OBJECT = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';
const SHA_A_IS_1 = 'sha256:015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862';
const SHA_NESTED = 'sha256:5b3540cb0ae78a5a1b25199f5e2e6dc3b1b4b360ef6f9146d50650546744adf4';

describe('canonical JSON', () => {
  it('sorts object keys by code unit and drops insignificant whitespace', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });

  it('produces the same bytes regardless of insertion order', () => {
    const first = { capability: 'document-triage', budget: { maxHops: 2, maxNodes: 50 } };
    const second = { budget: { maxNodes: 50, maxHops: 2 }, capability: 'document-triage' };

    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it('rejects values JSON cannot represent deterministically', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/bigint/i);
  });
});

describe('content digests', () => {
  it('hashes the canonical bytes with sha256', () => {
    expect(digestOf({})).toBe(SHA_EMPTY_OBJECT);
    expect(digestOf({ a: 1 })).toBe(SHA_A_IS_1);
    expect(digestOf({ b: 1, a: [2, { c: 3, d: 4 }] })).toBe(SHA_NESTED);
  });

  it('normalizes CRLF and CR to LF before hashing text', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });
});

describe('file set digests (spec.files / spec.digest)', () => {
  const lfFiles = [
    { path: 'solution.yaml', content: 'apiVersion: fde.dev/v0\n' },
    { path: 'files/prompts/triage.md', content: 'Triage.\n' },
  ];

  it('hashes each file and the sorted manifest', () => {
    const result = digestFiles(lfFiles);

    expect(result.files).toEqual({
      'files/prompts/triage.md':
        'sha256:a472b7c554d5e3f19e5e6346c86b1d67746ca0d4e10ed93dbebaf31b2a9310c8',
      'solution.yaml':
        'sha256:53d7a29be56cb16dba66d5d8f186a2dfade161310ada0bfeeaa6eace37103b19',
    });
    // Manifest digest cross-checked with Python hashlib over
    // json.dumps(files, sort_keys=True, separators=(',', ':')).
    expect(result.digest).toBe(
      'sha256:82553d1f58e534ca3df4ce8996c57e54a8cd719d78caadf83c80d25a99007502',
    );
  });

  it('is insensitive to input order, CRLF line endings and BOM-free encoding', () => {
    const crlfFiles = [
      { path: 'files/prompts/triage.md', content: 'Triage.\r\n' },
      { path: 'solution.yaml', content: 'apiVersion: fde.dev/v0\r\n' },
    ];

    expect(digestFiles(crlfFiles)).toEqual(digestFiles(lfFiles));
  });

  it('rejects paths that cannot appear in a lock', () => {
    expect(() => digestFiles([{ path: '/etc/passwd', content: '' }])).toThrow(/relative/);
    expect(() => digestFiles([{ path: '../escape.yaml', content: '' }])).toThrow(/relative/);
    expect(() => digestFiles([{ path: 'files\\schemas\\a.json', content: '' }])).toThrow(/POSIX/);
    expect(() =>
      digestFiles([
        { path: 'solution.yaml', content: 'a' },
        { path: 'solution.yaml', content: 'b' },
      ]),
    ).toThrow(/duplicate/i);
  });
});
