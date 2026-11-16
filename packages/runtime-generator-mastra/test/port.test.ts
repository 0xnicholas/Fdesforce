// Seam: the `RuntimeGenerator` port, as this package implements it.
//
// The port is shared by every runtime; a generator that skips a method, renames
// its family or answers `capabilities()` with something the handshake cannot
// report breaks the CLI and the startup check at once. The four generation
// generation methods this slice does not own (#28) must fail loudly rather than
// emit an empty topology, because an empty topology renders a bundle that
// silently misses the runtime.
import { describe, expect, it } from 'vitest';

import { resolveRuntimeProfile } from '@fde/runtime-generator';

import { mastraGenerator } from '../src/index.js';
import { exampleProfile, generateInput } from './support/fixtures.js';

describe('identity', () => {
  it('is the mastra family at the version the Runtime Profile pins', () => {
    const profile = exampleProfile();

    expect(mastraGenerator.family).toBe('mastra');
    expect(mastraGenerator.version).toBe(profile.spec.generator.version);
  });
});

describe('capabilities', () => {
  it('is the normalized Profile declaration, before any Spec is read', () => {
    const profile = exampleProfile();

    expect(mastraGenerator.capabilities(profile)).toEqual(resolveRuntimeProfile(profile).capabilities);
  });
});

describe('methods this slice does not own', () => {
  const input = generateInput();

  it.each([
    ['generateTopology', () => mastraGenerator.generateTopology(input)],
    ['generateMigrations', () => mastraGenerator.generateMigrations(input)],
    ['generateContractTests', () => mastraGenerator.generateContractTests(input)],
  ])('%s fails loudly instead of emitting an empty artifact', (_name, call) => {
    expect(call).toThrow(/#28/);
  });
});
