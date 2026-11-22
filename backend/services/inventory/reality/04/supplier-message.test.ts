import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { registerSupplierMessages, supplierSendTime } from './supplier-message.ts';
import { fingerprint } from '../01/owner-card.ts';

describe('supplier message authorization', () => {
  it('returns the saved provider mode for both virtual and live receipts', async () => {
    const app = Fastify();
    const store = randomUUID(), order = randomUUID(), actor = randomUUID(), gateway = randomUUID(), worker = randomUUID();
    const receipts = [false, true].map(provider_live => ({ receipt_id: randomUUID(), po_id: order, channel: 'sms',
      order_revision: 1, scheduled_at: null, state: 'delivered', provider_live, block_reason: null }));
    const pool = { connect: async () => ({ release() {}, query: async (sql: string) => ({
      rows: sql.includes('FROM inventory.supplier_dispatch') ? receipts : [],
    }) }) } as unknown as Pool;
    registerSupplierMessages(app, pool, gateway, { workerToken: worker, storeId: store });
    try {
      const reply = await app.inject({ url: `/internal/v1/inventory/stores/${store}/purchase-orders/${order}/supplier-message`,
        headers: { authorization: 'Bearer ' + gateway, 'x-navis-user-id': actor, 'x-navis-store-id': store, 'x-navis-store-role': 'owner' } });
      expect(reply.statusCode).toBe(200);
      expect(reply.json().items).toEqual(receipts.map((row, index) => expect.objectContaining({
        receiptId: row.receipt_id, providerMode: index === 0 ? 'virtual' : 'live', state: 'delivered',
      })));
    } finally {
      await app.close();
    }
  });

  it('rejects text and spoofed cards before acquiring a database connection', async () => {
    const app = Fastify();
    const store = randomUUID();
    const order = randomUUID();
    const actor = randomUUID();
    const gateway = randomUUID();
    const worker = randomUUID();
    registerSupplierMessages(app, {} as Pool, gateway, { workerToken: worker, storeId: store });
    try {
      const path = '/internal/v1/inventory/stores/' + store + '/purchase-orders/' + order + '/supplier-message/confirm';
      const headers = { authorization: 'Bearer ' + gateway, 'x-navis-user-id': actor,
        'x-navis-store-id': store, 'x-navis-store-role': 'owner' };
      expect((await app.inject({ method: 'POST', url: path, payload: { text: '보내 줘' } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url: path, headers, payload: { text: '보내 줘' } })).statusCode).toBe(403);
      const forged = { input: { channel: 'sms' }, approval: 'typed-approval' };
      expect((await app.inject({ method: 'POST', url: path, headers, payload: forged })).statusCode).toBe(403);
      expect((await app.inject({ url: '/internal/v1/inventory/supplier-dispatch/stores/' + store, headers })).statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('defers evening and early-morning presses to the next KST calendar day at 08:00', () => {
    expect(supplierSendTime(new Date('2026-11-21T20:59:00+09:00'))).toBeNull();
    expect(supplierSendTime(new Date('2026-11-21T21:00:00+09:00'))).toBe('2026-11-21T23:00:00.000Z');
    expect(supplierSendTime(new Date('2026-11-22T01:00:00+09:00'))).toBe('2026-11-22T23:00:00.000Z');
  });

  it('uses the signed Korean purchase message for dispatch and honors older approved messages', async () => {
    const app = Fastify();
    const store = randomUUID(), actor = randomUUID(), gateway = randomUUID(), worker = randomUUID();
    const order = '6a03dd2b-4e62-4377-8001-484bf1987b4e';
    const readOrder = { poId: order, dueDate: '2026-11-24', expectedTime: '09:30', revision: 3,
      lines: [{ itemNameSnapshot: '종이컵', qtyOrdered: 1200, unitSnapshot: 'pcs', remaining: 1200 },
        { itemNameSnapshot: '원두', qtyOrdered: 0.5, unitSnapshot: 'kg', remaining: 0.5 }] };
    const supplier = { name: '발주사', phone: '010-0000-1234', revision: 2 };
    const target = '01000001234';
    const title = '발주 요청';
    const legacy = `${title}\n종이컵 1200 pcs\n원두 0.5 kg\n납기: 2026-11-24 09:30\n발주 번호: ${order}`;
    const expected = `${title}\n종이컵 1,200개\n원두 0.5 kg\n납기: 11/24(화) 09:30\n발주 번호: PO-6A03DD2B4E62`;
    let queuedSnapshot: string;
    const client = {
      release() {},
      query: async (sql: string) => {
        if (sql.includes('FROM inventory.purchase_order')) return { rows: [readOrder] };
        if (sql.includes('FROM inventory.supplier s')) return { rows: [supplier] };
        if (sql.includes("SET state='dispatching'")) return { rows: [{ po_id: order, channel: 'sms', snapshot: queuedSnapshot }] };
        expect(sql).not.toContain('INSERT INTO inventory.supplier_dispatch');
        return { rows: [] };
      },
    };
    registerSupplierMessages(app, { connect: async () => client } as unknown as Pool, gateway,
      { workerToken: worker, storeId: store, now: () => new Date('2026-11-22T05:00:00Z') });
    try {
      const preview = await app.inject({ method: 'POST', url: `/internal/v1/inventory/stores/${store}/purchase-orders/${order}/supplier-message/preview`,
        headers: { authorization: `Bearer ${gateway}`, 'x-navis-user-id': actor, 'x-navis-store-id': store, 'x-navis-store-role': 'owner' },
        payload: { input: { channel: 'sms' } } });
      expect(preview.statusCode).toBe(200);
      const { diff } = preview.json();
      expect(diff.body).toBe(expected);
      const claim = () => app.inject({ method: 'POST', url: `/internal/v1/inventory/supplier-dispatch/stores/${store}/${randomUUID()}/claim`,
        headers: { authorization: `Bearer ${worker}` } });
      queuedSnapshot = diff.sourceRevision;
      expect((await claim()).json()).toEqual({ channel: 'sms', target, title, body: expected });
      queuedSnapshot = fingerprint([supplier.revision, target, { orderRevision: readOrder.revision, supplierName: supplier.name, title, body: legacy }]);
      expect((await claim()).json()).toEqual({ channel: 'sms', target, title, body: legacy });
    } finally {
      await app.close();
    }
  });
});
