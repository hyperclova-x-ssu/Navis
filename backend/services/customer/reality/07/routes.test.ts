import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { withCustomerStore } from '../../claims.ts';
import { calendarPosProjectionHandlers, projectCalendarSource } from './projection.ts';
import { registerCalendarStaffRoutes } from './routes.ts';

const pool = dbPool('customer', 'runtime', 'test');
const token = randomBytes(32).toString('hex');
const actor = randomUUID();
let now = new Date('2026-11-21T06:45:00Z');

function createService(options: Parameters<typeof registerCalendarStaffRoutes>[3] = {}) {
  const app = createApp('customer', async () => {}, false);
  registerCalendarStaffRoutes(app, pool, token, { now: () => now, ...options });
  return app;
}

const service = createService();
const headers = (store: string, key: string = randomUUID(), user: string = actor) => ({
  authorization: `Bearer ${token}`,
  'x-navis-store-id': store,
  'x-navis-store-role': 'owner',
  'x-navis-user-id': user,
  'x-navis-store-timezone': 'Asia/Seoul',
  'idempotency-key': key,
});
const route = (store: string, path: string) => `/internal/v1/customer/stores/${store}${path}`;

function request(store: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object, key?: string) {
  return service.inject({ method, url: route(store, path), headers: headers(store, key), payload });
}

