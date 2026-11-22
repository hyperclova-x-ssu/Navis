import { describe, expect, it } from 'vitest';
import { commonBundle, widgetNamesBundle } from './messages';
import { posBundle } from './messages/pos';
import { findDuplicateKeys, findKoGaps } from './bundles';
import { createTranslator } from './translator';
import { locales } from '../contracts';
import { bookingCancelCopy } from '../data/reality/06/messages';
import { dataBundle } from '../data/messages';
import { mktCouponBundle } from '../features/widgets/mkt-coupon/messages';
import { localesMap, reviewKeys } from './locales-map.test-data';
import { readLocalesTables } from './locales-doc.test-util';
import { locales20Map, locales20ReferenceRows } from './locales20-map.test-data';
import type { Locale, MessageBundle } from './types';

const tables = readLocalesTables();
// LOCALES 20 writes placeholders in Korean ({이유}); the catalog uses the ICU names the other columns already use.
const norm20 = (s: string) => s
  .replace(/\{이유\}/g, '{reason}').replace(/\{지역\}/g, '{area}').replace(/\{기준일\}/g, '{date}').replace(/\{시\}/g, '{h}');
const norm = (s: string) => s
  .replace(/\{기능 이름\}(은\/는|을\/를|이\/가|과\/와)/g, '{name, particle, $1}')
  .replace(/\{기능 이름\}/g, '{name}').replace(/\{현재\}/g, '{current}').replace(/\{전체\}/g, '{total}').replace(/\{레이어\}/g, '{layer}');
// LOCALES 20 (D-323 ⑦) retired the “(예시)” tails from screen text. The older §5/§9 rows keep them until their owner rewrites the doc, so those cells are compared without the tail.
const noTail = (s: string) => s.replace(/\s?(?:\(예시\)|\(sample\)|（示例）|（範例）)/gu, '');
const all = [commonBundle, widgetNamesBundle];
const smsSetupRows = [
  ['문자 발신 번호가 비어 있을 때 안내', 'widget.slot-coupon.adHelp'],
  ['무료 수신 거부 번호가 비어 있을 때 안내', 'widget.slot-coupon.optOutHelp'],
  ['공지 문자 번호 설정 안내', 'data.real.inbox.notice.smsSetup'],
] as const;
const plan2Rows: readonly (readonly [string, string])[] = [
 [
  "추천 배치로 시작(마케팅, D-66)",
  "marketing.startPreset"
 ],
 [
  "마케팅 시작 안내",
  "marketing.startPresetHint"
 ],
 [
  "쿠폰 보내기",
  "marketing.sendCoupon"
 ],
 [
  "단골에게 쿠폰 보내기",
  "marketing.sendCouponsToRegulars"
 ],
 [
  "쿠폰 만들기",
  "marketing.createCoupon"
 ],
 [
  "쿠폰을 만들었어요",
  "marketing.couponCreated"
 ],
 [
  "알림 보내기",
  "marketing.sendReminder"
 ],
 [
  "끝나기 전 알림 보내기",
  "marketing.sendEndingReminder"
 ],
 [
  "챙기기",
  "marketing.reachOut"
 ],
 [
  "이 손님들 챙기기",
  "marketing.reachOutToThese"
 ],
 [
  "답변 확인하기",
  "marketing.checkReplies"
 ],
 [
  "영상 만들기",
  "marketing.makeVideo"
 ],
 [
  "새 영상 만들기",
  "marketing.makeNewVideo"
 ],
 [
  "홍보 영상 만들기",
  "marketing.makePromoVideo"
 ],
 [
  "저장·공유하기",
  "marketing.saveShare"
 ],
 [
  "저장했어요(예시)",
  "marketing.savedSample"
 ],
 [
  "올렸어요",
  "marketing.posted"
 ],
 [
  "경로별 자세히 보기",
  "marketing.detailsByChannel"
 ],
 [
  "일시 중지",
  "marketing.pause"
 ],
 [
  "연장",
  "marketing.extend"
 ],
 [
  "받는 사람",
  "marketing.recipients"
 ],
 [
  "혜택",
  "marketing.benefit"
 ],
 [
  "문구 미리보기",
  "marketing.messagePreview"
 ],
 [
  "할인율",
  "marketing.discountRate"
 ],
 [
  "광고 표시(문자 맨 앞)",
  "marketing.adMark"
 ],
 [
  "수신 거부 안내",
  "marketing.optOut"
 ],
 [
  "수신 동의 없음",
  "marketing.noConsent"
 ],
 [
  "받는 사람 없음",
  "marketing.noRecipients"
 ],
 [
  "보낼 곳",
  "marketing.sendTo"
 ],
 [
  "게시 전 안내",
  "marketing.postFirst"
 ]
] as const;
const raw = (l: Locale, key: string, bundles: readonly MessageBundle<string>[] = all) =>
  (bundles.find(b => Object.hasOwn(b.ko, key))?.[l] as Record<string, string | undefined> | undefined)?.[key];

