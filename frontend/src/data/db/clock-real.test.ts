import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
});

function setClock(instant: string, mode: 'fixed' | 'real', fixtureEnd?: string) {
  vi.stubEnv('VITE_NAVIS_CLOCK', mode);
  vi.stubEnv('VITE_NAVIS_FIXTURE_END_DATE', fixtureEnd);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(instant));
  vi.resetModules();
}

describe('D-346 store clock and café fixtures', () => {
  it('keeps the fixed scenario clock even when the deploy date and legacy flag are set', async () => {
    setClock('2027-01-01T00:00:00Z', 'fixed', '2027-01-01');
    vi.stubEnv('VITE_NAVIS_POS_CLOCK', 'real');
    const time = await import('./time');
    expect(time.NOW).toBe('2026-11-17T15:45');
    expect(time.TODAY).toBe('2026-11-17');
    expect(time.LAST_WEEK_SAME_DAY).toBe('2026-11-10');
  });

  it('gives POS and widget ranges the same Seoul business day before the cutoff', async () => {
    setClock('2026-12-31T19:59:00Z', 'real'); // January 1, 04:59 in Seoul.
    const time = await import('./time');
    const pos = await import('../../pos/clock');
    expect(time.TODAY).toBe('2026-12-31');
    expect(pos.POS_BUSINESS_DATE).toBe(time.TODAY);
    expect(time.NOW).toBe('2027-01-01T04:59');
    expect(time.TOMORROW).toBe('2027-01-01');
    expect(time.LAST_WEEK_SAME_DAY).toBe('2026-12-24');
  });

  it.each([
    ['2026-11-22T04:59:00+09:00', '2026-11-21', '04:59'],
    ['2026-11-22T05:00:00+09:00', '2026-11-22', '05:00'],
  ])('supports a disposable replay clock at %s', async (instant, businessDate, time) => {
    setClock('2027-01-01T00:00:00Z', 'fixed');
    vi.stubEnv('VITE_NAVIS_REPLAY_INSTANT', instant);
    const { APP_CLOCK, readAppClock } = await import('./app-clock');
    const { FIXTURE_END_DATE } = await import('./fixture-dates');
    expect(APP_CLOCK).toMatchObject({ businessDate, calendarDate: '2026-11-22', time });
    expect(readAppClock()).toEqual(APP_CLOCK);
    expect(FIXTURE_END_DATE).toBe('2026-11-22');
  });

  it('rejects conflicting replay fixture anchors', async () => {
    setClock('2027-01-01T00:00:00Z', 'real', '2026-11-21');
    vi.stubEnv('VITE_NAVIS_REPLAY_INSTANT', '2026-11-22T04:59:00+09:00');
    await expect(import('./fixture-dates')).rejects.toThrow(/conflicts/);
  });

  it('moves the fixture tables, POS seed and window with the deployment day', async () => {
    setClock('2027-01-01T06:45:00Z', 'real', '2027-01-01');
    const [{ createSeedTables, SALES_START }, { createPosSeed }, { SLOT_WINDOW }, { seedHistory }] = await Promise.all([
      import('./seed'), import('../../pos/seed'), import('../marketing/derive'), import('./cafe-fixtures'),
    ]);
    const tables = createSeedTables();
    expect(SALES_START).toBe('2026-10-04');
    expect(tables.dailySales.at(-1)?.businessDate).toBe('2027-01-01');
    expect(tables.dailySales).toHaveLength(90);
    expect(tables.reservation.filter(r => r.date === '2027-01-01').length).toBeGreaterThan(1);
    expect(tables.calendarEvent.some(r => r.date >= '2027-01-01' && r.date <= '2027-01-08')).toBe(true);
    expect(tables.demandDay.at(-1)?.targetDate).toBe('2027-01-08');
    expect(SLOT_WINDOW).toEqual({ start: '2027-01-02', end: '2027-01-08' });
    expect(seedHistory.comparison.date).toBe('2026-12-25');
    const pos = createPosSeed();
    expect(pos.businessDate).toBe('2027-01-01');
    const { seedToday } = await import('./generated/today');
    expect(pos.orders[0]?.orderId).toBe(seedToday.pos.orders[0]?.orderId);
    expect(pos.orders[0]?.orderedAt).toBe(`2027-01-01${seedToday.pos.orders[0]?.orderedAt.slice(10)}`);
  });

  it('keeps the deployed fixture anchor when the next day begins', async () => {
    setClock('2027-01-02T06:45:00Z', 'real', '2027-01-01');
    const [{ createSeedTables }, { TODAY }, { createPosSeed }] = await Promise.all([
      import('./seed'), import('./time'), import('../../pos/seed'),
    ]);
    expect(TODAY).toBe('2027-01-02');
    expect(createSeedTables().dailySales.at(-1)?.businessDate).toBe('2027-01-01');
    expect(createPosSeed().businessDate).toBe('2027-01-02');
    expect(createPosSeed().payments).toEqual([]);
  });

  it('compares appointment wall times using the civil date before opening', async () => {
    setClock('2026-12-31T19:59:00Z', 'real');
    const { slotPhase } = await import('../commands/business-clock');
    expect(slotPhase('2026-12-31', '22:00')).toBe('past');
    expect(slotPhase('2027-01-01', '04:59')).toBe('now');
    expect(slotPhase('2027-01-01', '08:00')).toBe('future');
  });
});

