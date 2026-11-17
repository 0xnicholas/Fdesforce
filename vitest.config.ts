import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against package source, so `pnpm test` does not depend on a
    // fresh `tsc -b`; `pnpm typecheck` still checks the built declaration graph.
    alias: {
      '@fde/spec': resolve(import.meta.dirname, 'packages/spec/src/index.ts'),
      '@fde/contracts-client': resolve(import.meta.dirname, 'packages/contracts-client/src/index.ts'),
      '@fde/runtime-generator': resolve(import.meta.dirname, 'packages/runtime-generator/src/index.ts'),
      '@fde/bundle': resolve(import.meta.dirname, 'packages/bundle/src/index.ts'),
      '@fde/runtime-generator-mastra': resolve(import.meta.dirname, 'packages/runtime-generator-mastra/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
