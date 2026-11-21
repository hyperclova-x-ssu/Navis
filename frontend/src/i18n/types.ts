import type { Locale, MessageParams } from '../contracts';

export type { Locale, MessageParams };

/** API-12 MessageBundle. ko는 모든 키를 가지고 나머지 언어는 일부만 가질 수 있다. */
export interface MessageBundle<K extends string> {
  readonly id: string;
  readonly ko: Readonly<Record<K, string>>;
  readonly en: Readonly<Partial<Record<K, string>>>;
  readonly 'zh-Hans': Readonly<Partial<Record<K, string>>>;
  readonly 'zh-Hant': Readonly<Partial<Record<K, string>>>;
}
export type KeysOf<B> = B extends MessageBundle<infer K> ? K : never;

/** DATA_MODEL 10.13·11.2 단위 코드. */
export type UnitCode = 'KRW' | 'percent' | 'pp' | 'person' | 'visit' | 'reservation' | 'order' | 'item' | 'pcs' | 'L' | 'mL' | 'kg' | 'g' | 'seat' | 'table' | 'count' | 'level' | 'hour' | 'day';

export interface Formatters {
  number(n: number, o?: { maximumFractionDigits?: number }): string;
  percent(value: number, digits?: number): string;
  percentPoint(value: number): string;
  delta(value: number, kind: 'percent' | 'pp' | 'count', unit?: UnitCode): string;
  money(won: number, style: 'compact' | 'full'): string;
  quantity(value: number, unit: UnitCode): string;
  count(value: number, unit: UnitCode): string;
  date(iso: string, style: 'long' | 'short' | 'monthDay'): string;
  /**
   * DS 6.1 G-25 short date + time: `{M}/{D}({요일}) {HH:MM}`; with `today` equal to the date it is `오늘 {HH:MM}`.
   * `value` is `YYYY-MM-DD HH:MM` or `YYYY-MM-DDTHH:MM` (store-local, never the device clock). No time part: `오늘` or the short date.
   */
  dateTime(value: string, opts?: { today?: string }): string;
  weekday(iso: string, style: 'long' | 'short'): string;
  time(hhmm: string): string;
  hourRange(startHour: number, endHour: number): string;
  dateRange(startIso: string, endIso: string): string;
}

export interface Translator<K extends string = string> {
  readonly locale: Locale;
  t(key: K, params?: MessageParams): string;
  has(key: string): boolean;
  readonly format: Formatters;
}
