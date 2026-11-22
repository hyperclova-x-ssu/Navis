import { addDays, isIsoDate, NOW, weekdayOf } from '../../data/db/time';
import type { MenuCategory } from '../../contracts';

export const normalizeNavisInput = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim();

/**
 * Everyday spellings an owner types on a phone: a slip in a store word ("매츨", "재곱"). Café slang such as "아아" is left alone on purpose:
 * the reviewed contract (A-3 S8-079) asks which menu is meant. Only store words are repaired, so a name or a longer word is never rewritten.
 */
const COLLOQUIAL: readonly (readonly [RegExp, string])[] = [
  [/매츨|메출|맷출|매축(?=\s|$|[이가은는도를])/gu, '매출'],
  [/재곱|재꼬|제고(?=\s*(?:부족|얼마|있|없|알려|확인|가|는|를|이))/gu, '재고'],
  [/예얀|예얍|얘약/gu, '예약'],
  [/쿠퐁|쿠뽕|큐폰/gu, '쿠폰'],
];
export function repairColloquial(text: string): string {
  return COLLOQUIAL.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}

export function parseMenuCategoryChoice(text: string): MenuCategory | undefined {
  const value = normalizeNavisInput(text);
  if (/^(?:커피|coffee|咖啡)$/iu.test(value)) return 'coffee';
  if (/^(?:티|차|tea|茶)$/iu.test(value)) return 'tea';
  if (/^(?:음료|beverage|drinks?|饮品|飲品)$/iu.test(value)) return 'beverage';
  if (/^(?:디저트|desserts?|甜点|甜點)$/iu.test(value)) return 'dessert';
  return undefined;
}

const quotedText = /"[^"\n]+"|“[^”\n]+”|'[^'\n]+'|‘[^’\n]+’|「[^」\n]+」|『[^』\n]+』/gu;
const webAddress = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)[^\s<>]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,63}(?=\/)/iu;
const namedWebRequest = /(?:(?:네이버|구글|유튜브|\b(?:naver|google|youtube)\b)\s*페이지|(?:네이버|구글|다음|유튜브|\b(?:naver|google|youtube)\b)\s*(?:사이트|홈페이지|웹))\s*(?:에서|로|의|를|열어)|(?:인터넷|웹)\s*(?:에서|으로)\s*(?:검색|찾아|가져)/iu;
const travelRequest = /(?:항공권|비행기|기차표|호텔|flight|train ticket|hotel).*(?:예약|예매|추천|book|recommend)/iu;
const weatherRequest = /^(?:(?:오늘|내일|지금|이번\s*주)\s*)?(?:날씨|일기\s*예보|미세먼지|비\s*와)(?:\s*(?:어때|알려|보여|어떻게).*)?[?？.]*$/u;
const unrelatedRequest = /(?:^(?:웃긴\s*(?:얘기|이야기)|아재\s*개그|(?:너\s*)?농담|로또\s*번호)|노래\s*불러|(?:파이썬|자바스크립트)\s*코드\s*(?:짜|써|작성)|선거\s*누가\s*이길|비트코인.*(?:사야|팔아야))/u;
const systemRequest = /(?:시스템\s*(?:프롬프트|지시)|개발자\s*(?:프롬프트|지시)|\b(?:system prompt|developer instruction)s?\b).*(?:무시|보여|알려|줘|출력|읽어|공개)|(?:지시|규칙|제한)(?:을|를)?\s*(?:무시|해제)|(?:이전|지금까지).*규칙.*(?:잊|무시)|\b(?:ignore|forget) (?:all |any |your )?(?:previous|prior|system) (?:rules|instructions)\b|\bDAN\b.*제한\s*없이|(?:관리자|개발자)\s*모드\s*(?:켜|로\s*전환)/iu;
const secretRequest = /(?:(?<![가-힣])키(?:를|은|는|이|가|값|좀)?(?![가-힣])|(?:비밀|인증|암호)\s*키|비밀번호|환경\s*변수|\b(?:api key|secret token|password)s?\b).*(?:보여|알려|뭐야|출력|읽어|공개)|\b(?:reveal|show|print|dump)\b.*\b(?:api key|secret token|password|system prompt)s?\b/iu;
const reportedText = /(?:^|\s)(?:이?라고\s*(?:적혀|쓰여|했어|했다|말했|보냈)|라는\s*(?:말|(?:내용|문구)(?:을|를)?\s*검토)|(?:가|이)?\s*(?:인쇄|기록|표시)(?:됐|되었|돼)|was written|it says)/iu;

