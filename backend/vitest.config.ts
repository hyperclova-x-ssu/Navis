import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{infra,packages,services,gateway}/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