beforeAll(() => runMigrations('customer', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test'), 30_000);
afterAll(async () => {
  await service.close();
  await pool.end();
});

it('persists a closure, deduplicates the command, and re-reads an edited revision in a new session', async () => {
  const store = randomUUID();
  const path = '/calendar/events';
  const body = { kind: 'event', title: '임시 휴무', date: '2026-11-23', storeClosure: { kind: 'temporary', endDate: '2026-11-25' } };
  const key = randomUUID();
  const created = await request(store, 'POST', path, body, key);
  expect(created.statusCode).toBe(201);
  const { resourceId, receiptId } = created.json();
  expect((await request(store, 'POST', path, body, key)).json()).toEqual(created.json());
  expect((await request(store, 'POST', path, { ...body, title: '다른 제목' }, key)).statusCode).toBe(409);
  expect((await request(store, 'POST', path, { ...body, title: '임시휴무' })).json()).toMatchObject({ reason: 'CALENDAR_DUPLICATE' });
  expect((await request(store, 'POST', path, { ...body, date: '2026-11-20', storeClosure: null })).json()).toMatchObject({ reason: 'CALENDAR_PAST_DATE' });
  const detail = `${path}/${resourceId}`;
  expect((await request(store, 'PATCH', detail, { expectedRevision: 1, memo: '수정' })).json()).toMatchObject({ revision: 2 });
  expect((await request(store, 'PATCH', detail, { expectedRevision: 1, memo: '다른 탭' })).json()).toMatchObject({ reason: 'STALE_REVISION' });
  expect((await request(store, 'POST', `/calendar/receipts/${receiptId}/undo`, {})).json()).toMatchObject({ reason: 'UNDO_UNAVAILABLE' });
  const reloaded = createService();
  try {
    const query = '?startDate=2026-11-24&endDate=2026-11-24';
    const read = await reloaded.inject({ url: route(store, path + query), headers: headers(store, undefined, randomUUID()) });
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.json()).toMatchObject({ items: [{ ...body, eventId: resourceId, memo: '수정', revision: 2 }], nextCursor: null, sourceRevision: 2 });
    const exported = await reloaded.inject({ url: route(store, '/calendar/exports' + query), headers: headers(store) });
    expect(exported.headers['content-type']).toContain('text/calendar');
    expect(exported.body).toContain('DTSTART;VALUE=DATE:20261123\r\nDTEND;VALUE=DATE:20261126');
  } finally {
    await reloaded.close();
  }
  const events = await withCustomerStore(pool, store, db => db.query(`SELECT event_type, store_seq, payload
    FROM customer.outbox WHERE store_id = $1 ORDER BY store_seq`, [store]));
  expect(events.rows).toEqual([1, 2].map(revision => ({ event_type: 'customer.calendar_changed.v1', store_seq: String(revision),
    payload: { resourceId, revision, sourceRevision: revision, operation: revision === 1 ? 'create' : 'update',
      affectedSources: ['calendar', 'notice-send', 'ai-response', 'briefing'] } })));
});

it('serializes conflicting shifts and moves both sides of a handoff with reversible history', async () => {
  const store = randomUUID();
  const addStaff = async (name: string) => (await request(store, 'POST', '/staff', { name })).json().resourceId;
  const [staffId, other] = await Promise.all([addStaff('수지'), addStaff('민호')]);
  const date = '2026-11-23';
  const addShift = (staffId: string, start: string, end: string) => request(store, 'POST', '/shifts', { staffId, date, kind: 'work', start, end, breakMinutes: 15 });
  const first = await addShift(staffId, '09:00', '17:30');
  const contenders = await Promise.all([addShift(other, '17:30', '21:00'), addShift(other, '17:30', '22:00')]);
  expect(contenders.map(reply => reply.statusCode).sort()).toEqual([201, 409]);
  expect(contenders.find(reply => reply.statusCode === 409)?.json()).toMatchObject({ reason: 'STAFF_SHIFT_OVERLAP' });
  const query = `?startDate=${date}&endDate=${date}`;
  const start = (await request(store, 'GET', '/shifts' + query)).json();
  const moved = await request(store, 'POST', '/shifts/handoff', { date, fromTime: '17:30', toTime: '18:00', expectedRevision: start.sourceRevision });
  expect(moved.statusCode).toBe(200);
  expect(moved.json().scheduleIds).toHaveLength(2);
  const changed = (await request(store, 'GET', '/shifts' + query)).json();
  expect(changed.items).toEqual(expect.arrayContaining([expect.objectContaining({ staffId, end: '18:00' }), expect.objectContaining({ staffId: other, start: '18:00' })]));
  expect((await request(store, 'POST', `/staff/receipts/${moved.json().receiptId}/undo`, {})).statusCode).toBe(200);
  const restored = (await request(store, 'GET', '/shifts' + query)).json();
  expect(restored.items.find((row: { staffId: string }) => row.staffId === staffId)).toMatchObject({ end: '17:30', revision: 3 });
  expect((await request(store, 'DELETE', `/shifts/${first.json().resourceId}`, { expectedRevision: 3 })).json()).toMatchObject({ reason: 'EXTRA_CONFIRMATION_REQUIRED' });
  const history = (await request(store, 'GET', '/shifts/history' + query)).json().items;
  expect(history).toHaveLength(6);
  expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ operation: 'update', before: expect.objectContaining({ end: '18:00' }), after: expect.objectContaining({ end: '17:30' }) })]));
  expect(history.every((entry: object) => !('actorId' in entry))).toBe(true);
});

it('keeps staff cascade and receipt expiry scoped to the confirming owner', async () => {
  const store = randomUUID();
  const staff = (await request(store, 'POST', '/staff', { name: '주연' })).json();
  const shift = (await request(store, 'POST', '/shifts', { staffId: staff.resourceId, date: '2026-11-23', kind: 'off' })).json();
  expect((await request(store, 'DELETE', `/staff/${staff.resourceId}`, { expectedRevision: 1, expectedScheduleRevision: 0,
    cascadeSchedules: true, confirmed: true })).json()).toMatchObject({ reason: 'STALE_REVISION', field: 'expectedScheduleRevision' });
  const deleted = (await request(store, 'DELETE', `/staff/${staff.resourceId}`, { expectedRevision: 1, expectedScheduleRevision: 1,
    cascadeSchedules: true, confirmed: true })).json();
  expect(deleted.deletedScheduleIds).toEqual([shift.resourceId]);
  expect((await request(store, 'GET', '/staff')).json().items).toEqual([]);
  expect((await request(store, 'GET', '/shifts')).json().items).toEqual([]);
  const undo = `/staff/receipts/${deleted.receiptId}/undo`;
  expect((await service.inject({ method: 'POST', url: route(store, undo), headers: headers(store, undefined, randomUUID()), payload: {} })).statusCode).toBe(404);
  expect((await request(store, 'POST', undo, {})).statusCode).toBe(200);
  expect((await request(store, 'GET', '/shifts')).json().items).toEqual([expect.objectContaining({ scheduleId: shift.resourceId, kind: 'off', revision: 3 })]);
  const created = (await request(store, 'POST', '/calendar/events', { kind: 'todo', title: '할 일' })).json();
  const old = now;
  now = new Date(created.undoUntil);
  try {
    expect((await request(store, 'POST', `/calendar/receipts/${created.receiptId}/undo`, {})).json()).toMatchObject({ reason: 'UNDO_EXPIRED' });
  } finally {
    now = old;
  }
});

