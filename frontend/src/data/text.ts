import type { DataText, TextParams } from './db/types';

export type Translate = (key: string, params?: TextParams) => string;

/**
 * Turns a `DataText` into display text with the caller's translator (no i18n import here):
 * raw owner text is returned as typed; `keyParams` are translated first and merged into params.
 */
export function resolveDataText(t: Translate, text: DataText | null | undefined): string {
  if (!text) return '';
  if ('raw' in text) return text.raw;
  const translated = text.keyParams ? Object.fromEntries(Object.entries(text.keyParams).map(([name, key]) => [name, t(key)])) : undefined;
  return t(text.key, translated || text.params ? { ...text.params, ...translated } : undefined);
}
