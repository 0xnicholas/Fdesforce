import { createMastraGenerator } from './generator.js';

/**
 * `@fde/runtime-generator-mastra` — the v0 `RuntimeGenerator` implementation
 * (`docs/runtime-adapter.md` §12).
 *
 * The value is the generator the build uses: one instance, one identity, so the
 * version the Runtime Profile pins and the version the port reports cannot drift
 * apart. Everything else in this package is an implementation detail behind it.
 */
export const MASTRA_GENERATOR_VERSION = '1.0.0';

export const mastraGenerator = createMastraGenerator(MASTRA_GENERATOR_VERSION);

export { createMastraGenerator, MASTRA_FAMILY, validateMastra } from './generator.js';
export { RETRIEVAL } from './builtins.js';
