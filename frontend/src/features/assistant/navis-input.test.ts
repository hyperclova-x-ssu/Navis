import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FeatureId } from '../../contracts';
import { addDays, TODAY, weekdayOf } from '../../data/db/time';
import { cafeScenarioValues } from './__fixtures__/scenario-cafe';
import fixture from './__fixtures__/n01-utterances.json';
import { normalizeNavisName, parseNavisDate, parseNavisMoney, parseNavisNumber, parseNavisPeriod, parseNavisQuantity, parseNavisTime, parsePendingResponse, readNavisNoticeDate, resolveNavisName } from './navis-input';
import { parseMenuCreateInput, readNavisCondition } from './snapshot';

describe('Navis slot parsing', () => {
  it.each([
    ['삼천오백 원', 3500], ['3.5천', 3500], ['만 이천 원', 12000], ['1.2만', 12000],
    ['₩5,500', 5500], ['0원', 0], ['-5원', -5], ['마이너스 삼천 원', -3000], ['12원에서 13원', undefined],
    ['12,34원', undefined], ['라테 10개', undefined],
  ])('parses %s as one unambiguous amount', (text, amount) => expect(parseNavisMoney(text)).toBe(amount));

  it.each([
    ['두 박스', 2, 'box'], ['5리터', 5, 'L'], ['한 판', 1, 'tray'], ['3개', 3, 'pcs'],
    ['반 근', 0.5, 'geun'], ['스물한 명', 21, 'person'], ['1,200mL', 1200, 'mL'],
  ])('preserves quantity and unit in %s', (text, value, unit) => expect(parseNavisQuantity(text)).toEqual({ value, unit }));

  it.each([
    ['모레', addDays(TODAY, 2)], ['다음 주 화요일', addDays(TODAY, 9 - weekdayOf(TODAY))],
    ['이번 달 말', '2026-11-30'], ['내일 오전 열 시', addDays(TODAY, 1)], ['2026-02-30', undefined], ['10월 25일', '2026-10-25'],
    ['오늘과 내일', undefined], ['다음 달 2일', '2026-12-02'],
  ])('resolves %s against the business date', (text, date) => expect(parseNavisDate(text)).toBe(date));

  it.each([
    ['오후 세 시 반', '15:30'], ['내일 오전 열 시', '10:00'], ['오후 12시', '12:00'],
    ['오전 열두 시', '00:00'], ['24:00', undefined], ['오후 세 시 또는 네 시', undefined],
    ['한 시간 뒤', '16:45'],
  ])('resolves %s as one time', (text, time) => expect(parseNavisTime(text)).toBe(time));

  it.each([
    ['응', 'yes'], ['ㅇㅇ', 'yes'], ['아니', 'no'], ['잠깐 수정할래', 'edit'], ['취소해줘', 'cancel'],
    ['응 지난주 매출 보여줘', undefined],
  ])('recognizes only a standalone pending response in %s', (text, response) => expect(parsePendingResponse(text)).toBe(response));

  it('resolves a spelled variant against known names and exposes ties', () => {
    const labels = ['카라멜 마키아토', '카페라테', '바닐라라테'];
    expect(normalizeNavisName('캬라멜마키야또')).toBe(normalizeNavisName(labels[0]));
    expect(resolveNavisName('캬라멜마키야또', labels)).toEqual({ kind: 'exact', matches: [labels[0]] });
    expect(resolveNavisName('라떼', labels)).toEqual({ kind: 'ambiguous', matches: labels.slice(1) });
    expect(resolveNavisName('카페라테', labels)).toEqual({ kind: 'exact', matches: [labels[1]] });
  });

  it.each(['메뉴에 하나 추가해줘', '5,500원짜리 메뉴 하나 추가해줘', '메뉴에 6,000원짜리 넣어줘', '만원짜리 신메뉴 등록', '5500원 메뉴 추가'])(
    'does not infer a menu name from %s', text => expect(parseMenuCreateInput(text)?.name).toBeUndefined(),
  );
});

const categories = ['number', 'money', 'quantity', 'unit', 'date', 'time'] as const;
function evaluate(check: (typeof fixture)[number]['checks'][number], text: string) {
  switch (check.parser) {
    case 'menuPrice': return parseMenuCreateInput(text)?.price;
    case 'money': return parseNavisMoney(text);
    case 'quantity': return parseNavisQuantity(text)?.value;
    case 'unit': return parseNavisQuantity(text)?.unit;
    case 'readCondition':
      if (!('featureId' in check) || !check.featureId) throw new Error('Expected a widget condition');
      return readNavisCondition(check.featureId as FeatureId, text, TODAY);
    case 'date': return parseNavisDate(text);
    case 'draftDate': return readNavisNoticeDate(text, TODAY);
    case 'time': return parseNavisTime(text);
    default: return parseNavisNumber(text);
  }
}

type ParserOverride = {
  readonly parserExpected?: keyof ReturnType<typeof cafeScenarioValues>;
  readonly parserClarify?: 'date' | 'period';
  readonly parserUnsupported?: boolean;
  readonly expected?: { readonly kind?: string; readonly ask?: readonly string[] };
  readonly variants?: Readonly<Record<string, ParserOverride>>;
};
// The reviewed café overlay is a local-only scenario corpus; skip the overlay suite when it is absent.
const overlayFile = new URL('../../../../.evidence/navis-scenarios/CAFE-OVERLAY.json', import.meta.url);
const hasOverlay = existsSync(overlayFile);
const reviewed = (hasOverlay ? JSON.parse(readFileSync(overlayFile, 'utf8')) : {}) as Readonly<Record<string, ParserOverride>>;
const cafe = cafeScenarioValues();

describe.skipIf(!hasOverlay)('N00/N01 authored tool args with the café overlay', () => {
  for (const category of categories) {
    const rows = fixture.flatMap(scenario => scenario.utterances.flatMap((text, index) =>
      scenario.checks.filter(check => check.category === category).map(check => ({
        check, text, id: scenario.id, variant: index + 1,
        review: reviewed[scenario.id],
      })),
    ));
    if (!rows.length) continue;
    it(`scores every ${category} argument against its reviewed expectation`, () => {
      let clarifications = 0;
      for (const { check, text, id, variant, review } of rows) {
        const correction = review?.variants?.[String(variant)];
        const details = { ...review, ...correction };
        const context = `${id} / ${variant} ${check.parser}`;
        const clarification = category === 'date' ? details.parserClarify : undefined;
        if (clarification) {
          expect(details.expected, context).toMatchObject({ kind: 'clarify', ask: [clarification] });
          const parsed = clarification === 'period' ? parseNavisPeriod(text, TODAY) : parseNavisDate(text, TODAY);
          expect(parsed, context).toBeUndefined();
          clarifications++;
          continue;
        }
        const scope = category === 'date' ? details.parserExpected : undefined;
        if (details.parserUnsupported) {
          expect(parseNavisPeriod(text, TODAY), context).toEqual({ start: '2026-09-01', end: '2026-09-30' });
          expect(evaluate(check, text), context).toBeNull();
        } else {
          expect(evaluate(check, text), context).toEqual(scope ? cafe[scope] : check.expected);
        }
      }
      expect(rows).toHaveLength(category === 'date' ? 102 : 25);
      expect(clarifications).toBe(category === 'date' ? 11 : 0);
    });
  }
});
