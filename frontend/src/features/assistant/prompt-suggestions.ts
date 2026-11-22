import type { FeatureId } from '../../contracts';
import type { DataSnapshot } from '../../data/widget-data';
import { navisTranslator } from './messages';
import { projectAgentWidget } from './snapshot';

export interface PromptSuggestion {
  readonly templateId: string;
  readonly readTemplate: { readonly featureId: FeatureId; readonly text: string };
  readonly dataRule: { readonly factKey: string };
  readonly count: number;
  readonly countLabel: string;
}

const templates = [
  {
    templateId: 'low-stock',
    readTemplate: { featureId: 'inventory-booking', text: '재고 부족한 품목 알려줘' },
    dataRule: { factKey: 'inventory.restock.count' },
  },
  {
    templateId: 'unanswered-reviews',
    readTemplate: { featureId: 'ai-response', text: '답변 안 한 리뷰 몇 건이야?' },
    dataRule: { factKey: 'inquiry.waiting.review' },
  },
  {
    templateId: 'missing-expense-receipts',
    readTemplate: { featureId: 'ledger', text: '오늘 증빙 없는 지출 알려줘' },
    dataRule: { factKey: 'ledger.evidence.missing' },
  },
  {
    templateId: 'today-schedule',
    readTemplate: { featureId: 'calendar', text: '오늘 일정 뭐 있어?' },
    dataRule: { factKey: 'calendar.scheduled.count' },
  },
] as const satisfies readonly Omit<PromptSuggestion, 'count' | 'countLabel'>[];

const format = navisTranslator('ko').format;

export function selectPromptSuggestions(snapshot: DataSnapshot): readonly PromptSuggestion[] {
  const rows: PromptSuggestion[] = [];
  for (const template of templates) {
    const read = projectAgentWidget(snapshot, template.readTemplate.featureId, { kind: 'default' }, 'ko');
    if (read.status !== 'ready') continue;
    const count = read.facts.find(fact => fact.key === template.dataRule.factKey)?.value;
    if (typeof count !== 'number' || !Number.isSafeInteger(count)) continue;
    const extra = template.templateId === 'today-schedule' ? read.facts.filter(fact =>
      (fact.key === 'calendar.shift.count' || fact.key === 'calendar.pickup.count') && typeof fact.value === 'number' && fact.value > 0) : [];
    if (count <= 0 && !extra.length) continue;
    const countLabel = format.count(count, 'count');
    rows.push({ ...template, count, countLabel: extra.length ? [`일정 ${countLabel}`, ...extra.map(fact => `${fact.label} ${fact.display}`)].join(' · ') : countLabel });
    if (rows.length === 4) break;
  }
  return rows;
}