describe('LOCALES 2~7절 표의 모든 칸 대조', () => {
  it.each(locales)('keeps the retired D-323 demo notices out of the copy bundles (%s)', locale => {
    expect(tables['2'].some(row => row[1] === '가짜 데이터로 만든 화면이에요')).toBe(false);
    expect(commonBundle[locale]).not.toHaveProperty(['app.fakeData']);
    expect(commonBundle[locale]).not.toHaveProperty(['preview.family.notice']);
    expect(posBundle[locale]).not.toHaveProperty(['pos.mockNote']);
  });

  const colOf = (sec: string, l: Locale) => (sec === '4' ? 2 : 1) + locales.indexOf(l);
  for (const m of localesMap) {
    // The old management rows are explicitly superseded or removed in LOCALES 11.
    if ((m.sec === '4' || m.sec === '7') && tables[m.sec].some(r => r[m.sec === '4' ? 1 : 0]?.startsWith(m.match + ' ') && r[m.sec === '4' ? 1 : 0].includes('D-2'))) continue;
    const colId = m.sec === '2' ? 1 : m.sec === '4' ? 1 : 0;
    for (const l of locales) {
      it(`${m.sec}절 ${m.match} / ${l}`, () => {
        const row = tables[m.sec].find((r) => r[colId] === m.match);
        expect(row, m.match).toBeDefined();
        const cell = norm(noTail(row![colOf(m.sec, l)]));
        if (m.wrap) {
          expect(`09:00 / 17:30 (${raw(l, m.keys[0])})`).toBe(cell);
        } else {
          expect(m.keys.map((k) => raw(l, k)).join(m.join)).toBe(cell);
        }
      });
    }
  }
  const MARKETING_IDS = ['marketing-today', 'slot-coupon', 'expiry-coupon', 'promo-video', 'coupon-status', 'customer-groups'];
  for (const id of MARKETING_IDS) {
    for (const l of locales) {
      it(`4.1절 \`${id}\` / ${l}`, () => {
        const row = tables['4'].find((r) => r[1] === `\`${id}\``);
        expect(row, id).toBeDefined();
        expect(raw(l, `widget.${id}.title`)).toBe(row![2 + locales.indexOf(l)]);
        const coach = tables['7'].find((r) => r[0] === `\`${id}\``);
        expect(coach, id).toBeDefined();
        expect(raw(l, `widget.${id}.coach`)).toBe(coach![1 + locales.indexOf(l)]);
      });
    }
  }
  for (const [match, key] of [...plan2Rows, ...smsSetupRows]) {
    for (const l of locales) {
      it(`9.1·9.2절 ${match} / ${l}`, () => {
        const row = tables['9'].find((r) => r[0] === match);
        expect(row, match).toBeDefined();
        expect(raw(l, key, [commonBundle, mktCouponBundle, dataBundle])).toBe(noTail(row![1 + locales.indexOf(l)]));
      });
    }
  }
  it('9.1·9.2절의 모든 행이 앱 문구 키에 대응한다', () => {
    const covered = new Set<string>([...plan2Rows, ...smsSetupRows].map(([m]) => m));
    const start = tables['9'].findIndex((r) => r[0] === '추천 배치로 시작(마케팅, D-66)');
    const end = tables['9'].findIndex((r) => r[0] === '게시 전 안내');
    expect(start).toBeGreaterThan(-1);
    for (const r of tables['9'].slice(start, end + 1)) {
      if (r[0] === '용도') continue;
      // Retired 2026-11-20 (owner decision: no night-send restriction); the LOCALES.md row stays until its owner removes it.
      if (r[0] === '야간 발송 제한') continue;
      expect(covered.has(r[0]), r[0]).toBe(true);
    }
  });
  // LOCALES 2절 '기능 열 짧은 이름 (en)' 표: | 묶음 | en 전체 이름 | en 레일 짧은 이름 | 이유 | (T-055).
  const railHeader = tables['2'].findIndex((r) => r[0] === '묶음' && r[2] === 'en 레일 짧은 이름');
  const railRows = railHeader < 0 ? [] : tables['2'].slice(railHeader + 1).filter((r) => r.length === 4);
  it('기능 열 짧은 이름: en 레일 글자는 표의 짧은 이름, 다른 묶음·다른 언어는 묶음 이름 그대로(접근성 이름은 전체 이름)', () => {
    expect(railHeader).toBeGreaterThan(0);
    expect(railRows.map((r) => r[0])).toEqual(['추천', '손님', '운영', '동네(마케팅)']);
    const groupOf = (ko: string) => {
      const m = localesMap.find((x) => x.sec === '2' && x.match === ko.replace(/\(.*\)$/u, '') && x.keys[0].startsWith('group.'));
      return m!.keys[0].replace(/^group\./u, '');
    };
    const shortened = new Set<string>();
    for (const [ko, full, short] of railRows) {
      const group = groupOf(ko); shortened.add(group);
      expect(raw('en', `group.${group}`), group).toBe(full);
      expect(raw('en', `group.rail.${group}`), group).toBe(short);
    }
    for (const group of ['recommended', 'news', 'money', 'customers', 'operations', 'neighborhood']) {
      for (const l of locales) {
        if (l === 'en' && shortened.has(group)) continue;
        expect(raw(l, `group.rail.${group}`), `${group} ${l}`).toBe(raw(l, `group.${group}`));
      }
    }
  });
  it('2·4·5·6·7절의 모든 행이 대응표에 있다(3절은 서식 테스트가 대조)', () => {
    const covered = new Set(localesMap.map((m) => `${m.sec}|${m.match}`));
    const idCol: Record<string, number> = { '2': 1, '4': 1, '5': 0, '6': 0, '7': 0 };
    for (const sec of ['2', '4', '5', '6', '7']) {
      for (const r of tables[sec].slice(1)) {
        // The rail short-name table (its header and rows) is checked by the test above.
        if (sec === '2' && railHeader >= 0 && tables['2'].indexOf(r) >= railHeader) continue;
        if (sec === '4' && r[1] === 'ID') continue;
        if ((sec === '4' || sec === '7') && r[idCol[sec]].includes('**(D-2')) continue;
        if ((sec === '4' || sec === '7') && MARKETING_IDS.some((id) => r[idCol[sec]] === `\`${id}\``)) continue;
        expect(covered.has(`${sec}|${r[idCol[sec]]}`), `${sec}절 ${r[idCol[sec]]}`).toBe(true);
      }
    }
  });
});

