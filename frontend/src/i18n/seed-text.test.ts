import { expect, test } from 'vitest';
import { createTranslator } from './translator';
import { commonBundle } from './messages/common';

test.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('renders generated Korean source text verbatim in %s', locale => {
  const translator = createTranslator<string>(locale, commonBundle);
  const key = 'seed:안숭잘부 카페 {name}';
  expect(translator.has(key)).toBe(true);
  expect(translator.t(key, { name: 'ignored' })).toBe('안숭잘부 카페 {name}');
  expect(translator.has('seed:')).toBe(true);
  expect(translator.t('seed:')).toBe('');
  expect(translator.t('common.settings')).toBe(commonBundle[locale]['common.settings']);
  expect(translator.has('seeded:안숭잘부 카페')).toBe(false);
});