export function navisPayloadPrefix(text: string): string | undefined {
  const plain = text.replace(quotedText, ' ');
  return /^(.*?메모(?:는|를)?\s*):/u.exec(plain)?.[1]
    ?? /^(.*?메모에)\s+.+?\s*이?라고\s*적어\s*(?:줘|주세요)[.!?。！？]*$/u.exec(plain)?.[1]
    ?? /^(.*?(?:리뷰|후기|답글|답장|공지).*?(?:초안|요약|문구|적어|정리|바꿔)[^:]*):\s*/u.exec(plain)?.[1];
}

export function navisDirective(text: string): string {
  return (navisPayloadPrefix(text) ?? text.replace(quotedText, ' ')).trim();
}

/** Ignore a quoted record value when deciding whether the owner asked to access the web. */
export function navisScopeIssue(text: string): 'externalLink' | 'quotedInstruction' | 'outsideStore' | undefined {
  const plain = navisDirective(text);
  if (webAddress.test(plain) || namedWebRequest.test(plain)
    || webAddress.test(text) && /링크|사이트|페이지|\b(?:link|site|page|url)\b/iu.test(plain)) return 'externalLink';
  if (plain !== text && (!plain || reportedText.test(plain))) return 'quotedInstruction';
  if (travelRequest.test(plain) || weatherRequest.test(plain) || unrelatedRequest.test(plain)
    || systemRequest.test(plain) || secretRequest.test(plain)) return 'outsideStore';
}

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

// ---------------------------------------------------------------------------------------------
// G-003: percentages, relative changes, rounding, measures and approximate values.
// Everything here is a pure local parse. Raw text and amounts never leave the browser.
// ---------------------------------------------------------------------------------------------

const percentSuffix = '(?:%|퍼센트|프로(?![모그젝필세덕페])|퍼(?![가-힣]))';
const percentExpression = () => new RegExp(`(?<![\\p{L}\\d.,+-])([0-9]+(?:\\.[0-9]+)?|[${sino}]+)\\s*${percentSuffix}`, 'giu');

/** One percentage between 0 and 1000 with at most two decimals. A second or malformed value is ambiguous. */
export function parseNavisPercent(text: string): number | undefined {
  const match = only([...normalizeNavisInput(text).matchAll(percentExpression())]);
  if (!match) return undefined;
  const value = /^[0-9]/u.test(match[1]) ? Number(match[1]) : parseNavisNumber(match[1]);
  return value !== undefined && value > 0 && value <= 1000 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9 ? value : undefined;
}

export type NavisAdjustment =
  | { readonly kind: 'amount'; readonly direction: 1 | -1; readonly value: number }
  | { readonly kind: 'percent'; readonly direction: 1 | -1; readonly value: number }
  /** "같은 만큼": the caller applies the last confirmed change of the same run. */
  | { readonly kind: 'same'; readonly direction: 1 | -1 };

const raiseWord = /올려|올리|올릴|인상|높여|높이|상향/u;
const lowerWord = /내려|내리|내릴|인하|낮춰|낮추|깎|할인|하향/u;
const sameWord = /똑같이|똑같은|동일하게|같은\s*(?:만큼|금액|가격|폭|액수)|그만큼|같게/u;

/** A relative price change. Direction, amount and percentage must each be unambiguous. */
export function parseNavisAdjustment(text: string): NavisAdjustment | undefined {
  const value = normalizeNavisInput(text);
  const up = raiseWord.test(value), down = lowerWord.test(value);
  if (up === down) return undefined;
  const direction = up ? 1 : -1;
  const percents = [...value.matchAll(percentExpression())];
  const amounts = navisMoneySpans(value);
  if (percents.length && amounts.length || percents.length > 1 || amounts.length > 1) return undefined;
  if (percents.length) {
    const percent = parseNavisPercent(value);
    return percent === undefined ? undefined : { kind: 'percent', direction, value: percent };
  }
  if (amounts.length) return amounts[0].value > 0 ? { kind: 'amount', direction, value: amounts[0].value } : undefined;
  return sameWord.test(value) ? { kind: 'same', direction } : undefined;
}

