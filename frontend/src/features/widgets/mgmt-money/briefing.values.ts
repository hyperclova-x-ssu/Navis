/**
 * D-386 (gate T-02): the value rows the briefing was missing, in its own row style. Every value is read where its source widget reads it: the widget's own
 * view (재고, 매장 환경, CCTV, 정부지원), the booking domain's SmartCall aggregates, the Insight review AI statistics and the channel reports. Over HTTP
 * those are the services' figures; with the example data they come from `screens/briefing/example-values.ts`, which the source widgets share.
 * A source the service has not connected or could not read shows its state, never a zero.
 */
import { useDomainState, useRealPort, useWidgetView } from '../../../data/react';
import type { DataSnapshot } from '../../../data/db/types';
import { useReviewInsights } from '../../../data/reality/15/hooks';
import { exampleCallDays, exampleReviewStatistics } from '../../../screens/briefing/example-values';
import type { T } from './shared';

export type ValueTarget = { readonly featureId: 'inventory-booking' | 'store-environment' | 'customer-analysis' | 'grants' | 'voice-booking' | 'ai-response'; readonly view?: 'stats' };
export interface ValueRow {
  readonly id: string;
  readonly label: string;
  readonly target: ValueTarget;
  readonly trailing: { readonly kind: 'value' | 'chip'; readonly text: string; readonly semantic?: 'waiting' | 'warning' };
}

export function useBriefingValues(t: T, snapshot: DataSnapshot): readonly ValueRow[] {
  const stock = useWidgetView('inventory-booking'), environment = useWidgetView('store-environment'), cctv = useWidgetView('customer-analysis'), grants = useWidgetView('grants');
  const booking = useDomainState('booking'), inbox = useDomainState('inbox');
  const port = useRealPort();
  const reviews = useReviewInsights(port && inbox.mode === 'http' ? 'week' : null);
  const value = (text: string): ValueRow['trailing'] => ({ kind: 'value', text });
  const state = (key: 'not-connected' | 'unavailable'): ValueRow['trailing'] => ({ kind: 'chip', semantic: 'waiting', text: t(`briefing.state.${key}`) });
  const count = (n: number) => t('briefing.values.count', { n });
  const rows: ValueRow[] = [];

  rows.push({ id: 'stock', label: t('widget.briefing.stock'), target: { featureId: 'inventory-booking' },
    trailing: stock.status === 'ready' ? value(t('widget.briefing.itemsCount', { n: stock.model.restockCount })) : { kind: 'chip', semantic: 'waiting', text: t(stock.messageKey) } });
  const reading = environment.status === 'ready' ? environment.model.current : null;
  rows.push({ id: 'environment', label: t('widget.store-environment.title'), target: { featureId: 'store-environment' },
    trailing: reading ? value(t('briefing.values.environment', { temperature: t.format.number(reading.temperatureC), humidity: t.format.number(reading.humidityPct) }))
      : { kind: 'chip', semantic: 'waiting', text: t(environment.status === 'ready' ? environment.model.messageKey ?? 'data.state.store-environment.empty' : environment.messageKey) } });
  rows.push({ id: 'cctv', label: t('widget.customer-analysis.title'), target: { featureId: 'customer-analysis' },
    trailing: cctv.status === 'ready' ? value(t('briefing.values.visits', { n: cctv.model.totalVisits })) : { kind: 'chip', semantic: 'waiting', text: t(cctv.messageKey) } });
  rows.push({ id: 'grants', label: t('widget.grants.reviewCandidates'), target: { featureId: 'grants' },
    trailing: grants.status === 'ready' ? value(count(grants.model.candidateCount)) : { kind: 'chip', semantic: 'waiting', text: t(grants.messageKey) } });

  const book = snapshot.tables.realBooking;
  const calls = booking.mode === 'http' ? (book?.callPeriod ? book.calls : null) : exampleCallDays();
  rows.push({ id: 'smartCall', label: t('briefing.source.smartCall'), target: { featureId: 'voice-booking' },
    trailing: calls ? value(count(calls.reduce((total, day) => total + day.totalCalls, 0))) : state(booking.mode === 'http' && book ? 'unavailable' : 'not-connected') });

  const statistics = inbox.mode === 'http' ? reviews.data?.statistics : exampleReviewStatistics();
  if (statistics || inbox.mode !== 'http') {
    rows.push({ id: 'reviews', label: t('briefing.source.reviewStatistics'), target: { featureId: 'ai-response', view: 'stats' },
      trailing: statistics?.state === 'ready'
        ? value(t('briefing.values.reviews', { p: statistics.themes.reduce((total, row) => total + row.positiveCount, 0), n: statistics.themes.reduce((total, row) => total + row.negativeCount, 0) }))
        : state(statistics?.state === 'unavailable' ? 'unavailable' : 'not-connected') });
  }

  return rows;
}
