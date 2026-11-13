import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // DB tests share one Postgres database; run files serially to keep them deterministic.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: { APP_ENV: 'test' },
  },
});
