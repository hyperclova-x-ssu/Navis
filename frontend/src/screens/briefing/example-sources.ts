/**
 * PAR-1 (D-384): the "sources and basis" card of the briefing with the example data. Over HTTP the briefing service names each source with its origin,
 * state and period; the example day has every source connected, with the periods the service uses (a day, the next day, the last seven days, the
 * statistics of the two days before, or the current state).
 */
import { NOW, TODAY, addDays } from '../../data/db/time';
import { kstOffset } from '../../data/reality/02/clock';
import { SOURCE_NAMES, type BriefingPeriodDto, type BriefingSource } from '../../data/reality/12/dto';

type Spec = { readonly origin: string; readonly period: 'day' | 'range' | 'current' | 'week' | 'stats' };
const SPECS: Readonly<Record<typeof SOURCE_NAMES[number], Spec>> = {
  sales: { origin: 'pos', period: 'day' }, finance: { origin: 'pos', period: 'day' }, closing: { origin: 'pos', period: 'day' },
  calendar: { origin: 'customer', period: 'day' }, shifts: { origin: 'customer', period: 'day' }, calendarProjections: { origin: 'customer', period: 'day' },
  stock: { origin: 'inventory', period: 'current' }, purchasing: { origin: 'inventory', period: 'current' }, pickups: { origin: 'pos', period: 'day' },
  reservations: { origin: 'customer', period: 'range' }, environment: { origin: 'insight', period: 'current' }, cctv: { origin: 'insight', period: 'current' },
  manualsGrants: { origin: 'insight', period: 'day' }, smartCall: { origin: 'naver-smartcall', period: 'day' }, reviewStatistics: { origin: 'naver-smartplace', period: 'stats' },
  local: { origin: 'marketing', period: 'week' }, reviews: { origin: 'marketing', period: 'current' }, notices: { origin: 'marketing', period: 'current' },
  tax: { origin: 'pos', period: 'current' }, channels: { origin: 'marketing', period: 'current' }, marketingToday: { origin: 'marketing', period: 'day' }, coupons: { origin: 'marketing', period: 'current' },
};

function periodOf(kind: Spec['period']): BriefingPeriodDto | null {
  if (kind === 'current') return null;
  if (kind === 'day') return { from: TODAY, to: TODAY };
  if (kind === 'range') return { from: TODAY, to: addDays(TODAY, 1) };
  if (kind === 'week') return { from: addDays(TODAY, -6), to: TODAY };
  return { from: addDays(TODAY, -8), to: addDays(TODAY, -2) };
}

/** One source per name the service sends, all connected, in the service's order. */
export function exampleBriefingSources(): readonly BriefingSource[] {
  return SOURCE_NAMES.map(key => {
    const spec = SPECS[key];
    const provider = spec.origin.startsWith('naver');
    return { key, origin: spec.origin, provider, state: 'ready', period: periodOf(spec.period), asOf: provider ? null : new Date(kstOffset(NOW)).toISOString(), sourceRevision: null, data: null } satisfies BriefingSource;
  });
}
