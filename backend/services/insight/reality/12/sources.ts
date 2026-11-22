import { dayPeriod, type BriefingContext, type Period, type Readers, type SourceData } from './briefing.ts';

type Service = 'customer' | 'inventory' | 'pos' | 'marketing';
type Endpoint = { url: string; token: string };
type RecordSources = Partial<Record<Service, Endpoint>>;
type Read = (ctx: BriefingContext, path: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;
const readTimeoutMs = 2_500;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid briefing projection');
  return value as Record<string, unknown>;
}

function select(value: unknown, fields: readonly string[]) {
  const input = record(value);
  return Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
}

function selectNullable(value: unknown, fields: readonly string[]) {
  return value == null ? null : select(value, fields);
}

function metadata(value: Record<string, unknown>) {
  const { asOf, sourceRevision } = value;
  return {
    ...(typeof asOf === 'string' && { asOf }),
    ...((typeof sourceRevision === 'string' || typeof sourceRevision === 'number') && { sourceRevision }),
  };
}

function collection(result: Record<string, unknown>) {
  if (!Array.isArray(result.items)) throw new Error('Invalid briefing collection');
  return { items: result.items as unknown[], cursor: typeof result.nextCursor === 'string' ? result.nextCursor : null };
}

function list(read: Read, path: (ctx: BriefingContext) => string,
  fields: readonly string[], dated = true): (ctx: BriefingContext) => Promise<SourceData> {
  return async ctx => {
    const result = await read(ctx, path(ctx));
    const { items, cursor } = collection(result);
    return { ...metadata(result), period: dated ? dayPeriod(ctx) : null,
      partial: cursor !== null, data: items.map(item => select(item, fields)) };
  };
}

const dateAt = (date: Date, offset: number) => new Date(+date + offset * 86_400_000).toISOString().slice(0, 10);

function localWeek({ now, timezone }: BriefingContext): Period {
  const day = new Date(new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now));
  const daysSinceMonday = (day.getUTCDay() + 6) % 7;
  return { from: dateAt(day, -daysSinceMonday), to: dateAt(day, 6 - daysSinceMonday) };
}

const visitStatuses = ['needs-check', 'confirmed', 'proposed', 'canceled', 'completed', 'no-show'];

async function readPages(read: Read, ctx: BriefingContext, path: string, query: URLSearchParams) {
  const signal = AbortSignal.timeout(readTimeoutMs);
  const first = await read(ctx, `${path}?${query}`, signal);
  const firstPage = collection(first);
  const items = [...firstPage.items];
  const seen = new Set<string>();
  let cursor = firstPage.cursor;
  for (let page = 1; cursor && page < 3 && !seen.has(cursor); page++) {
    seen.add(cursor);
    query.set('cursor', cursor);
    const response = await read(ctx, `${path}?${query}`, signal);
    if (response.sourceRevision !== first.sourceRevision) break;
    const next = collection(response);
    items.push(...next.items);
    cursor = next.cursor;
  }
  return { ...metadata(first), items, partial: cursor !== null };
}

