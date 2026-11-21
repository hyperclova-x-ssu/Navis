import { groupNumber } from './icu';
import type { Formatters, Locale, MessageParams, UnitCode } from './types';

type Msg = (key: string, params?: MessageParams) => string;

const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/** 매장 현지 ISO 날짜(YYYY-MM-DD)만 쓴다. 기기 시간대·현재 시각을 읽지 않는다. */
function parseIso(iso: string): { y: number; m: number; d: number; dayKey: (typeof DAY_KEYS)[number] } {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) throw new RangeError(`Invalid ISO date: ${iso}`);
  const y = Number(match[1]); const m = Number(match[2]); const d = Number(match[3]);
  const sunday0 = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { y, m, d, dayKey: DAY_KEYS[(sunday0 + 6) % 7] };
}

const oneDecimal = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function createFormatters(_locale: Locale, msg: Msg): Formatters {
  const number: Formatters['number'] = (n, o) => groupNumber(n, o?.maximumFractionDigits ?? 20);
  const percent: Formatters['percent'] = (value, digits = 1) => msg('format.percent', { n: groupNumber(value, digits) });
  const percentPoint: Formatters['percentPoint'] = (value) => msg('format.percentPoint', { n: groupNumber(value, 1) });
  const money: Formatters['money'] = (won, style) => {
    const sign = won < 0 ? (_locale === 'ko' && style === 'compact' ? '−' : '-') : '';
    const abs = Math.abs(Math.round(won));
    const full = groupNumber(abs);
    if (style === 'full') return msg('format.money.full', { sign, full });
    const big = abs >= 10000;
    const tenThousands = Math.round(abs / 1000) / 10;
    // D-244 / LOCALES 3: the 만 amount always keeps one decimal (ko 11.0만 원; zh 11.0万韩元, 11.0萬韓元, grouped when large). English shows the full won amount and ignores n.
    const n = _locale === 'ko' ? tenThousands.toFixed(1) : oneDecimal.format(tenThousands);
    return msg('format.money.compact', { sign, full, big: big ? 'yes' : 'no', n });
  };
  const count: Formatters['count'] = (value, unit: UnitCode) => {
    if (unit === 'KRW') return money(value, 'full');
    if (unit === 'percent') return percent(value);
    if (unit === 'pp') return percentPoint(value);
    return msg(`unit.${unit}`, { n: value });
  };
  const weekday: Formatters['weekday'] = (iso, style) => msg(`format.weekday.${style}.${parseIso(iso).dayKey}`);
  const date: Formatters['date'] = (iso, style) => {
    const { m, d } = parseIso(iso);
    const monthShort = msg(`format.month.short.${m}`);
    if (style === 'monthDay') return msg('format.date.monthDay', { m, d, monthShort });
    return msg(`format.date.${style}`, { m, d, monthShort, weekday: weekday(iso, style === 'long' ? 'long' : 'short') });
  };
  const time = (hhmm: string): string => {
    const match = /^(\d{1,2}):(\d{2})/.exec(hhmm);
    if (!match) throw new RangeError(`Invalid time: ${hhmm}`);
    return `${match[1].padStart(2, '0')}:${match[2]}`;
  };
  const dateTime: Formatters['dateTime'] = (value, opts) => {
    const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/.exec(value);
    if (!match) throw new RangeError(`Invalid ISO date-time: ${value}`);
    const day = match[1]; const clock = match[2];
    const isToday = opts?.today !== undefined && opts.today.slice(0, 10) === day;
    const head = isToday ? msg('format.period.today') : date(day, 'short');
    return clock ? `${head} ${time(clock)}` : head;
  };
  return {
    number,
    percent,
    percentPoint,
    delta(value, kind, unit) {
      const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '';
      const abs = Math.abs(value);
      const body = kind === 'percent' ? percent(abs) : kind === 'pp' ? percentPoint(abs) : count(abs, unit ?? 'count');
      return arrow + body;
    },
    money,
    quantity: (value, unit) => count(value, unit),
    count,
    date,
    dateTime,
    weekday,
    time,
    hourRange: (s, e) => msg('format.hourRange', { s, e, sp: String(s).padStart(2, '0'), ep: String(e).padStart(2, '0') }),
    dateRange: (a, b) => { const start=parseIso(a),end=parseIso(b); return _locale==='ko'&&start.y===end.y&&start.m===end.m?`${start.m}월 ${start.d}일~${end.d}일`:msg('format.dateRange', { start: date(a, 'monthDay'), end: date(b, 'monthDay') }); },
  };
}
