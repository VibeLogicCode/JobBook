import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Database suites truncate shared tables. Running their files in parallel
    // workers against one database interleaves the truncations, producing
    // failures that look like logic bugs and do not reproduce.
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
});
