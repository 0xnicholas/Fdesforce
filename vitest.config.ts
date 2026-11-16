import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests run against package source, so `pnpm test` does not depend on a
    // fresh `tsc -b`; `pnpm typecheck` still checks the built declaration graph.
    alias: {
      '@fde/spec': resolve(import.meta.dirname, 'packages/spec/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
});