describe('LOCALES 20절 페르소나 연결 기능 문구 (D-343~D-347)', () => {
  const rows = (tables['20'] ?? []).filter(r => r[0] !== '위치');
  it('accounts for every row as catalog copy or an explicit design reference', () => {
    expect(rows.map(r => r[0]).sort()).toEqual([...locales20Map.map(m => m.match), ...locales20ReferenceRows].sort());
  });
  for (const m of locales20Map) {
    for (const l of locales) {
      it(`20절 ${m.match} / ${l}`, () => {
        const row = rows.find(r => r[0] === m.match);
        expect(row, m.match).toBeDefined();
        const cell = norm20(row![1 + locales.indexOf(l)]);
        // Some Chinese cells write the list separator without a space before it (“…（相对值）/ …”), so split on the slash.
        expect(m.keys.map(k => raw(l, k, [commonBundle, bookingCancelCopy, dataBundle])))
          .toEqual(cell.split(m.separator ?? /\s*\/\s*/u));
      });
    }
  }
  it('has no integration chip copy that LOCALES 20 replaced (calendar “연결됨(예시)” chip, “연결 대기”)', () => {
    for (const l of locales) {
      expect(commonBundle[l], l).not.toHaveProperty(['common.integration.naverCalendar']);
      for (const b of all) for (const v of Object.values(b[l] as Record<string, string>)) expect(v, `${b.id} ${l}`).not.toMatch(/연결 대기|Connection pending|等待连接|等待連線/u);
    }
  });
});