it('deduplicates source projections and prevents a delayed event from restoring a removed item', async () => {
  const store = randomUUID();
  const sourceId = randomUUID();
  const payload = { source: 'purchase-order', sourceId, revision: 1, entry: { date: '2026-11-24', time: '14:00' } };
  const apply = (data: object) => withCustomerStore(pool, store, db => projectCalendarSource(db, store, 'inventory', data));
  expect(await apply(payload)).toBe(true);
  expect(await apply(payload)).toBe(false);
  await expect(apply({ ...payload, entry: { date: '2026-11-26' } })).rejects.toMatchObject({ reason: 'CALENDAR_PROJECTION_REVISION_CONFLICT' });
  const projections = '/calendar/projections';
  expect((await request(store, 'GET', projections)).json()).toMatchObject({ items: [{ source: 'purchase-order', sourceId, sourceRevision: 1, featureId: 'suppliers', date: '2026-11-24' }] });
  expect(await apply({ ...payload, revision: 2, entry: null })).toBe(true);
  expect(await apply(payload)).toBe(false);
  expect((await request(store, 'GET', projections)).json()).toMatchObject({ items: [], sourceRevision: 2 });
});

it('downloads only selected sources and escapes text without losing the local shift time', async () => {
  const store = randomUUID();
  const date = '2026-11-25';
  const first = (await request(store, 'POST', '/calendar/events', { kind: 'event', title: '긴 제목, ' + '휴'.repeat(35), date, time: '16:00', memo: '정리; 확인\nEND:VEVENT' })).json();
  await request(store, 'POST', '/calendar/events', { kind: 'todo', title: '세금 준비', date, categoryId: 'tax-admin' });
  const staff = (await request(store, 'POST', '/staff', { name: '지수' })).json();
  await request(store, 'POST', '/shifts', { staffId: staff.resourceId, date, kind: 'work', start: '13:00', end: '18:30' });
  const taxId = randomUUID();
  await withCustomerStore(pool, store, db => calendarPosProjectionHandlers['pos.tax_due_changed.v1'](db, {
    producer: 'pos', storeId: store, scopeKey: store, eventId: randomUUID(), eventType: 'pos.tax_due_changed.v1',
    aggregateId: taxId, occurredAt: now.toISOString(), schemaVersion: 1, storeSeq: '1',
    payload: { calendarProjection: { source: 'tax-due', sourceId: taxId, revision: 1, entry: { date } } },
  }));
  const prefs = (await request(store, 'GET', '/calendar/preferences')).json();
  expect(prefs).toMatchObject({ revision: 0, sourceVisibility: { shift: true, reservation: false } });
  expect((await request(store, 'PATCH', '/calendar/preferences', { categoryId: 'tax-admin', visible: false, expectedRevision: 0 })).json())
    .toMatchObject({ changed: true, affectedSources: ['calendar'], revision: 1 });
  expect((await request(store, 'PATCH', '/calendar/preferences', { source: 'shift', visible: false, expectedRevision: 0 })).json())
    .toMatchObject({ reason: 'STALE_REVISION' });
  const response = await request(store, 'GET', `/calendar/exports?startDate=${date}&endDate=${date}`);
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-disposition']).toContain('navis-calendar.ics');
  const unfolded = response.body.replace(/\r\n /g, '');
  expect(unfolded).toContain(`UID:event-${first.resourceId}.${store}@navis`);
  expect(response.body).toContain('DTSTART:20261125T040000Z\r\nDTEND:20261125T093000Z');
  expect(unfolded).toContain(`SUMMARY:긴 제목\\, ${'휴'.repeat(35)}\r\nDESCRIPTION:정리\\; 확인\\nEND:VEVENT`);
  expect(response.body.split('\r\n').every(line => Buffer.byteLength(line) <= 75)).toBe(true);
  expect(response.body).not.toContain('세금');
  expect((await request(store, 'GET', '/calendar/projections')).json().items).toEqual([expect.objectContaining({ sourceId: taxId })]);
});

