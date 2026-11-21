import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTranslator } from './translator';
import { baseBundles, type CommonKey } from './messages';
import type { KeysOf, Locale, MessageBundle, Translator } from './types';

/** Preserve LOCALES source strings; protect Korean line breaks in rendered copy. */
export function koreanScreenText(text:string):string {
  return text.replace(/[ \u00a0]·[ \u00a0]/g, '\u00a0·\u00a0')
    .replace(/([가-힣]+) 수 (있어요|없어요|있습니다|없습니다|있어|없어)/g, '$1\u00a0수\u00a0$2')
    .replace(/([가-힣]+(?:야|어|아|해|고|게|를)) (해요|했어요|하세요|해야|돼요|드려요|주세요|보세요|봐요)/g, '$1\u00a0$2');
}
const baseTranslators = new Map<Locale, Translator>();
function baseTranslator(locale: Locale): Translator {
  let t = baseTranslators.get(locale);
  if (!t) { t = createTranslator(locale, ...(baseBundles as readonly MessageBundle<string>[]));  baseTranslators.set(locale, t); }
  return t;
}

const I18nContext = createContext<Translator | null>(null);

/** 언어와 공통 묶음을 공급한다. 각 모듈은 자기 묶음을 useBundle로 더한다. */
export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(() => baseTranslator(locale), [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Provider 밖에서는 한국어 번역기. */
export function useI18n(): Translator {
  return useContext(I18nContext) ?? baseTranslator('ko');
}

const bundleCache = new Map<string, { bundles: readonly MessageBundle<string>[]; translator: Translator }>();
function sameBundles(a: readonly unknown[], b: readonly unknown[]) { return a.length === b.length && a.every((x, i) => x === b[i]); }

/** 공통 묶음 + 넘긴 묶음의 키로 타입이 좁혀진 번역기. 같은 입력이면 같은 객체를 돌려준다. */
export function useBundle<const B extends readonly MessageBundle<string>[]>(...bundles: B): Translator<KeysOf<B[number]> | CommonKey> {
  const { locale } = useI18n();
  return useMemo(() => {
    const cacheKey = `${locale}|${bundles.map((b) => b.id).join(',')}`;
    const hit = bundleCache.get(cacheKey);
    if (hit && sameBundles(hit.bundles, bundles)) return hit.translator;
    const translator = createTranslator(locale, ...bundles, ...(baseBundles as readonly MessageBundle<string>[]));
    bundleCache.set(cacheKey, { bundles, translator });
    return translator;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale, ...bundles]) as Translator<KeysOf<B[number]> | CommonKey>;
}
