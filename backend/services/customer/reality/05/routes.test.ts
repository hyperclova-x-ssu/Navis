import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify, { type HTTPMethods } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { dbPool } from '../../../../packages/db/index.ts';
import { runMigrations } from '../../../../packages/db/migrate.ts';
import { withCustomerStore } from '../../claims.ts';

const clock = new Date('2026-11-17T06:45:00Z');
const actorId = randomUUID();
const token = randomUUID();
const privateToken = randomUUID();
const pool = dbPool('customer', 'runtime', 'test');
const app = Fastify();

beforeAll(async () => {
  const routes = await import('./routes.ts');
  await runMigrations('customer', fileURLToPath(new URL('../../migrations/', import.meta.url)), 'test');
  routes.registerMemberRoutes(app, pool, { gatewayToken: token, privateToken, now: () => clock });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

function request(store: string, method: HTTPMethods, path: string, payload?: object, key = randomUUID(), role = 'owner') {
  return app.inject({ method, url: `/internal/v1/customer/stores/${store}${path}`,
    headers: { authorization: `Bearer ${token}`, 'x-navis-store-id': store, 'x-navis-user-id': actorId,
      'x-navis-store-role': role, 'idempotency-key': key }, payload });
}

it('replays a member receipt and masks the list while allowing store-scoped detail', async () => {
  const store = randomUUID();
  const input = { name: '가상회원', phone: '01000000123' };
  const key = randomUUID();
  const result = await request(store, 'POST', '/customers', input, key);
  expect(result.statusCode, result.body).toBe(200);
  const receipt = result.json();
  expect((await request(store, 'POST', '/customers', input, key)).json()).toEqual(receipt);
  expect((await request(store, 'POST', '/customers', { ...input, name: '다른 이름' }, key)).statusCode).toBe(409);
  expect((await request(store, 'POST', '/customers', input)).json()).toMatchObject({ reason: 'DUPLICATE_MEMBER_PHONE' });
  const list = await request(store, 'GET', '/customers?query=0123');
  expect(list.json()).toMatchObject({ items: [{ memberId: receipt.resourceId, memberCode: 'M-0001', phoneMasked: '010-****-0123',
    consent: { contactAllowed: true, marketingAllowed: false } }], sourceRevision: 1, nextCursor: null });
  expect(list.body).not.toContain(input.phone);
  const path = `/customers/${receipt.resourceId}`;
  expect((await request(store, 'GET', path)).json()).toMatchObject({ phone: input.phone, memberCode: 'M-0001' });
  expect((await request(store, 'GET', '/customers?query=m-0001')).json()).toMatchObject({
    items: [{ memberId: receipt.resourceId, memberCode: 'M-0001' }],
  });
  expect((await request(randomUUID(), 'GET', path)).statusCode).toBe(404);
  expect((await request(store, 'GET', path, undefined, key, 'staff')).statusCode).toBe(403);
  expect((await pool.query('SELECT member_id FROM customer.member')).rows).toEqual([]);
});

it('allocates codes once per member under concurrent creation, independently in each store', async () => {
  const store = randomUUID(), otherStore = randomUUID();
  const [first, second, other] = await Promise.all([
    request(store, 'POST', '/customers', { name: '첫 회원', phone: '01000000201' }),
    request(store, 'POST', '/customers', { name: '둘째 회원', phone: '01000000202' }),
    request(otherStore, 'POST', '/customers', { name: '다른 매장', phone: '01000000201' }),
  ]);
  expect([first.statusCode, second.statusCode, other.statusCode]).toEqual([200, 200, 200]);
  const ids = [first.json().resourceId, second.json().resourceId, other.json().resourceId];
  const response = await app.inject({ method: 'POST', url: `/internal/v1/customer/stores/${store}/member-codes`,
    headers: { authorization: `Bearer ${privateToken}`, 'x-navis-store-id': store }, payload: { memberIds: ids } });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().items.map((item: { memberCode: string }) => item.memberCode).sort()).toEqual(['M-0001', 'M-0002']);
  expect(response.json().items.map((item: { memberId: string }) => item.memberId).sort()).toEqual(ids.slice(0, 2).sort());
  expect((await request(otherStore, 'GET', '/customers/' + ids[2])).json().memberCode).toBe('M-0001');
});

it('revokes live audience eligibility and restores an edited note once through its receipt', async () => {
  const store = randomUUID();
  const { resourceId: id } = (await request(store, 'POST', '/customers', { name: '테스트', phone: '01000000456' })).json();
  const consent = `/customers/${id}/consents`;
  expect((await request(store, 'PATCH', consent, { marketingAllowed: true, expectedRevision: 1 })).statusCode).toBe(200);
  expect((await request(store, 'GET', '/customers?marketingEligible=true')).json().items).toHaveLength(1);
  expect((await request(store, 'PATCH', consent, { marketingAllowed: false, expectedRevision: 2 })).statusCode).toBe(200);
  expect((await request(store, 'GET', '/customers?marketingEligible=true')).json().items).toEqual([]);
  const notes = `/members/${id}/notes`;
  const added = (await request(store, 'POST', notes, { body: '첫 메모', expectedRevision: 3 })).json();
  const edited = (await request(store, 'PATCH', `${notes}/${added.noteId}`, { body: '편집', expectedRevision: 1 })).json();
  const undo = `/members/receipts/${edited.receiptId}/undo`;
  expect((await request(store, 'POST', undo, {})).statusCode).toBe(200);
  expect((await request(store, 'POST', undo, {})).json().reason).toBe('UNDO_ALREADY_APPLIED');
  expect((await request(store, 'GET', `/customers/${id}`)).json().notes).toMatchObject([{ body: '첫 메모', revision: 3 }]);
  const events = await withCustomerStore(pool, store, db => db.query('SELECT event_type, payload FROM customer.outbox ORDER BY store_seq'));
  expect(events.rows.map(row => row.event_type)).toContain('customer.contact_state_changed.v1');
  expect(events.rows.slice(0, 3).map(row => row.payload.nameInitial)).toEqual([undefined, '테', undefined]);
  expect(JSON.stringify(events.rows)).not.toContain('테스트');
  expect(JSON.stringify(events.rows)).not.toContain('첫 메모');
  expect(JSON.stringify(events.rows)).not.toContain('01000000456');
});

it('publishes the updated initial on rename and clears it for a one-character name or archive', async () => {
  const store = randomUUID();
  const { resourceId: id } = (await request(store, 'POST', '/customers', { name: '김가상', phone: '01000000789' })).json();
  const path = `/customers/${id}`;
  expect((await request(store, 'PATCH', path + '/consents', { marketingAllowed: true, expectedRevision: 1 })).statusCode).toBe(200);
  expect((await request(store, 'PATCH', path, { name: '𐐀테스트', expectedRevision: 2 })).statusCode).toBe(200);
  expect((await request(store, 'PATCH', path, { name: 'e\u0301', expectedRevision: 3 })).statusCode).toBe(200);
  expect((await request(store, 'PATCH', path, { name: '박가상', expectedRevision: 4 })).statusCode).toBe(200);
  const archived = await app.inject({ method: 'POST', url: `/internal/v1/customer/stores/${store}/member-archive`,
    headers: { authorization: `Bearer ${privateToken}`, 'x-navis-store-id': store },
    payload: { memberId: id, actorId, key: randomUUID(), confirmed: true, expectedRevision: 5, purchasedMembershipIds: [] } });
  expect(archived.statusCode, archived.body).toBe(200);
  const { rows } = await withCustomerStore(pool, store, db => db.query('SELECT payload FROM customer.outbox ORDER BY store_seq'));
  expect(rows.map(row => row.payload.nameInitial)).toEqual([undefined, '김', '𐐀', undefined, '박', undefined]);
  expect(rows.at(-1)?.payload).toMatchObject({ active: false, contactAllowed: false, marketingAllowed: false });
});