function reservation(value: unknown) {
  const { reservationId, date, time, status, partySize, revision } = record(value);
  if (typeof reservationId !== 'string' || typeof date !== 'string' || typeof time !== 'string' ||
      typeof status !== 'string' || !visitStatuses.includes(status) ||
      (partySize !== null && (typeof partySize !== 'number' || !Number.isSafeInteger(partySize) || partySize < 1)) ||
      typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw new Error('Invalid briefing reservation');
  return { reservationId, date, time, status, partySize, revision };
}

async function reservations(read: Read, ctx: BriefingContext): Promise<SourceData> {
  const { businessDay } = ctx;
  const period = { from: businessDay, to: dateAt(new Date(businessDay), 1) };
  // Keep every visit state so the same records can drive bookings, completions and cancellations.
  const query = new URLSearchParams({ source: 'local', startDate: period.from, endDate: period.to, limit: '100' });
  const { items, ...coverage } = await readPages(read, ctx, '/reservations', query);
  return { ...coverage, period, data: items.map(reservation) };
}

function count(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid briefing count');
  return value;
}

async function localChanges(read: Read, ctx: BriefingContext): Promise<SourceData> {
  const period = localWeek(ctx);
  const response = await read(ctx, `/local-changes?${new URLSearchParams({ ...period, limit: '100' })}`);
  const reported = record(response.period);
  if (reported.from !== period.from || reported.to !== period.to) throw new Error('Invalid Local Changes period');
  const { items, cursor } = collection(response);
  return { ...metadata(response), period, partial: cursor !== null, data: {
    unreadCount: count(response.unreadCount),
    coverage: selectNullable(response.coverage, ['region', 'referenceDate', 'kinds']),
    items: items.map(row => select(row, ['id', 'revision', 'kind', 'title', 'region', 'authority', 'sourceUrl',
      'dateKind', 'referenceDate', 'acknowledgedAt', 'updatedAt'])),
  } };
}

async function noticeReplyPage(read: Read, ctx: BriefingContext, path: '/inquiries' | '/notices',
  project: (row: Record<string, unknown>) => Record<string, unknown>): Promise<SourceData> {
  const response = await read(ctx, `${path}?limit=100`);
  const { items, cursor } = collection(response);
  return { ...metadata(response), period: null, partial: cursor !== null,
    data: { waitingCount: count(response.waitingCount), items: items.map(row => project(record(row))) } };
}

const taxFields = ['taxPaymentId', 'type', 'amount', 'dueOn', 'paidOn', 'status', 'overdue', 'revision', 'evidence'];

async function taxPayments(read: Read, ctx: BriefingContext): Promise<SourceData> {
  const response = await read(ctx, '/tax-payments?limit=50');
  if (response.today !== ctx.businessDay) throw new Error('Invalid tax business day');
  const { items, cursor } = collection(response);
  const summary = record(response.summary);
  return { ...metadata(response), period: null, partial: cursor !== null, data: {
    items: items.map(row => select(row, taxFields)),
    next: selectNullable(response.next, taxFields),
    summary: {
      ...select(summary, ['unpaidCount', 'unpaidTotal', 'overdueCount', 'withEvidenceCount']),
      dueSoonCount: count(summary.dueSoonCount), paidCount: count(summary.paidCount),
    },
  } };
}

const reportDates = ['startDate', 'endDate'];

async function channelReports(read: Read, ctx: BriefingContext): Promise<SourceData> {
  // Marketing owns the official-source and metric allowlists, and bounds its provider reads to 5 seconds.
  const response = await read(ctx, '/channel-reports', AbortSignal.timeout(6_000));
  if (response.businessDate !== ctx.businessDay) throw new Error('Invalid channel business day');
  const { items } = collection(response);
  const channels = items.map(row => {
    const item = record(row);
    if ((item.state !== 'ready' && item.state !== 'unavailable') || !Array.isArray(item.cards)) {
      throw new Error('Invalid channel report');
    }
    return {
      ...select(item, ['channel', 'source']), state: item.state,
      period: selectNullable(item.period, reportDates),
      cards: item.cards.map(value => {
        const card = record(value);
        return { ...select(card, ['metric', 'value', 'changeRate']),
          ...(card.period !== undefined && { period: select(card.period, reportDates) }) };
      }),
    };
  });
  if (!channels.some(item => item.state === 'ready')) throw new Error('No channel reports available');
  return { ...metadata(response), period: null, partial: channels.some(item => item.state === 'unavailable'),
    data: { items: channels } };
}

const actionParams = {
  'quiet-hours': ['regulars'], expiry: ['count', 'itemName'], replies: ['count', 'drafted'], video: ['photos'],
} as const;

function actionCell(value: unknown) {
  const cell = record(value);
  const kind = cell.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(actionParams, kind)) throw new Error('Invalid marketing action');
  return {
    ...select(cell, ['slot', 'kind', 'sourceFeatureId']),
    params: select(cell.params, actionParams[kind as keyof typeof actionParams]),
    ref: select(cell.ref, ['featureId', 'view', 'itemId', 'focus']),
    ...(kind === 'quiet-hours' && {
      quietSlot: select(cell.quietSlot, ['slotId', 'date', 'weekday', 'startHour', 'endHour']),
    }),
  };
}

