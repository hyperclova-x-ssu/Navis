import { addDays, isIsoDate, NOW, weekdayOf } from '../../data/db/time';

export const normalizeNavisInput = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

const digits = '[+-]?(?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]+)?';
const sino = '영공일이삼사오육칠팔구십백천만억조';
const native = {
  한: 1, 하나: 1, 두: 2, 둘: 2, 세: 3, 셋: 3, 네: 4, 넷: 4, 다섯: 5, 여섯: 6, 일곱: 7,
  여덟: 8, 아홉: 9, 열: 10, 스무: 20, 스물: 20, 서른: 30, 마흔: 40, 쉰: 50, 예순: 60,
  일흔: 70, 여든: 80, 아흔: 90, 반: 0.5,
} as const;
const nativeKeys = Object.keys(native).sort((a, b) => b.length - a.length).join('|');
const nativePattern = `(?:열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)(?:\\s*(?:${nativeKeys}))?|(?:${nativeKeys})`;
const sinoPattern = `(?:${digits}|[${sino}]+)(?:\\s*[${sino}]|\\s*${digits})*`;
const numberPattern = `(?:${nativePattern}|${sinoPattern})`;

export function parseNavisNumber(text: string): number | undefined {
  const value = normalizeNavisInput(text).replace(/\s+/gu, '');
  if (new RegExp(`^${digits}$`, 'u').test(value)) {
    const number = Number(value.replaceAll(',', ''));
    return Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : undefined;
  }
  if (Object.hasOwn(native, value)) return native[value as keyof typeof native];
  const nativePair = /^(열|스물|서른|마흔|쉰|예순|일흔|여든|아흔)(.+)$/u.exec(value);
  if (nativePair) {
    const ones = native[nativePair[2] as keyof typeof native];
    return ones >= 1 && ones <= 9 ? native[nativePair[1] as keyof typeof native] + ones : undefined;
  }

  const sign = value.startsWith('-') ? -1 : 1;
  const tokens = value.replace(/^[+-]/u, '').match(new RegExp(`(?:${digits.replace('[+-]?', '')}|[${sino}])`, 'gu'));
  if (!tokens || tokens.join('') !== value.replace(/^[+-]/u, '')) return undefined;
  const digitNames = '영일이삼사오육칠팔구';
  const small = { 십: 10, 백: 100, 천: 1000 } as const;
  const large = { 만: 10000, 억: 100000000, 조: 1000000000000 } as const;
  let total = 0, group = 0, pending: number | undefined;
  let smallCeiling = Infinity, largeCeiling = Infinity;
  for (const token of tokens) {
    const smallUnit = small[token as keyof typeof small];
    const largeUnit = large[token as keyof typeof large];
    if (smallUnit) {
      if (smallUnit >= smallCeiling) return undefined;
      group += (pending ?? 1) * smallUnit;
      pending = undefined;
      smallCeiling = smallUnit;
    } else if (largeUnit) {
      if (largeUnit >= largeCeiling) return undefined;
      total += (group || pending !== undefined ? group + (pending ?? 0) : 1) * largeUnit;
      group = 0;
      pending = undefined;
      smallCeiling = Infinity;
      largeCeiling = largeUnit;
    } else {
      if (pending !== undefined) return undefined;
      pending = token === '공' ? 0 : token.length === 1 && digitNames.includes(token) ? digitNames.indexOf(token) : Number(token.replaceAll(',', ''));
      if (!Number.isFinite(pending)) return undefined;
    }
  }
  const result = sign * (total + group + (pending ?? 0));
  return Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : undefined;
}

function only<T>(values: readonly T[]): T | undefined {
  return values.length === 1 ? values[0] : undefined;
}

export interface NavisMoneySpan { readonly value: number; readonly start: number; readonly end: number }
export function navisMoneySpans(text: string): NavisMoneySpan[] {
  const expression = new RegExp(`(?<![\\p{L}\\d,.-])(?:₩\\s*(${sinoPattern})(?![\\d,])|(?:(마이너스)\\s+)?(${sinoPattern})\\s*(?:원(?:짜리|에|으로)?|KRW|韩元|韓元))`, 'giu');
  return [...text.matchAll(expression)].flatMap(match => {
    const amount = parseNavisNumber(match[1] ?? match[3]);
    const value = amount === undefined ? undefined : match[2] ? -Math.abs(amount) : amount;
    return value === undefined ? [] : [{ value, start: match.index, end: match.index + match[0].length }];
  });
}

export function parseNavisMoney(text: string): number | undefined {
  const value = normalizeNavisInput(text);
  const amounts = navisMoneySpans(value);
  if (amounts.length) return only(amounts)?.value;
  if (new RegExp(`^${sinoPattern}$`, 'u').test(value)) return parseNavisNumber(value);
  return undefined;
}

