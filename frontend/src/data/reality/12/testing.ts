/** F12 test helper: an in-memory B12 behind the port's fake transport. Not shipped in the app bundle. */
import { createWidgetDataStore } from '../../db/store';
import { TODAY } from '../../db/time';
import { createRealPort } from '../00';
import { fakeBackend } from '../00/testing';
import { briefingAdapter } from './adapter';
export { ackKey } from './ack';
import type { BriefingAcknowledgementDto, BriefingSourceDto } from './dto';

export const briefingDay = TODAY;
const asOf = `${TODAY}T06:00:00Z`;

export interface BriefingBackendState {
  arrivalDay: string | null;
  acknowledgement: BriefingAcknowledgementDto | null;
  sources: Record<string, BriefingSourceDto>;
  affectedSources: string[];
  /** Acknowledgement writes the service actually stored (a replayed key stores nothing). */
  acknowledgements: number;
}

const day = { from: briefingDay, to: briefingDay };
const notConnected = (origin: string): BriefingSourceDto => ({ origin, state: 'not-connected', period: null, data: null });
export const defaultSources = (): Record<string, BriefingSourceDto> => ({
  sales: { origin: 'pos', state: 'ready', period: day, data: { projectedNetSales: 831_220, hours: [] }, asOf, sourceRevision: 7 },
  finance: { origin: 'pos', state: 'ready', period: day, data: { netSales: 831_220, deposits: 831_220, expenses: 0, knownCost: 0, unknownCostCount: 0, profit: 831_220, orderCount: 12, realPaymentCount: 12 }, asOf, sourceRevision: 8 },
  closing: { origin: 'pos', state: 'ready', period: day, data: { businessDate: briefingDay, status: 'open', closingId: null, closedAt: null, revision: 0, pendingBillCount: 0 }, asOf },
  calendar: { origin: 'customer', state: 'ready', period: day, data: [], asOf, sourceRevision: 3 },
  shifts: { origin: 'customer', state: 'ready', period: day, data: [], asOf, sourceRevision: 4 },
  calendarProjections: { origin: 'customer', state: 'ready', period: day, data: [], asOf },
  stock: { origin: 'inventory', state: 'ready', period: null, data: [], asOf },
  purchasing: { origin: 'inventory', state: 'partial', period: null, data: [], asOf },
  pickups: { origin: 'pos', state: 'ready', period: day, data: [], asOf },
  reservations: notConnected('customer'),
  environment: { origin: 'insight', state: 'ready', period: null, data: { current: null, limits: {}, alerts: [] }, asOf, sourceRevision: 2 },
  cctv: { origin: 'insight', state: 'unavailable', period: null, data: null },
  manualsGrants: { origin: 'insight', state: 'ready', period: day, data: { openingChecked: 1, openingSteps: 4, upcomingGrantDeadlines: 2 }, asOf, sourceRevision: '5' },
  smartCall: { origin: 'naver-smartcall', state: 'ready', period: { from: '2026-11-10', to: '2026-11-16' }, data: { daily: [], channels: [] } },
  reviewStatistics: { origin: 'naver-smartplace', state: 'ready', period: { from: '2026-11-10', to: '2026-11-16' }, data: { unit: 'week', themes: [], topKeywords: [] } },
  local: notConnected('marketing'), reviews: notConnected('marketing'), notices: notConnected('marketing'), tax: notConnected('pos'), channels: notConnected('marketing'),
});

export function briefingBody(state: BriefingBackendState) {
  return { businessDay: briefingDay, arrivalDay: state.arrivalDay, asOf, acknowledgement: state.acknowledgement, sources: state.sources };
}

export function briefingSession(options: { readonly source?: 'http' | 'fixture' } = {}) {
  const backend = fakeBackend();
  const state: BriefingBackendState = {
    arrivalDay: briefingDay, acknowledgement: null, sources: defaultSources(), affectedSources: ['briefing'], acknowledgements: 0,
  };
  const keys = new Map<string, unknown>();
  backend.on('GET', '/insight/briefings', () => briefingBody(state));
  backend.on('POST', /^\/insight\/briefings\/[^/]+\/ack$/, call => {
    const key = call.headers.get('idempotency-key') ?? '';
    const stored = keys.get(key);
    if (stored) return stored;
    state.acknowledgements += 1;
    state.acknowledgement ??= { acknowledgedAt: `${TODAY}T08:15:00Z`, receiptId: `ack-receipt-${state.acknowledgements}` };
    const receipt = { resourceId: briefingDay, revision: state.acknowledgements, receiptId: state.acknowledgement.receiptId, affectedSources: state.affectedSources,
      businessDay: briefingDay, acknowledgedAt: state.acknowledgement.acknowledgedAt };
    keys.set(key, receipt);
    return receipt;
  });
  const open = () => {
    const store = createWidgetDataStore();
    const port = createRealPort({ store, fetch: backend.fetch, source: () => options.source ?? 'http', adapters: [briefingAdapter], sleep: async () => {}, reconcileDelaysMs: [0] });
    store.bindReal(port);
    return { store, port };
  };
  return { ...open(), open, backend, state };
}
