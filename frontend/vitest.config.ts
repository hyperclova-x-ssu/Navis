import { existsSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

// Some suites replay data that is kept outside this repository:
// - the recorded Navis conversation corpus (../.evidence/navis-scenarios)
// - the product copy tables (../01_product/LOCALES.md)
// When those files are absent the suites are excluded instead of failing.
const localOnly: Record<string, string[]> = {
  '../.evidence/navis-scenarios': [
    'src/features/assistant/navis-conversation.test.ts',
    'src/features/assistant/domains/{booking,calendar-staff,coupons,custom,inventory,layout,local,manuals-grants,members,menu,notices,operations,promotion,replies,settings,suppliers}.test.ts',
  ],
  '../01_product/LOCALES.md': ['src/i18n/messages.test.ts', 'src/i18n/formatters.test.ts'],
};
const missing = Object.entries(localOnly).flatMap(([path, tests]) => (existsSync(new URL(path, import.meta.url)) ? [] : tests));

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [...configDefaults.exclude, ...missing],
    // Full-size × four-language rendering suites are slow on busy machines.
    testTimeout: 15000,
    clearMocks: true,
    restoreMocks: true,
  },
});
