import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [
            'packages/*/test/**/*.test.ts',
            'apps/*/test/**/*.test.ts',
            'tests/e2e/**/*.test.ts',
            'tests/redteam/**/*.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'perf',
          include: ['tests/perf/**/*.perf.test.ts'],
          fileParallelism: false,
        },
      },
    ],
  },
});
