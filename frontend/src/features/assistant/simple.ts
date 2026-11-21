/**
 * Simple mode (fallback without the bridge): understands core words of all four languages whatever
 * the setting is, and answers in the setting's language from the same facts the bridge would get
 * (API-10 v4/v4.1, AC-321). The rules point at widget ids only; names and values come from the
 * registry and the fact source, so a widget without facts yet simply answers "no data".
 */
import { getRegistration } from '../../catalog';
import type { CellSpan, DashboardLayerId, FeatureId, Locale, QueryCondition } from '../../contracts';
import { TOMORROW } from '../../data/widget-data';
import { inventoryIngredientKey } from './inventory-ingredients';
import { normalizeNavisName } from './navis-input';
import { navisTranslator } from './messages';
import { conditionsOf, localizeFact, type SnapshotFact, type WidgetFactSource } from './snapshot';
import type { AssistantReply, Candidate } from './types';

import { norm, has, matchWidget, isPosQuestion, CUSTOMERS, TOMORROW_WORDS, EVENT_WORDS, PAST_WORDS, WEEK_WORDS, STOCK_MERGED_WORDS, REMOVED_WORDS } from './question';
export { norm, matchWidget, isPosQuestion } from './question';

const size = (width: number, height: number) => ({ width: width as CellSpan, height: height as CellSpan });

function pickFacts(id: FeatureId, facts: readonly SnapshotFact[]): readonly SnapshotFact[] {
  if (id === 'credit-receivable') return facts.filter(f => f.key.startsWith('account.charge.') || f.key.startsWith('account.receivable.'));
  if (id === 'custom-order') return facts.filter(f => ['custom.active.count', 'custom.approvalPending.count', 'pickup.today.count'].includes(f.key));
  if (id === 'notice-send') return facts.filter(f => ['notice.unsentClosure.count', 'notice.sent.count', 'notice.nextClosure.date'].includes(f.key));
  if (id === 'ledger') {
    const totals = facts.filter(f => f.key === 'ledger.sales.net' || f.key === 'accounting.deposits.total');
    if (totals.length) return totals;
  }
  const numeric = facts.filter((f) => typeof f.value === 'number').slice(0, 2);
  return numeric.length ? numeric : facts.slice(0, 1);
}

export function simpleReply(input: { readonly text: string; readonly locale: Locale; readonly layer: DashboardLayerId; readonly source: WidgetFactSource }): AssistantReply {
  const { text, locale, layer, source } = input;
  const tr = navisTranslator(locale);
  const key = norm(text);
  const base = { mode: 'simple' as const, locale };
  const noData = (): AssistantReply => ({ ...base, answer: tr.t('common.navis.noData'), panels: [] });
  if (has(key, REMOVED_WORDS)) return { ...base, answer: tr.t('navis.simple.removed'), panels: [] };
  if (has(key, CUSTOMERS) && has(key, TOMORROW_WORDS)) {
    const facts = (source.readSource?.('demand') ?? []).filter((f) => f.date === TOMORROW && (f.key === 'demand.expected.total' || f.key === 'demand.expected.band'));
    if (!facts.length) return noData();
    return { ...base, answer: tr.t('navis.simple.demand', { facts: facts.map((f) => localizeFact(f, locale).display).join(', ') }), panels: [] };
  }
  if (isPosQuestion(text)) {
    const facts = source.readSource?.('pos') ?? [];
    const value = (key: string) => facts.find(f => f.key === key)?.value;
    const count = value('orders.missing.count'), open = value('orders.open.count');
    if (typeof count !== 'number' || typeof open !== 'number') return noData();
    const missing = count > 0 ? tr.t('data.pos.navisMissing', { count, no: value('orders.missing.no') ?? '', time: value('orders.missing.orderedAt') ?? '', item: value('orders.missing.content') ?? '', n: value('orders.missing.elapsed.minutes') ?? '', open }) : tr.t('data.pos.navisNone', { open });
    return { ...base, answer: `${missing} ${tr.t('data.pos.navisLocation')}`, panels: [] };
  }
  const id = matchWidget(text);
  if (!id || !getRegistration(id)) {
    return { ...base, answer: tr.t('navis.simple.unknown'), panels: [], examples: [1, 2, 5].map((n) => tr.t(`navis.example.${n}`)) };
  }
  if (has(key, PAST_WORDS) || /\d{4}[-./]\d/u.test(key) || (id === 'customer-analysis' && has(key, EVENT_WORDS))) return noData();
  const registration = getRegistration(id)!;
  let condition: QueryCondition = conditionsOf(id)[0];
  if (id === 'ledger' && has(key, WEEK_WORDS)) condition = conditionsOf(id).find((c) => c.kind === 'dateRange') ?? condition;
  const view = source.view(id, condition);
  const facts = view.status === 'ready' ? source.facts(view) : [];
  if (!facts.length) return noData();
  const name = tr.t(registration.nameKey);
  const milk = id === 'inventory-booking' && has(key, ['우유', 'milk']) && has(key, ['사용', '썼', '쓴', 'used']);
  const selected = milk ? facts.filter((f) => f.key === 'inventory.usedToday' && inventoryIngredientKey(f.labelText) === 'data.item.milk') : facts;
  if (!selected.length) return noData();
  const localized = selected.map((f) => localizeFact(f, locale));
  const specific = id === 'members' && has(key, ['단골']) ? localized.filter((f) => f.key === 'members.regular.count') : id === 'menu' ? selected.filter((f) => (f.key === 'menu.cost' || f.key === 'menu.marginRate') && normalizeNavisName(localizeFact(f, 'ko').label) === '카페라테').map((f) => localizeFact(f, locale)) : id === 'tax' ? localized.filter((f) => f.key === 'tax.payment') : [];
  if ((id === 'menu' || (id === 'members' && has(key, ['단골']))) && !specific.length) return noData();
  const shown = milk ? localized : specific.length ? specific : pickFacts(id, localized);
  const joined = shown.map((f) => f.key === 'tax.payment' && f.date ? tr.t('navis.simple.taxDue', { name: f.label, amount: f.display, date: tr.format.date(f.date, 'monthDay') }) : `${f.label} ${f.display}`).join(locale === 'ko' || locale === 'en' ? ', ' : '，');
  const merged = id === 'inventory-booking' && has(key, STOCK_MERGED_WORDS) ? `${locale==='ko'?'. ':' '}${tr.t('navis.simple.stockMerged', { name })}` : '';
  const panel: Candidate = {
    featureId: id, condition, size: id === 'staff-schedule' || id === 'custom-order' ? size(3, 2) : id === 'store-environment' || id === 'notice-send' || id === 'credit-receivable' ? size(2, 2) : id === 'ledger' && condition.kind === 'dateRange' ? size(2, 1) : size(1, 1),
    reason: tr.t('navis.simple.reason', { name }), preview: view, placement: registration.layer === layer ? 'current-layer' : 'other-layer',
  };
  const location = id === 'voice-booking' && has(key, ['예약메뉴']) ? `${locale==='ko'?'. ':' '}${tr.t('navis.simple.bookingLocation')}` : '';
  return { ...base, answer: `${tr.t('navis.simple.answer', { name, facts: joined })}${merged}${location}`, panels: [panel] };
}
