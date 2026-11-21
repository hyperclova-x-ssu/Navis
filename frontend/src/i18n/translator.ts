import { formatMessage } from './icu';
import { createFormatters } from './formatters';
import { commonBundle } from './messages/common';
import type { Locale, MessageBundle, Translator } from './types';

const warned = new Set<string>();
const SEED_TEXT_PREFIX = 'seed:';
function warnMissing(key: string) {
  if (!import.meta.env?.DEV || warned.has(key)) return;
  warned.add(key);
  console.warn(`[i18n] 문구가 없어요: ${key}`);
}

function lookup(bundles: readonly MessageBundle<string>[], locale: Locale, key: string): { template: string; locale: Locale } | undefined {
  for (const b of bundles) {
    const v = (b[locale] as Readonly<Record<string, string | undefined>>)[key];
    if (v) return { template: v, locale };
  }
  if (locale !== 'ko') {
    for (const b of bundles) {
      const v = (b.ko as Readonly<Record<string, string | undefined>>)[key];
      if (v) return { template: v, locale: 'ko' };
    }
  }
  return undefined;
}

/** 순수 함수. 찾는 순서: 선택 언어 → ko → 빈 문자열(개발 경고). 키 이름은 돌려주지 않는다. */
export function createTranslator<K extends string>(locale: Locale, ...bundles: MessageBundle<K>[]): Translator<K> {
  const list = bundles as readonly MessageBundle<string>[];
  const translator: Translator<string> = {
    locale,
    t(key, params) {
      if (key.startsWith(SEED_TEXT_PREFIX)) return key.slice(SEED_TEXT_PREFIX.length);
      const match = lookup(list, locale, key);
      if (!match) { warnMissing(key); return ''; }
      return formatMessage(match.template, match.locale, params);
    },
    has: (key) => key.startsWith(SEED_TEXT_PREFIX) || lookup(list, locale, key) !== undefined,
    // 서식 템플릿은 어떤 묶음을 넘겼든 항상 공통 묶음에서 읽는다.
    format: createFormatters(locale, (key, params) => {
      const match = lookup([commonBundle], locale, key);
      return match ? formatMessage(match.template, match.locale, params) : '';
    }),
  };
  return translator as Translator<K>;
}
