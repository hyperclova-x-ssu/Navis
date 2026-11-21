import type { MessageBundle } from './types';

/** 묶음을 타입 안전하게 정의한다(키 오탈자는 타입 검사가 막는다). */
export function defineBundle<K extends string>(bundle: MessageBundle<K>): MessageBundle<K> {
  return bundle;
}

/** 테스트용: 둘 이상의 묶음에 나타나는 키와 그 묶음 id 목록. */
export function findDuplicateKeys(...bundles: readonly MessageBundle<string>[]): { key: string; bundles: string[] }[] {
  const seen = new Map<string, string[]>();
  for (const b of bundles) {
    const keys = new Set([...Object.keys(b.ko), ...Object.keys(b.en), ...Object.keys(b['zh-Hans']), ...Object.keys(b['zh-Hant'])]);
    for (const k of keys) seen.set(k, [...(seen.get(k) ?? []), b.id]);
  }
  return [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, bundles: ids }));
}

/** 테스트용: 한국어가 비었거나 없는 키. 다른 언어에만 있는 키도 포함한다. */
export function findKoGaps(...bundles: readonly MessageBundle<string>[]): { bundle: string; key: string }[] {
  const out: { bundle: string; key: string }[] = [];
  for (const b of bundles) {
    for (const [k, v] of Object.entries(b.ko)) if (!v) out.push({ bundle: b.id, key: k });
    for (const loc of ['en', 'zh-Hans', 'zh-Hant'] as const) {
      for (const k of Object.keys(b[loc])) if (!(k in b.ko)) out.push({ bundle: b.id, key: k });
    }
  }
  return out;
}
