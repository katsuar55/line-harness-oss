import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@line-crm/line-sdk': new URL('../../packages/line-sdk/src/index.ts', import.meta.url).pathname,
      '@line-crm/db': new URL('../../packages/db/src/index.ts', import.meta.url).pathname,
      '@line-crm/shared': new URL('../../packages/shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
