import { expect, it } from 'vitest';
import { validateAgentDetailRef } from '../../../shared/navis-agent-schema.mjs';
import { selectVerifiedEvidence } from './evidence';
import { navisTranslator } from './messages';
import type { AgentReadEvidence, SnapshotFact } from './snapshot';

const ko = navisTranslator('ko');
const date = '2026-11-17';
const fact = (details: Partial<SnapshotFact> = {}): SnapshotFact => ({
  key: 'ledger.sales.daily', value: 2000, unit: 'KRW', label: '매출', display: '2,000원', date, ...details,
});
type WidgetRead = Extract<AgentReadEvidence, { tool: 'get_widget' }>;
const widget = (featureId: WidgetRead['args']['featureId'], facts: readonly SnapshotFact[],
  condition: WidgetRead['args']['condition'] = { kind: 'default' }): WidgetRead =>
  ({ tool: 'get_widget', args: { featureId, condition }, status: 'ready', facts });

it('uses only the exact supporting fact among repeated keys', () => {
  const picked = fact();
  const other = fact({ date: '2026-11-16' });
  const read = widget('ledger', [other, picked]);
  expect(selectVerifiedEvidence([read], [{ fact: picked }], ko)).toEqual([
    { source: '손익', periodLabel: '11월 17일', destination: { featureId: 'ledger', view: 'sales' }, openLabel: '손익 열기' },
  ]);
  expect(selectVerifiedEvidence([read], [{ fact: { ...picked } }], ko)).toEqual([]);
  expect(selectVerifiedEvidence([read], [], ko)).toEqual([]);
});

it.each(['missing', 'unavailable', 'unsupported_period'] as const)('drops %s reads even if a fact was retained', status => {
  const picked = fact();
  expect(selectVerifiedEvidence([{ ...widget('ledger', [picked]), status }], [{ fact: picked }], ko)).toEqual([]);
});

it('uses the fact range ahead of a broader read period and deduplicates matching rows', () => {
  const range = { start: '2026-11-15', end: date };
  const first = fact({ date: undefined, ...range });
  const second = fact({ ...first, key: 'ledger.sales.total' });
  const read = widget('ledger', [first, second], { kind: 'dateRange', start: '2026-11-11', end: date });
  expect(selectVerifiedEvidence([read], [{ fact: first }, { fact: second }], ko)).toEqual([
    { source: '손익', periodLabel: '11월 15일~17일', destination: { featureId: 'ledger', view: 'sales', condition: read.args.condition }, openLabel: '손익 열기' },
  ]);
});

it('uses plain source text when the widget has no view for a historical read period', () => {
  const historical = '2026-11-09';
  const picked = fact({ date: historical });
  const read = widget('ledger', [picked], { kind: 'dateRange', start: historical, end: historical });
  expect(selectVerifiedEvidence([read], [{ fact: picked }], ko)).toEqual([{ source: '손익', periodLabel: '11월 9일' }]);
});

it('shows a verified snapshot as of its read date', () => {
  const picked = fact({ key: 'inventory.restock.count', date: undefined });
  const read = widget('inventory-booking', [picked], { kind: 'snapshot', asOf: date });
  expect(selectVerifiedEvidence([read], [{ fact: picked }], ko)[0]?.periodLabel).toBe('11월 17일 기준');
});

it('keeps the actual verification time when the fact has an as-of timestamp', () => {
  const picked = fact();
  expect(selectVerifiedEvidence([widget('ledger', [picked])], [{ fact: picked, asOf: '2026-11-17T14:02' }], ko)[0]?.periodLabel)
    .toBe('11월 17일 14:02 기준');
});

it('shows the verified 12–14 lunch interval from the supporting calculation', () => {
  const picked = fact({ key: 'tradeArea.hour.12' });
  const rows = selectVerifiedEvidence([widget('trade-area', [picked])],
    [{ fact: picked, timeRange: { start: '12:00', end: '14:00' } }], ko);
  expect(rows[0]?.periodLabel).toBe('11월 17일 · 12~14시');
  expect(rows[0]?.destination && validateAgentDetailRef(rows[0].destination)).toBe(true);
});

it('shows plain source text for source-only data and widgets with a compose-only entry', () => {
  const demand = fact({ key: 'demand.expected.total', source: '손님 예측 자료' });
  const coupon = fact({ key: 'slotCoupon.candidate.count' });
  const read: AgentReadEvidence = { tool: 'get_source', args: { sourceId: 'demand', condition: { kind: 'default' } }, status: 'ready', facts: [demand] };
  expect(selectVerifiedEvidence([read, widget('slot-coupon', [coupon])], [{ fact: demand }, { fact: coupon }], ko)).toEqual([
    { source: '손님 예측 자료', periodLabel: '11월 17일' },
    { source: '빈 시간 단골 쿠폰', periodLabel: '11월 17일' },
  ]);
});

it('shares the localized title with the named hand-off for a safe evidence view', () => {
  const en = navisTranslator('en');
  const picked = fact({ key: 'ledger.evidence.missing' });
  const [row] = selectVerifiedEvidence([widget('ledger', [picked])], [{ fact: picked }], en);
  expect(row).toEqual({
    source: en.t('widget.ledger.title'), openLabel: `${en.t('widget.ledger.title')} 열기`, periodLabel: '11월 17일',
    destination: { featureId: 'ledger', view: 'evidence' },
  });
  expect(validateAgentDetailRef(row.destination)).toBe(true);
});

it('omits evidence lacking a verified date, period or as-of', () => {
  const picked = fact({ date: undefined });
  expect(selectVerifiedEvidence([widget('ledger', [picked])], [{ fact: picked }], ko)).toEqual([]);
});