export interface NavisPercentPrice {
  /** The unrounded result, exact to four decimals. */
  readonly exact: number;
  /** True when more than one rounding rule applies, so the owner has to pick before any card. */
  readonly needsChoice: boolean;
  readonly options: readonly { readonly id: 'exact' | 'nearest1' | 'nearest100'; readonly value: number }[];
}

/**
 * Price after a percentage change, in integer arithmetic. A whole-won result is offered as is and rounded to
 * the nearest 100 won; a non-integral result is never shown as a price without naming its rounding rule.
 */
export function navisPercentPrice(base: number, percent: number, direction: 1 | -1): NavisPercentPrice | undefined {
  if (!Number.isSafeInteger(base) || base <= 0 || !(percent > 0) || percent > 1000 || direction === -1 && percent >= 100) return undefined;
  const basis = Math.round(percent * 100);
  if (Math.abs(percent * 100 - basis) > 1e-9) return undefined;
  const scaled = base * (10000 + direction * basis);
  if (!Number.isSafeInteger(scaled) || scaled <= 0) return undefined;
  const exact = scaled / 10000, nearest100 = Math.round(scaled / 1_000_000) * 100;
  if (scaled % 10000 === 0) {
    const options = [{ id: 'exact' as const, value: exact }, ...nearest100 > 0 && nearest100 !== exact ? [{ id: 'nearest100' as const, value: nearest100 }] : []];
    return { exact, needsChoice: options.length > 1, options };
  }
  const nearest1 = Math.round(exact);
  const options = [{ id: 'nearest1' as const, value: nearest1 }, ...nearest100 > 0 && nearest100 !== nearest1 ? [{ id: 'nearest100' as const, value: nearest100 }] : []];
  return { exact, needsChoice: true, options };
}

const measures: Readonly<Partial<Record<NavisUnit, readonly ['volume' | 'mass', number]>>> = {
  mL: ['volume', 1], L: ['volume', 1000], g: ['mass', 1], kg: ['mass', 1000],
};
const packedUnits: readonly NavisUnit[] = ['box', 'pack', 'bag', 'tray'];

/** Converts only inside one measure. Pack counts need a pack size and a 근 weighs differently per item. */
export function convertNavisQuantity(quantity: { readonly value: number; readonly unit: NavisUnit }, to: NavisUnit, packSize?: number):
  { readonly value: number } | { readonly needs: 'packSize' } | undefined {
  if (quantity.unit === to) return { value: quantity.value };
  const from = measures[quantity.unit], target = measures[to];
  if (from && target) return from[0] === target[0] ? { value: Math.round(quantity.value * from[1] / target[1] * 1e6) / 1e6 } : undefined;
  if (from || target || quantity.unit === 'geun' || to === 'geun') return undefined;
  if (to === 'pcs' && packedUnits.includes(quantity.unit)) return packSize && packSize > 0 ? { value: quantity.value * packSize } : { needs: 'packSize' };
  return undefined;
}

const approximateWord = /두세|서너|서넛|너댓|네다섯|대여섯|예닐곱|한두|두어|두서너|몇|(?<![가-힣])약(?:\s+|(?=\d))|대략|대충|정도|쯤|가량|남짓|안팎|내외|[십백천만]여\s*[개명병원]/u;
/** "두세 개", "약 3개", "5천 정도" are not values. The caller asks for an exact one. */
export function isNavisApproximate(text: string): boolean {
  return approximateWord.test(normalizeNavisInput(text));
}

