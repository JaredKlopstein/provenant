import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The site's font loader is a Next build-time transform; tests that render
    // app/layout.tsx get a stub instead (packages/site/src/fonts.ts).
    alias: {
      'next/font/google': new URL('./packages/site/test/next-font-google.stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The chain, canonicalization, timestamp-verification and signature tests are
    // the places correctness genuinely matters. Keep them fast enough that nobody
    // is tempted to skip them. (Fencing-token tests arrive with Phase 4.)
    testTimeout: 20_000,
  },
});
