import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tools/**/*.test.ts'],
    // Each Keeta account is an ordered chain, so tests that publish from the same
    // account must not run concurrently. Keep this at 1 until per-account
    // serialisation is in place (step 5).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