/** A bare 1–12 시 without 오전/오후, a part of day or a 24-hour form: the meridiem is unresolved. */
export function isNavisTimeAmbiguous(text: string): boolean {
  const value = normalizeNavisInput(text);
  if (/오전|오후|아침|저녁|밤|새벽|낮|점심|정오|자정|\b(?:am|pm)\b/iu.test(value) || /\d{1,2}:\d{2}/u.test(value)) return false;
  const hours = [...value.matchAll(new RegExp(`(?<![\\p{L}\\d])(${numberPattern})\\s*시(?!간|대)`, 'gu'))];
  if (hours.length !== 1) return false;
  const hour = parseNavisNumber(hours[0][1]);
  return hour !== undefined && hour >= 1 && hour <= 12;
}

const ordinalWords = { 첫: 0, 두: 1, 세: 2, 네: 3, 다섯: 4 } as const;
const ordinalTail = '(?:\\s*(?:거|것|항목|걸로|으로|로|이요|요|(?:으?로\\s*)?해\\s*줘))?';
/** 0-based index of a spoken or typed ordinal among at most five candidates. -1 is the last one. */
export function parseNavisOrdinal(text: string): number | undefined {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '').trim();
  if (new RegExp(`^(?:맨\\s*위|첫\\s*번째|처음)${ordinalTail}$`, 'u').test(value)) return 0;
  if (new RegExp(`^(?:마지막|맨\\s*아래|맨\\s*끝)${ordinalTail}$`, 'u').test(value)) return -1;
  const word = new RegExp(`^(첫|두|세|네|다섯)\\s*번째${ordinalTail}$`, 'u').exec(value);
  if (word) return ordinalWords[word[1] as keyof typeof ordinalWords];
  const digit = new RegExp(`^([1-9])\\s*번(?:째)?${ordinalTail}$`, 'u').exec(value);
  return digit && Number(digit[1]) <= 5 ? Number(digit[1]) - 1 : undefined;
}

// ---------------------------------------------------------------------------------------------
// G-004: local nicknames, bulk scope and contradictory sequences. They only name what to ask.
// ---------------------------------------------------------------------------------------------

export interface NavisAlias { readonly alias: string; readonly official: string; readonly variant?: 'ice' | 'hot' }
const aliasTable: readonly { readonly pattern: string; readonly official: string; readonly variant?: 'ice' | 'hot' }[] = [
  { pattern: '아이스\\s*아메리카노', official: '아메리카노', variant: 'ice' },
  { pattern: '(?:핫|따뜻한|뜨거운)\\s*아메리카노', official: '아메리카노', variant: 'hot' },
  { pattern: '아이스\\s*아메', official: '아메리카노', variant: 'ice' },
  { pattern: '아아', official: '아메리카노', variant: 'ice' },
  { pattern: '뜨아', official: '아메리카노', variant: 'hot' },
  { pattern: '아메', official: '아메리카노' },
  { pattern: 'ᄋᄆᄅᄏᄂ', official: '아메리카노', variant: 'ice' },
];
const aliasBoundary = '(?=$|[\\s.,!?]|은|는|도|를|을|의|랑|와|과|만|으로|로)';

/** The first local nickname in a request ("아아", "뜨아"). Never an official name and never a record. */
export function findNavisAlias(text: string): NavisAlias | undefined {
  const value = normalizeNavisInput(text);
  let best: (NavisAlias & { readonly index: number }) | undefined;
  for (const entry of aliasTable) {
    const match = new RegExp(`(?<![가-힣a-z0-9])(${entry.pattern})${aliasBoundary}`, 'iu').exec(value);
    if (match && (!best || match.index < best.index || match.index === best.index && match[1].length > best.alias.length)) {
      best = { alias: match[1], official: entry.official, ...entry.variant && { variant: entry.variant }, index: match.index };
    }
  }
  return best && { alias: best.alias, official: best.official, ...best.variant && { variant: best.variant } };
}

/** The whole reply is one nickname. */
export function resolveNavisAlias(text: string): NavisAlias | undefined {
  const value = normalizeNavisInput(text).replace(/[.!?。！？]+$/u, '').trim();
  const found = findNavisAlias(value);
  return found && found.alias.length === value.length ? found : undefined;
}

