import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    // The chain, fencing, and signature tests are the only places correctness
    // genuinely matters. Keep them fast enough that nobody is tempted to skip them.
    testTimeout: 20_000,
  },
});
