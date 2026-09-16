import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // The chain, canonicalization, timestamp-verification and signature tests are
    // the places correctness genuinely matters. Keep them fast enough that nobody
    // is tempted to skip them. (Fencing-token tests arrive with Phase 4.)
    testTimeout: 20_000,
  },
});
