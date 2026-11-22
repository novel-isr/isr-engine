import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/{dev-css-lifecycle,production}/*.spec.ts'],
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 130_000,
    expect: { poll: { timeout: 15_000 } },
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'test-results/e2e.xml' },
  },
});