async function marketingToday(read: Read, ctx: BriefingContext): Promise<SourceData> {
  const response = await read(ctx, '/recommendations');
  if (response.businessDate !== ctx.businessDay || !Array.isArray(response.cells) ||
      !Array.isArray(response.missing) || !Array.isArray(response.folded) ||
      !['ready', 'empty', 'partial'].includes(String(response.state))) throw new Error('Invalid marketing recommendations');
  return { ...metadata(response), period: dayPeriod(ctx), partial: response.state === 'partial', data: {
    cells: response.cells.map(actionCell),
    missing: response.missing.filter(source => ['coupons', 'replies', 'assets'].includes(source)),
    folded: response.folded.filter(slot => ['now', 'today', 'week'].includes(slot)),
    tapTarget: selectNullable(response.tapTarget, ['featureId', 'view']),
  } };
}

async function activeCoupons(read: Read, ctx: BriefingContext): Promise<SourceData> {
  const response = await read(ctx, '/coupons?status=active&limit=100');
  if (response.businessDate !== ctx.businessDay) throw new Error('Invalid coupon business day');
  const { items, cursor } = collection(response);
  return { ...metadata(response), period: null, partial: cursor !== null,
    data: items.map(row => select(row, ['couponId', 'origin', 'name', 'startsOn', 'endsOn', 'status', 'daysLeft',
      'endingSoon', 'revision'])) };
}