const units = {
  '개': 'pcs', pcs: 'pcs', '박스': 'box', box: 'box', '상자': 'box', '판': 'tray', '근': 'geun',
  '리터': 'L', '엘': 'L', l: 'L', '밀리리터': 'mL', ml: 'mL', '킬로그램': 'kg', '킬로': 'kg',
  kg: 'kg', '그램': 'g', g: 'g', '병': 'bottle', '명': 'person', '분': 'person',
  '봉지': 'bag', '팩': 'pack', '장': 'sheet', '잔': 'cup',
} as const;
export type NavisUnit = typeof units[keyof typeof units];
export function parseNavisQuantity(text: string): { readonly value: number; readonly unit: NavisUnit } | undefined {
  const expression = new RegExp(`(?<![\\p{L}\\d,.-])(${numberPattern})\\s*(${Object.keys(units).sort((a, b) => b.length - a.length).join('|')})(?![a-z])`, 'giu');
  const match = only([...normalizeNavisInput(text).matchAll(expression)]);
  const value = match && parseNavisNumber(match[1]);
  return match && value !== undefined ? { value, unit: units[match[2].toLowerCase() as keyof typeof units] } : undefined;
}

const isoDate = (year: number, month: number, day: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const thisMonth = (anchor: string, offset = 0) => {
  const [year, month] = anchor.split('-').map(Number);
  const index = year * 12 + month - 1 + offset;
  return isoDate(Math.floor(index / 12), index % 12 + 1, 1);
};
const weekStart = (anchor: string) => addDays(anchor, 1 - weekdayOf(anchor));
const weekday = '월화수목금토일';
const relativeDays = { 그저께: -2, 어제: -1, 오늘: 0, 내일: 1, 모레: 2, 글피: 3 } as const;

export function parseNavisDate(text: string, businessDate = NOW.slice(0, 10)): string | undefined {
  if (!isIsoDate(businessDate)) return undefined;
  const value = normalizeNavisInput(text);
  const candidates: string[] = [];
  const addDate = (expression: RegExp, resolve: (match: RegExpMatchArray) => string) => {
    for (const match of value.matchAll(expression)) candidates.push(resolve(match));
  };
  const year = Number(businessDate.slice(0, 4));
  addDate(/(?<![\d.])(?:(\d{4})[-./])?(\d{1,2})[-./](\d{1,2})(?![\d/.])/gu, m => isoDate(m[1] ? Number(m[1]) : year, Number(m[2]), Number(m[3])));
  addDate(/(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/gu, m => isoDate(m[1] ? Number(m[1]) : year, Number(m[2]), Number(m[3])));
  addDate(/(?<![가-힣])(그저께|어제|오늘|내일|모레|글피)(?=$|[^가-힣]|은|는|에|로|까지|부터|과)/gu, m => addDays(businessDate, relativeDays[m[1] as keyof typeof relativeDays]));
  addDate(/(?<![가-힣])(?:(이번|다음|지난|저번)\s*주\s*)?([월화수목금토일])요일/gu, m => {
    const offset = m[1] === '다음' ? 7 : m[1] === '지난' || m[1] === '저번' ? -7 : 0;
    const date = addDays(weekStart(businessDate), offset + weekday.indexOf(m[2]));
    return !m[1] && date < businessDate ? addDays(date, 7) : date;
  });
  addDate(/(?<![가-힣])(이번|다음|지난|저번)\s*달\s*(말|초|\d{1,2}\s*일)/gu, m => {
    const offset = m[1] === '다음' ? 1 : m[1] === '이번' ? 0 : -1;
    if (m[2] === '말') return addDays(thisMonth(businessDate, offset + 1), -1);
    return thisMonth(businessDate, offset).slice(0, 8) + String(m[2] === '초' ? 1 : Number(m[2].replace(/\s*일/u, ''))).padStart(2, '0');
  });
  const date = only(candidates);
  return isIsoDate(date) ? date : undefined;
}

/** Undated general notices default to the business day. A dated event needs an explicit date. */
export function readNavisNoticeDate(text: string, businessDate: string): string | undefined {
  return parseNavisDate(text, businessDate) ?? (/행사|\bevent\b/iu.test(text) ? undefined : businessDate);
}

export interface NavisDateRange { readonly start: string; readonly end: string }
export function parseNavisPeriod(text: string, businessDate = NOW.slice(0, 10)): NavisDateRange | undefined {
  if (!isIsoDate(businessDate)) return undefined;
  const value = normalizeNavisInput(text);
  const ends = value.split(/\s*(?:부터|~|～|\bto\b)\s*/iu);
  if (ends.length === 2) {
    const start = parseNavisDate(ends[0], businessDate), end = parseNavisDate(ends[1], businessDate);
    return start && end && start <= end ? { start, end } : undefined;
  }
  const month = /(?<![가-힣])(?:(이번|지난|저번|다음)\s*달|(\d{1,2})\s*월)(?!\s*(?:\d+\s*일|말|초))/u.exec(value);
  if (month) {
    const offset = month[2] ? Number(month[2]) - Number(businessDate.slice(5, 7))
      : month[1] === '이번' ? 0 : month[1] === '다음' ? 1 : -1;
    if (month[2] && (Number(month[2]) < 1 || Number(month[2]) > 12)) return undefined;
    return { start: thisMonth(businessDate, offset), end: offset === 0 ? businessDate : addDays(thisMonth(businessDate, offset + 1), -1) };
  }
  const week = /(?<![가-힣])(이번|다음|지난|저번)\s*주(?!\s*[월화수목금토일]요일)/u.exec(value);
  if (week) {
    const start = addDays(weekStart(businessDate), week[1] === '이번' ? 0 : week[1] === '다음' ? 7 : -7);
    return { start, end: addDays(start, 6) };
  }
  const rollingDays = /(?<!\d)(?:최근\s*)?(\d{1,3})\s*일(?!\s*(?:[월화수목금토일]요일|에|부터|까지|간격))/u.exec(value);
  const days = rollingDays ? Number(rollingDays[1]) : /일\s*주일/u.test(value) ? 7 : /한\s*달/u.test(value) ? 30 : 0;
  if (days && !parseNavisDate(value, businessDate)) return { start: addDays(businessDate, 1 - days), end: businessDate };
  return undefined;
}

export function parseNavisTime(text: string, businessNow = NOW): string | undefined {
  const value = normalizeNavisInput(text);
  const colon = [...value.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gu)];
  const hours = [...value.matchAll(new RegExp(`(?<![\\p{L}\\d])(?:(오전|오후)\\s*)?(${numberPattern})\\s*시(?!간|대)(?:\\s*(?:(반)|(${numberPattern})\\s*분))?`, 'gu'))];
  const format = (hour: number, minute: number) => Number.isInteger(hour) && Number.isInteger(minute) && hour >= 0 && hour < 24 && minute >= 0 && minute < 60
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` : undefined;
  if (colon.length + hours.length > 1) return undefined;
  if (colon.length === 1) return format(Number(colon[0][1]), Number(colon[0][2]));
  if (hours.length === 1) {
    const [, meridiem, rawHour, half, rawMinute] = hours[0];
    const hour = parseNavisNumber(rawHour);
    if (hour === undefined || meridiem && (hour < 1 || hour > 12)) return undefined;
    return format(meridiem ? hour % 12 + (meridiem === '오후' ? 12 : 0) : hour, half ? 30 : rawMinute ? parseNavisNumber(rawMinute) ?? NaN : 0);
  }
  const relative = only([...value.matchAll(new RegExp(`(?<![\\p{L}\\d])(${numberPattern})\\s*(시간|분)\\s*(뒤|후|전)`, 'gu'))]);
  if (!relative) return undefined;
  const [hour, minute] = businessNow.slice(11, 16).split(':').map(Number);
  const offset = (parseNavisNumber(relative[1]) ?? NaN) * (relative[2] === '시간' ? 60 : 1) * (relative[3] === '전' ? -1 : 1);
  const target = ((hour * 60 + minute + offset) % 1440 + 1440) % 1440;
  return format(Math.floor(target / 60), target % 60);
}

const nameVariants: readonly [RegExp, string][] = [
  [/캬라멜|캐러멜/gu, '카라멜'], [/마키야또|마키아또|마끼아또|마끼아토/gu, '마키아토'],
  [/아메리까노/gu, '아메리카노'], [/라떼|ᄅᄐ/gu, '라테'], [/크로아상|크로와상/gu, '크루아상'],
];
export function normalizeNavisName(text: string): string {
  return nameVariants.reduce((key, [variant, canonical]) => key.replace(variant, canonical),
    normalizeNavisInput(text).toLowerCase().replace(/[\s\p{P}]/gu, ''));
}
export function resolveNavisName<T>(query: string, records: readonly T[], label: (record: T) => string = String) {
  const key = normalizeNavisName(query);
  const keyed = records.map(record => ({ record, key: normalizeNavisName(label(record)) }));
  const exact = keyed.filter(item => item.key && item.key === key);
  const matches = exact.length ? exact : keyed.filter(item => key.length > 1 && item.key.length > 1 && (item.key.includes(key) || key.includes(item.key)));
  const kind = !matches.length ? 'missing' : matches.length > 1 ? 'ambiguous' : exact.length ? 'exact' : 'similar';
  return { kind, matches: matches.map(item => item.record) } as const;
}

export type PendingResponse = 'yes' | 'no' | 'edit' | 'cancel';
export function parsePendingResponse(text: string): PendingResponse | undefined {
  const value = normalizeNavisInput(text).toLowerCase().replace(/[.!?。！？]+$/u, '').trim();
  if (/^(응|네|예|ᄋᄋ|좋아|그래|진행해(?:줘)?|확인(?:해줘)?|yes|ok(?:ay)?|好|是)$/u.test(value)) return 'yes';
  if (/^(아니|아니요|싫어|ᄂᄂ|no|不)$/u.test(value)) return 'no';
  if (/^(?:잠깐\s*)?(?:(?:수정|고치기|변경)(?:할래|해줘)?|고칠래|edit|修改)$/u.test(value)) return 'edit';
  if (/^(취소(?:해\s*줘|할래)?|하지\s*마|그만|cancel|取消)$/u.test(value)) return 'cancel';
  return undefined;
}
