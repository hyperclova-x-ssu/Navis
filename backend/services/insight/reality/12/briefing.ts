import type { OwnerScope } from '../../scope.ts';

export type BriefingContext = OwnerScope & {
  businessDay: string;
  now: Date;
  timezone: string;
  businessDayStart: string;
};

export type Period = { from: string; to: string };
export type SourceData = {
  data: unknown;
  period: Period | null;
  asOf?: string;
  sourceRevision?: string | number;
  partial?: boolean;
};

const origins = {
  sales: 'pos', closing: 'pos', calendar: 'customer', shifts: 'customer', calendarProjections: 'customer',
  stock: 'inventory', purchasing: 'inventory', reservations: 'customer', smartCall: 'naver-smartcall',
  pickups: 'pos', finance: 'pos', environment: 'insight', cctv: 'insight', manualsGrants: 'insight',
  local: 'marketing', reviewStatistics: 'naver-smartplace', reviews: 'marketing', notices: 'marketing',
  tax: 'pos', channels: 'marketing', marketingToday: 'marketing', coupons: 'marketing',
} as const;

export type Source = keyof typeof origins;
export type Readers = Partial<Record<Source, (ctx: BriefingContext) => Promise<SourceData>>>;
export type SourceResult = Omit<SourceData, 'partial'> & {
  state: 'ready' | 'partial' | 'not-connected' | 'unavailable';
  origin: typeof origins[Source];
};

export async function readSources(ctx: BriefingContext, readers: Readers): Promise<Record<Source, SourceResult>> {
  const sources = Object.keys(origins) as Source[];
  const entries = await Promise.all(sources.map(async source => {
    const origin = origins[source];
    const reader = readers[source];
    if (!reader) return [source, { origin, state: 'not-connected', data: null, period: null }] as const;
    try {
      const { partial, ...value } = await reader(ctx);
      return [source, { ...value, origin, state: partial ? 'partial' : 'ready' }] as const;
    } catch {
      return [source, { origin, state: 'unavailable', data: null, period: null }] as const;
    }
  }));
  return Object.fromEntries(entries) as Record<Source, SourceResult>;
}

export const dayPeriod = ({ businessDay }: BriefingContext): Period => ({ from: businessDay, to: businessDay });

// Openings are Sunday through Saturday. Work on the local wall clock so the
// date label is correct even when the arrival window starts before midnight.
export function arrivalDay(ctx: BriefingContext, openings: readonly string[] | undefined) {
  if (openings?.length !== 7 || openings.some(time => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return null;
  const local = new Intl.DateTimeFormat('sv-SE', { timeZone: ctx.timezone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ctx.now);
  const midnight = Date.parse(local.slice(0, 10));
  const [hour, minute] = local.slice(11).split(':').map(Number);
  const currentMinute = midnight / 60_000 + hour! * 60 + minute!;
  for (const offset of [1, 0, -1]) {
    const date = new Date(midnight + offset * 86_400_000);
    const [openHour, openMinute] = openings[date.getUTCDay()]!.split(':').map(Number);
    if (currentMinute >= +date / 60_000 + openHour! * 60 + openMinute! - 120) return date.toISOString().slice(0, 10);
  }
  return null;
}