export function recordSources(endpoints: RecordSources, fetcher: typeof fetch = fetch): Readers {
  function reader(service: Service, endpoint: Endpoint): Read {
    const base = new URL(endpoint.url);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('Invalid briefing service URL');
    return async ({ storeId, actorId, timezone, businessDayStart }, path, signal = AbortSignal.timeout(readTimeoutMs)) => {
      const response = await fetcher(new URL(`/internal/v1/${service}/stores/${storeId}${path}`, base), {
        method: 'GET', redirect: 'error', signal,
        headers: { authorization: `Bearer ${endpoint.token}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
          'x-navis-store-role': 'owner', 'x-navis-store-timezone': timezone, 'x-navis-business-day-start': businessDayStart },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Briefing source unavailable');
      }
      return record(await response.json());
    };
  }

  const result: Readers = {};
  const calendarPeriod = ({ businessDay }: BriefingContext) => `startDate=${businessDay}&endDate=${businessDay}&limit=100`;
  const posPeriod = ({ businessDay }: BriefingContext) => `from=${businessDay}&to=${businessDay}`;
  if (endpoints.customer) {
    const read = reader('customer', endpoints.customer);
    result.calendar = list(read, ctx => `/calendar/events?${calendarPeriod(ctx)}`,
      ['eventId', 'date', 'time', 'kind', 'title', 'storeClosure', 'revision']);
    result.shifts = list(read, ctx => `/shifts?${calendarPeriod(ctx)}`,
      ['scheduleId', 'staffId', 'date', 'start', 'end', 'kind', 'revision']);
    result.calendarProjections = list(read, ctx => `/calendar/projections?${calendarPeriod(ctx)}`,
      ['sourceId', 'source', 'date', 'endDate', 'time', 'title', 'sourceRevision']);
    result.reservations = ctx => reservations(read, ctx);
  }
  if (endpoints.inventory) {
    const read = reader('inventory', endpoints.inventory);
    result.stock = list(read, () => '/stock-batches?limit=100',
      ['batchId', 'itemId', 'expiresOn', 'remainingQuantityBase', 'discardedAt', 'revision'], false);
    result.purchasing = async ctx => {
      const { items, ...coverage } = await readPages(read, ctx, '/purchase-orders', new URLSearchParams({ limit: '100' }));
      return { ...coverage, period: null,
        data: items.map(item => {
          const order = record(item);
          if (!Array.isArray(order.lines)) throw new Error('Invalid purchase lines');
          return { ...select(order, ['poId', 'dueDate', 'expectedTime', 'status', 'revision']),
            lines: order.lines.map(line => select(line, ['polId', 'itemId', 'qtyOrdered', 'received', 'remaining', 'unitSnapshot'])) };
        }) };
    };
  }
  if (endpoints.pos) {
    const read = reader('pos', endpoints.pos);
    result.tax = ctx => taxPayments(read, ctx);
    result.pickups = list(read, ctx => `/custom-pickups?${posPeriod(ctx)}&limit=50`,
      ['reservationId', 'customOrderId', 'date', 'time', 'status', 'revision']);
    result.closing = async ctx => {
      const value = await read(ctx, `/closings/${ctx.businessDay}`);
      if (value.businessDate !== ctx.businessDay || typeof value.status !== 'string') throw new Error('Invalid POS closing');
      return { ...metadata(value), period: dayPeriod(ctx), data: { ...select(value, ['businessDate', 'status', 'closingId', 'closedAt', 'revision']),
        pendingBillCount: Array.isArray(value.pendingBills) ? value.pendingBills.length : null } };
    };
    result.finance = async ctx => {
      const value = await read(ctx, `/ledger?${posPeriod(ctx)}`);
      const totals = record(value.totals);
      const sales = record(totals.sales);
      if (value.from !== ctx.businessDay || value.to !== ctx.businessDay || !Number.isSafeInteger(sales.total)) {
        throw new Error('Invalid POS ledger');
      }
      return { ...metadata(value), period: dayPeriod(ctx), data: {
        ...select(totals, ['expenses', 'knownCost', 'unknownCostCount', 'profit', 'orderCount', 'realPaymentCount']),
        netSales: sales.total, deposits: record(totals.deposits).total,
      } };
    };
  }
  if (endpoints.marketing) {
    const read = reader('marketing', endpoints.marketing);
    result.channels = ctx => channelReports(read, ctx);
    result.marketingToday = ctx => marketingToday(read, ctx);
    result.coupons = ctx => activeCoupons(read, ctx);
    result.local = ctx => localChanges(read, ctx);
    result.reviews = ctx => noticeReplyPage(read, ctx, '/inquiries', row => ({
      ...select(row, ['id', 'revision', 'type', 'source', 'status', 'updatedAt']),
      draft: selectNullable(row.draft, ['source']), reply: selectNullable(row.reply, ['state']),
    }));
    result.notices = ctx => noticeReplyPage(read, ctx, '/notices', row => ({
      ...select(row, ['id', 'revision', 'status', 'channel', 'startDate', 'endDate', 'updatedAt']),
      closure: selectNullable(row.closure, ['eventId', 'revision']), result: selectNullable(row.result, ['state']),
    }));
  }
  return result;
}

type Persona = {
  smartCallSummary?: (storeId: string, period: { startDate: string; endDate: string }) => Promise<{
    period: { startDate: string; endDate: string }; daily: unknown; channels: unknown;
  }>;
  reviewStatistics?: (storeId: string, filter: { period: 'week'; to: string }) => Promise<{
    period: { from: string; to: string; unit: string }; themes: unknown; topKeywords: unknown;
  }>;
};

// Only bind the private FAKE Persona adapter in composition.
export function personaSources({ smartCallSummary, reviewStatistics }: Persona): Readers {
  const readers: Readers = {};
  if (smartCallSummary) readers.smartCall = async ({ storeId, businessDay }) => {
    const { period, daily, channels } = await smartCallSummary(storeId, { startDate: businessDay, endDate: businessDay });
    return { period: { from: period.startDate, to: period.endDate }, data: { daily, channels } };
  };
  if (reviewStatistics) readers.reviewStatistics = async ({ storeId, businessDay }) => {
    const { period, themes, topKeywords } = await reviewStatistics(storeId, { period: 'week', to: businessDay });
    return { period: { from: period.from, to: period.to }, data: { unit: period.unit, themes, topKeywords } };
  };
  return readers;
}