it('archives the authorized calendar download in a store-isolated object and returns the verified bytes', async () => {
  const store = randomUUID();
  const other = randomUUID();
  const date = '2026-11-25';
  const path = `/calendar/exports?startDate=${date}&endDate=${date}`;
  expect((await request(store, 'POST', '/calendar/events', { kind: 'event', title: '매장 점검', date })).statusCode).toBe(201);
  const existing = await request(store, 'GET', path);
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  let corrupt = false;
  const archived = createService({ objectStorage: {
    async put(key: string, bytes: Buffer, contentType: string) {
      expect(contentType).toBe('text/calendar');
      objects.set(key, bytes);
    },
    async get(key: string) {
      reads.push(key);
      const object = objects.get(key);
      const bytes = corrupt && object ? Buffer.alloc(object.length) : object;
      return bytes && { body: Readable.from([bytes]), contentLength: bytes.length, contentType: 'text/calendar' };
    },
  } });
  try {
    const url = route(store, path);
    expect((await archived.inject({ url })).statusCode).toBe(401);
    expect((await archived.inject({ url, headers: headers(other) })).statusCode).toBe(403);
    expect(objects.size).toBe(0);
    expect(reads).toEqual([]);

    const downloaded = await archived.inject({ url, headers: headers(store, undefined, randomUUID()) });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers).toMatchObject({ 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="navis-calendar.ics"' });
    expect(downloaded.rawPayload).toEqual(existing.rawPayload);
    expect([...objects.keys()]).toEqual([expect.stringMatching(new RegExp(`^stores/${store}/documents/calendar/.+\\.ics$`))]);
    const [key] = objects.keys();
    expect(objects.get(key)).toEqual(downloaded.rawPayload);
    expect(reads).toContain(key);

    const outsider = await archived.inject({ url: route(other, path), headers: headers(other) });
    expect(outsider.statusCode).toBe(200);
    expect(outsider.body).not.toContain('매장 점검');
    expect([...objects.keys()]).toContainEqual(expect.stringContaining(`stores/${other}/documents/calendar/`));

    corrupt = true;
    const invalid = await archived.inject({ url, headers: headers(store) });
    expect(invalid.statusCode).toBe(503);
    expect(invalid.json().reason).toBe('CALENDAR_EXPORT_STORAGE_UNAVAILABLE');
  } finally {
    await archived.close();
  }
});

it('rejects unauthenticated, mismatched and non-owner writes and hides another store in PostgreSQL', async () => {
  const store = randomUUID();
  const other = randomUUID();
  const body = { kind: 'todo', title: '할 일' };
  const url = route(store, '/calendar/events');
  expect((await service.inject({ method: 'POST', url, payload: body })).statusCode).toBe(401);
  expect((await service.inject({ method: 'POST', url, headers: headers(other), payload: body })).statusCode).toBe(403);
  expect((await service.inject({ method: 'POST', url, headers: { ...headers(store), 'x-navis-store-role': 'staff' }, payload: body })).statusCode).toBe(403);
  expect((await request(store, 'GET', '/calendar/events')).json().items).toEqual([]);
  const { resourceId } = (await request(store, 'POST', '/calendar/events', body)).json();
  expect((await request(other, 'GET', `/calendar/events/${resourceId}`)).statusCode).toBe(404);
  const fresh = dbPool('customer', 'runtime', 'test');
  const db = await fresh.connect();
  const visible = () => db.query('SELECT event_id FROM customer.calendar_event WHERE event_id = $1', [resourceId]);
  try {
    expect((await visible()).rows).toEqual([]);
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.store_id', $1, true)", [store]);
    expect((await visible()).rows).toEqual([{ event_id: resourceId }]);
    await expect(db.query(`INSERT INTO customer.calendar_event (store_id,event_id,kind,category_id,title,title_key,starts_on,revision)
      VALUES ($1,$2,'todo','store-operations','다른 매장','다른매장','2026-11-23',1)`, [other, randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await db.query('ROLLBACK');
    expect((await db.query("SELECT current_setting('app.store_id', true) AS scope")).rows[0].scope).toBe('');
    expect((await visible()).rows).toEqual([]);
    await expect(db.query('UPDATE customer.calendar_event SET title = $1 WHERE event_id = $2', ['다른 제목', resourceId])).resolves.toMatchObject({ rowCount: 0 });
  } finally {
    db.release(true);
    await fresh.end();
  }
});

it('requires verified PN11 cards and persists owner-only Calendar and WORKS receipts across service reload', async () => {
  const store = randomUUID();
  const localEvent = (await request(store, 'POST', '/calendar/events', {
    kind: 'event', title: '일정', date: '2026-11-23',
  })).json().resourceId;
  const staffId = (await request(store, 'POST', '/staff', { name: '수지' })).json().resourceId;
  const shift = (await request(store, 'POST', '/shifts', {
    staffId, date: '2026-11-23', kind: 'work', start: '09:00', end: '17:30',
  })).json().resourceId;

  type Call = import('../../../../packages/naver/config/index.ts').NaverRequestScope;
  type Options = import('./naver.ts').NaverCalendarOptions;
  type Operation = 'calendar.add' | 'works.create' | 'works.update' | 'works.delete';
  const calls: Call[] = [];
  let grantEnabled = true;
  let worksEvent: Record<string, unknown> | undefined;
  let target = 'team';
  let delayCreate = false;
  const enteredCreate = Promise.withResolvers<void>();
  const dropResponse = Promise.withResolvers<void>();
  const enteredList = Promise.withResolvers<void>();
  const releaseList = Promise.withResolvers<void>();
  let delayList = false;
  const handler = async (call: Call) => {
    calls.push(call);
    if (call.operation === 'pn11.calendar.create') {
      expect(call.headers.get('authorization')).toBe('Bearer fixture-grant');
      const form = new URLSearchParams(Buffer.from(call.body!).toString());
      expect(form.get('calendarId')).toBe('defaultCalendarId');
      expect(form.get('scheduleIcalString')?.match(/BEGIN:VEVENT/g)).toHaveLength(1);
      return Response.json({ result: 'success', returnValue: { processType: 'modify', calendarId: 'fixture-calendar', icalUid: 'fixture-uid' } });
    }
    if (call.method === 'GET') {
      expect(call.url.search).toContain('%2B09%3A00');
      if (delayList) {
        enteredList.resolve();
        await releaseList.promise;
      }
      return Response.json({ events: worksEvent ? [{ eventComponents: [worksEvent] }] : [] });
    }
    if (call.method === 'DELETE') {
      expect(call.url.pathname.endsWith('/' + worksEvent?.eventId)).toBe(true);
      worksEvent = undefined;
      return new Response(null, { status: 204 });
    }
    const body = JSON.parse(Buffer.from(call.body!).toString());
    if (call.method === 'PUT') expect(body.eventComponents[0].eventId).toBe(worksEvent?.eventId);
    worksEvent = body.eventComponents[0];
    if (delayCreate && call.method === 'POST') {
      enteredCreate.resolve();
      await dropResponse.promise;
      throw new DOMException('WORKS reply timed out', 'TimeoutError');
    }
    return Response.json({ eventComponents: [worksEvent] });
  };
  const otherStore = randomUUID();
  const base = { mode: 'fake' as const, storeId: store, providerAccount: 'test', grade: 'W' as const, handler };
  const options: Options = {
    bindings: [
      { ...base, operation: 'pn11.calendar.create', method: 'POST', route: /^\/calendar\/createSchedule\.json$/ },
      { ...base, storeId: otherStore, operation: 'pn11.calendar.create', method: 'POST', route: /^\/calendar\/createSchedule\.json$/ },
      ...([['list', 'GET'], ['create', 'POST'], ['update', 'PUT'], ['delete', 'DELETE']] as const).map(([operation, method]) => ({
        ...base, operation: 'pn11.works.' + operation, method, route: /^\/v1\.0\/users\/member\/calendars\/team\/events(?:\/[a-f0-9]{64})?$/,
      })),
    ],
    async readCalendarGrant(ctx, scope) {
      if (grantEnabled) return { ...ctx, scope, accessToken: 'fixture-grant', expiresAt: new Date(+now + 60_000) };
    },
    async resolveWorksTarget() { return { userId: 'member', calendarId: target }; },
  };
  const start = () => {
    const app = createApp('customer', async () => {}, false);
    registerCalendarStaffRoutes(app, pool, token, { now: () => now, naver: options });
    return app;
  };
  const app = start(), reloaded = start();
  const send = (method: 'POST' | 'PATCH' | 'DELETE', path: string, payload: { approvalId: string; expectedRevision: number; expectedStaffRevision?: number }) =>
    app.inject({ method, url: route(store, path), headers: headers(store, payload.approvalId), payload });
  const issue = (operation: Operation, resourceId: string, expectedRevision: number,
    expectedStaffRevision?: number, approvalId?: string, user = actor) =>
    app.inject({ method: 'POST', url: route(store, '/calendar/naver-approvals'), headers: headers(store, undefined, user),
      payload: { stage: approvalId ? 'confirm' : 'press', operation, resourceId, expectedRevision, expectedStaffRevision, approvalId } });
  async function card(operation: Operation, resourceId: string, expectedRevision: number, expectedStaffRevision?: number) {
    const response = await issue(operation, resourceId, expectedRevision, expectedStaffRevision);
    expect(response.statusCode, response.body).toBe(200);
    return { approvalId: response.json().approvalId as string, expectedRevision, expectedStaffRevision };
  }
  try {
    const calendar = '/calendar/events/' + localEvent + '/naver';
    const works = '/shifts/' + shift + '/naver-works';
    expect((await send('POST', calendar, { approvalId: randomUUID(), expectedRevision: 1 })).statusCode).toBe(403);
    expect((await issue('calendar.add', localEvent, 2)).json()).toMatchObject({ reason: 'STALE_REVISION' });
    const push = await card('calendar.add', localEvent, 1);
    const issuedAt = now;
    const expired = await card('calendar.add', localEvent, 1);
    now = new Date(+now + 60_000);
    try {
      expect((await send('POST', calendar, expired)).json()).toEqual({ code: 'CARD_REQUIRED' });
    } finally { now = issuedAt; }
    const wrongActor = await app.inject({ method: 'POST', url: route(store, calendar),
      headers: headers(store, push.approvalId, randomUUID()), payload: push });
    expect(wrongActor.json()).toEqual({ code: 'CARD_REQUIRED' });
    const wrongStore = await app.inject({ method: 'POST', url: route(otherStore, calendar),
      headers: headers(otherStore, push.approvalId), payload: push });
    expect(wrongStore.json()).toEqual({ code: 'CARD_REQUIRED' });
    grantEnabled = false;
    expect((await send('POST', calendar, push)).json()).toEqual({ code: 'NAVER_GRANT_REQUIRED' });
    expect(calls).toHaveLength(0);
    grantEnabled = true;
    const freshPush = await card('calendar.add', localEvent, 1);
    const first = await send('POST', calendar, freshPush);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ eventId: localEvent, processType: 'modify' });
    expect((await send('POST', calendar, freshPush)).json()).toEqual(first.json());
    expect(calls).toHaveLength(1);
    const read = (path: string, user?: string) => reloaded.inject({ url: route(store, path), headers: headers(store, undefined, user) });
    expect((await read(calendar)).json()).toEqual({ receipt: first.json() });
    expect((await read(calendar, randomUUID())).json()).toEqual({ receipt: null });

    const createCard = await card('works.create', shift, 1, 1);
    target = 'other-team';
    expect((await send('POST', works, createCard)).json()).toEqual({ code: 'CARD_REQUIRED' });
    expect(calls).toHaveLength(1);
    target = 'team';

    delayCreate = true;
    const creating = send('POST', works, createCard);
    await Promise.race([enteredCreate.promise, creating.then(reply => { throw new Error(reply.body); })]);
    try {
      expect((await read('/shifts/' + shift)).json()).toMatchObject({ revision: 1 });
      expect((await request(store, 'PATCH', '/shifts/' + shift, {
        expectedRevision: 1, staffId, date: '2026-11-24', kind: 'work', start: '10:00', end: '18:00',
      })).statusCode).toBe(200);
    } finally {
      dropResponse.resolve();
    }
    expect((await creating).statusCode).toBe(409);
    const originalEventId = worksEvent?.eventId;
    const list = '/shifts/naver-works?fromDateTime=2026-11-01T00:00:00%2B09:00&untilDateTime=2026-12-01T00:00:00%2B09:00';
    const update = await card('works.update', shift, 2, 1);
    const updated = await reloaded.inject({ method: 'PATCH', url: route(store, works),
      headers: headers(store, update.approvalId), payload: update });
    expect(updated.json()).toMatchObject({ eventId: originalEventId, revision: 2, operation: 'update' });
    expect(calls.filter(call => call.operation === 'pn11.works.create')).toHaveLength(1);
    expect(calls.find(call => call.operation === 'pn11.works.list')?.url.searchParams.get('fromDateTime'))
      .toBe('2026-11-23T00:00:00+09:00');
    expect((await read(list)).json()).toMatchObject({ items: [{
      ...worksEvent, scheduleId: shift, revision: 2, sentAt: updated.json().sentAt,
    }] });
    expect((await read(list, randomUUID())).json()).toEqual({ items: [] });
    delayList = true;
    const listing = read(list);
    await Promise.race([enteredList.promise, listing.then(reply => { throw new Error(reply.body); })]);
    try {
      expect((await request(store, 'PATCH', '/shifts/' + shift, {
        expectedRevision: 2, staffId, date: '2026-11-24', kind: 'work', start: '10:30', end: '18:00',
      })).json()).toMatchObject({ revision: 3 });
    } finally {
      releaseList.resolve();
      delayList = false;
    }
    expect((await listing).json()).toMatchObject({ items: [{ scheduleId: shift, revision: 2, sentAt: updated.json().sentAt }] });

    const remove = { ...await card('works.delete', shift, 3), expectedStaffRevision: 1 };
    expect((await send('DELETE', works, remove)).json()).toEqual({ code: 'CARD_REQUIRED' });
    expect((await issue('works.delete', shift, 3, 1, remove.approvalId, randomUUID())).statusCode).toBe(403);
    expect((await issue('works.delete', shift, 3, 1, remove.approvalId)).statusCode).toBe(200);
    expect((await send('DELETE', works, remove)).json()).toMatchObject({ eventId: originalEventId, operation: 'delete' });
    expect((await read(list)).json()).toEqual({ items: [] });
    expect((await read('/shifts/' + shift)).statusCode).toBe(200);
  } finally {
    dropResponse.resolve();
    releaseList.resolve();
    await Promise.all([app.close(), reloaded.close()]);
  }
});