describe('묶음 규칙', () => {
  it('마케팅 11개 이름·설명·별명은 네 언어를 보존한다', () => {
    const ids = ['local-changes', 'trade-area', 'local-trends', 'ai-response', 'community', 'marketing-today', 'slot-coupon', 'expiry-coupon', 'promo-video', 'coupon-status', 'customer-groups'];
    for (const id of ids) for (const part of ['title', 'coach', 'aliases']) {
      for (const l of locales) expect(raw(l, `widget.${id}.${part}`), `${id} ${part} ${l}`).toBeTruthy();
    }
  });
  it('한국어에 빈 문자열이 없고 다른 언어에 한국어에 없는 키가 없다', () => {
    expect(findKoGaps(...all)).toEqual([]);
  });
  it('묶음 사이 키 중복이 없다', () => {
    expect(findDuplicateKeys(...all)).toEqual([]);
  });
  it('중복 감지 도우미가 실제로 중복을 찾는다', () => {
    const a = { id: 'a', ko: { x: '1' }, en: {}, 'zh-Hans': {}, 'zh-Hant': {} };
    const b = { id: 'b', ko: { x: '2' }, en: {}, 'zh-Hans': {}, 'zh-Hant': {} };
    expect(findDuplicateKeys(a, b)).toEqual([{ key: 'x', bundles: ['a', 'b'] }]);
    expect(findKoGaps({ ...a, ko: { x: '' } })).toEqual([{ bundle: 'a', key: 'x' }]);
  });
  it('접두어는 T-041 소유만 쓴다', () => {
    const ok = /^(common|app|group|page|help|format|unit|language|marketing|preview\.family)\./;
    for (const k of Object.keys(commonBundle.ko)) expect(ok.test(k), k).toBe(true);
    for (const k of Object.keys(widgetNamesBundle.ko)) expect(/^widget\.[a-z-]+\.(title|coach|aliases)$/.test(k), k).toBe(true);
  });
  it('모든 언어의 모든 키가 같은 변수를 쓴다(번역 누락·오탈자 방지)', () => {
    const vars = (s: string) => [...s.matchAll(/\{\s*([A-Za-z0-9_]+)\s*[,}]/g)].map((m) => m[1]).sort().join(',');
    for (const b of all) {
      for (const [k, ko] of Object.entries(b.ko)) {
        if (k.startsWith('format.date') || k.startsWith('format.hourRange') || k.startsWith('format.money') || k.startsWith('format.dateRange')) continue;
        for (const l of ['en', 'zh-Hans', 'zh-Hant'] as const) {
          const v = (b[l] as Record<string, string | undefined>)[k];
          if (v !== undefined) expect(vars(v), `${k} ${l}`).toBe(vars(ko));
        }
      }
    }
  });
  it('간체와 번체는 다른 번역이다', () => {
    const t = (l: Locale) => createTranslator<string>(l, commonBundle, widgetNamesBundle);
    expect(t('zh-Hans').t('widget.local-changes.title')).toBe('周边动态提醒');
    expect(t('zh-Hant').t('widget.local-changes.title')).toBe('周邊動態提醒');
    expect(t('zh-Hans').t('common.undo')).toBe('撤销');
    expect(t('zh-Hant').t('common.undo')).toBe('復原');
    expect(t('zh-Hans').t('app.layer.marketing')).not.toBe(t('zh-Hant').t('app.layer.marketing'));
  });
  it('조사가 들어간 공통 문구', () => {
    const ko = createTranslator('ko', commonBundle);
    expect(ko.t('page.moved', { name: '가계부', n: 2 })).toBe('가계부를 2페이지로 옮겼어요 · 되돌리기');
    expect(ko.t('page.moved', { name: '재고관리', n: 3 })).toBe('재고관리를 3페이지로 옮겼어요 · 되돌리기');
    expect(ko.t('page.inOtherLayer', { name: '커뮤니티', layer: '마케팅' })).toBe('커뮤니티는 마케팅에 있어요');
    expect(ko.t('page.inOtherLayer', { name: '가계부', layer: '관리' })).toBe('가계부는 관리에 있어요');
    expect(ko.t('page.status', { current: 1, total: 3 })).toBe('1/3 페이지');
    expect(createTranslator('en', commonBundle).t('page.status', { current: 1, total: 3 })).toBe('Page 1 of 3');
    expect(createTranslator('en', commonBundle).t('page.inOtherLayer', { name: 'Community', layer: 'Marketing' })).toBe('Community is in Marketing');
  });
  it('R2 검토 필요 키 목록은 실제 키다', () => {
    for (const k of reviewKeys) expect(k in commonBundle.ko || k in widgetNamesBundle.ko, k).toBe(true);
  });
});
