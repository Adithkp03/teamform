import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // All suites share one Postgres database; they must run serially, one worker.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
  },
});