export interface NavisBulkRequest { readonly scope: 'menu' | 'ledger-candidates'; readonly action: 'status' | 'confirm' }
const bulkWord = /(?<![가-힣])(?:전부|모두|모든|싹|전체|일괄)(?![가-힣])|(?<![가-힣])다(?![가-힣])|두\s*개\s*다|둘\s*다/u;
const readWord = /알려|보여|몇\s*개|얼마|어때|[?？]\s*$/u;
/** "메뉴 전부 품절", "후보 다 확인해서 넣어줘": one write at a time, so the caller asks which one first. */
export function readNavisBulkRequest(text: string): NavisBulkRequest | undefined {
  const value = normalizeNavisInput(text);
  if (!bulkWord.test(value) || readWord.test(value)) return undefined;
  if (/메뉴/u.test(value) && /품절|판매\s*중/u.test(value)) return { scope: 'menu', action: 'status' };
  if (/후보/u.test(value) && /확인|넣|확정|등록|반영/u.test(value)) return { scope: 'ledger-candidates', action: 'confirm' };
  return undefined;
}

/** "품절로 바꾸고 다시 판매 중으로": steps that cancel each other become one question about the final status. */
export function readNavisContradiction(text: string): { readonly field: 'status'; readonly options: readonly ['sold_out', 'selling'] } | undefined {
  const value = normalizeNavisInput(text);
  if ([...value.matchAll(/품절/gu)].length !== 1) return undefined;
  const revert = /품절[^.!?]*?(?:고|다가|해서|뒤에?|다음에?)\s*(?:(?:다시|바로|곧바로)\s*(?:판매\s*중|판매|팔|취소|되돌|원래)|취소|되돌려|원래대로)/u;
  return revert.test(value) ? { field: 'status', options: ['sold_out', 'selling'] } : undefined;
}

// ---------------------------------------------------------------------------------------------
// G-006 mirror of server/navis/policy.mjs classifyNavisDirective. It runs on the owner's directive only:
// quoted names, memo bodies and draft payloads are data. A refusal carries no draft and no command to run.
// ---------------------------------------------------------------------------------------------

export type NavisDirectiveCause = 'externalLink' | 'quotedInstruction' | 'outsideStore' | 'promptOverride' | 'otherStore'
  | 'bulkMenuDelete' | 'bulkMenuPrice' | 'cardPayment' | 'replyStatus';
export type NavisDirectiveAlternative =
  | { readonly featureId: 'menu' }
  | { readonly featureId: 'pos' | 'custom-order'; readonly command: 'pos.payment' | 'customOrder.openPayment'; readonly draft: Readonly<Record<string, never>> };
export type NavisDirectiveOutcome =
  /** `answer` is omitted for the legacy scope causes, which keep the existing navis.externalLink / navis.outOfScope copy. */
  | { readonly kind: 'refusal'; readonly reason: 'out_of_scope' | 'unsupported' | 'widget_only'; readonly cause: Exclude<NavisDirectiveCause, 'replyStatus'>;
      readonly answer?: string; readonly alternative?: NavisDirectiveAlternative }
  | { readonly kind: 'answer'; readonly cause: 'replyStatus'; readonly answer: string;
      readonly intent: { readonly kind: 'read'; readonly featureId: 'ai-response'; readonly condition: { readonly kind: 'default' } } };

