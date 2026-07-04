import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/**/*.integration.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['test/**/*.integration.test.ts'],
          // These suites share one scratch database (TEST_DATABASE_URL) and
          // wipe/seed the same rows in beforeAll — parallel files race. Keep
          // them sequential here so every runner (local or CI) is safe, while
          // the unit project above keeps full file parallelism.
          fileParallelism: false,
        },
      },
    ],
  },
});
