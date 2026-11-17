// Seam: `compareVersions` — the one ordering rule for version strings.
//
// Version strings reach the workbench from three places that must agree: a lock pin,
// a vendored directory name in the platform store, and the Spec's range. A
// re-implemented comparison in each consumer is how `1.1.0-rc.1` ends up outranking
// `1.1.0` in one of them.
import { describe, expect, it } from 'vitest';

import { compareVersions } from '../src/index.js';

describe('version ordering', () => {
  it('compares numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.99.99')).toBeGreaterThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('sorts a pre-release before the release it precedes', () => {
    expect(compareVersions('1.1.0-rc.1', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('1.1.0', '1.1.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0-rc.1', '1.1.0-rc.2')).toBeLessThan(0);
  });

  it('orders mixed-length cores by the missing segment being zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
  });

  it('picks the highest of a store listing', () => {
    const versions = ['1.0.0', '1.10.0', '1.9.0', '1.10.0-rc.1'];

    expect([...versions].sort(compareVersions).at(-1)).toBe('1.10.0');
  });
});