const policyCopy = {
  unsupported: '이 요청은 도와드릴 수 없어요.',
  outOfScope: '이 매장에서 확인할 수 있는 요청만 도와드릴 수 있어요.',
  bulkDelete: '메뉴는 하나씩 지울 수 있어요. 어떤 메뉴를 지울까요?',
  bulkPrice: '모든 메뉴의 가격을 한꺼번에 바꿀 수 없어요. 바꿀 메뉴 이름을 알려 주세요. 메뉴 패널에서 직접 바꿀 수도 있어요.',
  customOrderPayment: '주문을 열고 결제 받기에서 진행해 주세요.',
  posPayment: '주문/결제 화면에서 결제해 주세요.',
  replyStatus: '답변을 보내거나 답글을 올려야 대기에서 빠져요.',
} as const;
const overrideDirective = /(?:지시|규칙)(?:는|를|을|들을)?\s*(?:무시|바꿔|변경|잊어)|시스템\s*프롬프트|system\s*prompt|(?:ignore|override|forget|change|disregard)\s+(?:(?:all|the|your|previous|prior|above)\s+)*(?:instructions?|rules?)/iu;
const overrideAction = /삭제|지워|지우|비워|없애|제거|리셋|초기화|바꿔|변경|발송|보내|전송|올려|내려|추가|등록|결제|\b(?:delete|remove|erase|clear|wipe|reset|send|change|set|add|create|mark)\b/iu;
const menuBulk = /메뉴\s*(?:가격\s*|판매가\s*)?(?:전부|모두|일괄|전체|싹|다(?=\s|지워|삭제|비워|없애))|(?:모든|전체)\s*메뉴/u;
const menuDelete = /지워|비워|없애|삭제(?:\s*(?:해|하|요청)|[.!?]?\s*$)/u;
const menuReprice = /(?:가격|판매가|[0-9]\s*원).*(?:올려|올리|내려|내리|인상|인하|바꿔|변경|수정)|(?:올려|올리|내려|내리|인상|인하|바꿔|변경|수정).*(?:가격|판매가|[0-9]\s*원)/u;
const cardSwipe = /카드(?:로)?\s*(?:결제\s*)?긁어(?:\s*(?:줘|주세요|줄래|달라)|[.!?]?\s*$)/u;
const customOrderRef = /(?:\bCO-[0-9]+\b|주문\s*제작|맞춤\s*주문|주문\s*결제|[가-힣][○●*][가-힣○●*])/iu;
const replyStatusRequest = /(?:리뷰|답글|답변).*(?:안\s*달고|안\s*해도|그냥\s*넘어가게).*(?:완료|처리|대기에서\s*빼)/u;
const negativeAction = /(?:지우|비우|없애|올리|내리|삭제하|변경하|긁)(?:지|진)\s*마/u;

/**
 * Classify the normalized owner directive before any widget, layout or continuation match. Link and
 * quoted-instruction precedence stays with navisScopeIssue. Returns undefined for a genuine read or command.
 */
export function classifyNavisDirective(text: string): NavisDirectiveOutcome | undefined {
  const normalized = normalizeNavisInput(text);
  const issue = navisScopeIssue(normalized);
  if (issue === 'externalLink' || issue === 'quotedInstruction') return { kind: 'refusal', reason: 'out_of_scope', cause: issue };
  const directive = navisDirective(normalized).replace(/\s+/gu, ' ').trim();
  if (overrideDirective.test(directive) && (!issue || overrideAction.test(directive))) {
    return { kind: 'refusal', reason: 'out_of_scope', cause: 'promptOverride', answer: policyCopy.unsupported };
  }
  if (issue) return { kind: 'refusal', reason: 'out_of_scope', cause: 'outsideStore' };
  if (/다른\s*매장|타\s*매장/u.test(directive) && /가져|수정|삭제|매출|조회|고객|보여|알려/u.test(directive)) {
    return { kind: 'refusal', reason: 'out_of_scope', cause: 'otherStore', answer: policyCopy.outOfScope };
  }
  if (negativeAction.test(directive)) return undefined;
  if (menuBulk.test(directive) && menuDelete.test(directive)) {
    return { kind: 'refusal', reason: 'unsupported', cause: 'bulkMenuDelete', alternative: { featureId: 'menu' }, answer: policyCopy.bulkDelete };
  }
  if (menuBulk.test(directive) && menuReprice.test(directive)) {
    return { kind: 'refusal', reason: 'unsupported', cause: 'bulkMenuPrice', alternative: { featureId: 'menu' }, answer: policyCopy.bulkPrice };
  }
  if (cardSwipe.test(directive)) {
    const order = customOrderRef.test(directive);
    return { kind: 'refusal', reason: 'widget_only', cause: 'cardPayment', answer: order ? policyCopy.customOrderPayment : policyCopy.posPayment,
      alternative: order ? { featureId: 'custom-order', command: 'customOrder.openPayment', draft: {} } : { featureId: 'pos', command: 'pos.payment', draft: {} } };
  }
  if (replyStatusRequest.test(directive)) {
    return { kind: 'answer', cause: 'replyStatus', intent: { kind: 'read', featureId: 'ai-response', condition: { kind: 'default' } }, answer: policyCopy.replyStatus };
  }
  return undefined;
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