describe('D-373 fixture records as of the Seoul clock', () => {
  const date = '2026-11-22';
  const cutoff = `${date}T11:33:00`;

  it('uses only elapsed transactions in POS, receipts, widgets and the recent-payments answer', async () => {
    setClock(`${cutoff}+09:00`, 'real', date);
    vi.stubEnv('VITE_NAVIS_DATA_SOURCE', 'fixture');
    const [{ seedToday }, { createWidgetDataStore, deriveUsage, readModel, selectPosPayments }, { posReadForFacts },
      { selectOrderSummary }, { createAssistantProvider }] = await Promise.all([
      import('./generated/today'), import('../widget-data'), import('../facts'),
      import('../../pos/status'), import('../../features/assistant/provider'),
    ]);
    const expectedOrders = seedToday.pos.orders.filter(row => row.orderedAt.slice(11) <= '11:33:00');
    const expectedPayments = seedToday.pos.payments.filter(row => row.at.slice(11) <= '11:33:00');
    const expectedRefunds = seedToday.pos.refunds.filter(row => row.at.slice(11) <= '11:33:00');
    const expectedCancellations = seedToday.pos.cancellations.filter(row => row.at.slice(11) <= '11:33:00');
    const net = expectedPayments.reduce((sum, row) => sum + row.amount, 0)
      - [...expectedRefunds, ...expectedCancellations].reduce((sum, row) => sum + row.amount, 0);
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const pos = snapshot.pos!;
    expect(expectedPayments.length).toBeGreaterThan(0);
    expect(pos.orders.map(row => row.orderId)).toEqual(expectedOrders.map(row => row.orderId));
    expect(pos.payments.map(row => row.paymentId)).toEqual(expectedPayments.map(row => row.paymentId));
    expect(pos.receipts.map(row => row.paymentId)).toEqual(expectedPayments.map(row => row.paymentId));
    expect(pos.refunds.map(row => row.refundId)).toEqual(expectedRefunds.map(row => row.refundId));
    expect(pos.cancellations.map(row => row.cancellationId)).toEqual(expectedCancellations.map(row => row.cancellationId));
    expect(pos.orders.flatMap(row => [row.preparedAt, row.completedAt]).filter(Boolean).every(at => at! <= cutoff)).toBe(true);
    const status = selectOrderSummary(posReadForFacts(snapshot)!, { filter: 'all' });
    expect(status.counts.all).toBe(expectedOrders.length);
    expect(status.rows).toHaveLength(expectedOrders.length);
    expect(status.rows.every(row => row.orderedAt <= cutoff)).toBe(true);

    const ledger = readModel(snapshot, 'ledger');
    expect(ledger.sales.net).toBe(net);
    const payments = selectPosPayments(snapshot, { date });
    expect(payments.rows.every(row => row.time <= '11:33')).toBe(true);
    expect(payments.totals.net).toBe(net);
    expect(readModel(snapshot, 'margin').netSales).toBe(net);
    expect(readModel(snapshot, 'briefing').closing.netSales).toBe(net);
    expect(snapshot.tables.cctvHourly.filter(row => row.businessDate === date).every(row => row.hour <= 11)).toBe(true);
    expect(snapshot.tables.storeEnvironment.readings.every(row => row.measuredAt <= cutoff)).toBe(true);
    expect(snapshot.tables.receipt.every(row => row.receivedAt <= cutoff)).toBe(true);

    const quantities: Record<string, number> = {};
    for (const bill of seedToday.pos.bills) if (bill.recognizedAt && bill.recognizedAt.slice(11) <= '11:33:00') {
      for (const line of bill.settlementLines) {
        const canceled = expectedCancellations.flatMap(row => row.allocations)
          .filter(row => row.allocationId === line.allocationId).reduce((count, row) => count + row.qty, 0);
        quantities[line.menuId] = (quantities[line.menuId] ?? 0) + line.recognizedQty - canceled;
      }
    }
    expect(deriveUsage(snapshot, { date }).soldQty).toEqual(quantities);
    const fetcher = vi.fn(async () => Response.json({ code: 'UNAVAILABLE', route: 'legacy_off' }, { status: 503 }));
    const { answer } = await createAssistantProvider({ store, fetcher }).ask({ text: '최근 결제된 거 있어?', signal: new AbortController().signal });
    const times = [...answer.matchAll(/\d+번 주문 (\d\d:\d\d)/gu)].map(([, time]) => time);
    expect(times).toHaveLength(3);
    expect(times.every(time => time <= '11:33')).toBe(true);
  });

  it('reveals an order, then its payment and receipt, at their separate times', async () => {
    const { seedToday } = await import('./generated/today');
    const order = seedToday.pos.orders[0];
    const payment = seedToday.pos.payments.find(row => row.billId === order.originBillId)!;
    setClock(`${date}T${order.orderedAt.slice(11)}+09:00`, 'real', date);
    const { createPosSeed } = await import('../../pos/seed');
    const beforePayment = createPosSeed();
    expect(beforePayment.orders.find(row => row.orderId === order.orderId)).toMatchObject({
      preparation: 'accepted', completedAt: null,
    });
    expect(beforePayment.bills.find(row => row.billId === payment.billId)).toMatchObject({ status: 'open', settlementLines: [] });
    expect(beforePayment.payments.some(row => row.paymentId === payment.paymentId)).toBe(false);
    expect(beforePayment.receipts.some(row => row.paymentId === payment.paymentId)).toBe(false);
    setClock(`${date}T${payment.at.slice(11)}+09:00`, 'real', date);
    const { createPosSeed: readLater } = await import('../../pos/seed');
    const afterPayment = readLater();
    expect(afterPayment.payments.map(row => row.paymentId)).toContain(payment.paymentId);
    expect(afterPayment.receipts.map(row => row.paymentId)).toContain(payment.paymentId);
  });

  it('keeps yesterday complete before the business-day cutoff', async () => {
    setClock(`${date}T04:59:00+09:00`, 'real');
    const [{ seedHistory }, { createWidgetDataStore, readModel }] = await Promise.all([
      import('./cafe-fixtures'), import('../widget-data'),
    ]);
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(snapshot.pos?.orders).toEqual([]);
    expect(snapshot.tables.dailySales.find(row => row.businessDate === '2026-11-21')?.recognizedNet).toBe(seedHistory.days.at(-1)?.net);
    expect(readModel(snapshot, 'ledger').sales.net).toBe(seedHistory.days.at(-1)?.net);
  });

  it('reveals the full sample later while keeping the earlier days complete', async () => {
    setClock(`${date}T15:45:00+09:00`, 'real', date);
    const [{ seedToday }, { seedHistory }, { createWidgetDataStore, readModel }] = await Promise.all([
      import('./generated/today'), import('./cafe-fixtures'), import('../widget-data'),
    ]);
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(snapshot.pos!.payments).toHaveLength(seedToday.pos.payments.length);
    expect(readModel(snapshot, 'ledger').sales.net).toBe(seedToday.rollup.net);
    expect(snapshot.tables.dailySales.slice(0, -1).map(row => [row.businessDate, row.recognizedNet]))
      .toEqual(seedHistory.days.map(row => [row.date, row.net]));
  });

  it('preserves the full fixed fixture at the same wall time', async () => {
    setClock(`${cutoff}+09:00`, 'fixed', date);
    const [generated, fixtures, { createWidgetDataStore, readModel }] = await Promise.all([
      import('./generated/today'), import('./cafe-fixtures'), import('../widget-data'),
    ]);
    const snapshot = createWidgetDataStore().getSnapshot();
    expect(fixtures.seedToday).toEqual(generated.seedToday);
    expect(snapshot.pos!.receipts).toHaveLength(generated.seedToday.pos.receipts.length);
    expect(readModel(snapshot, 'ledger').sales.net).toBe(generated.seedToday.rollup.net);
  });
});
