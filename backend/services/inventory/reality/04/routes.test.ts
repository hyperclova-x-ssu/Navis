import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createApp } from '../../../../infra/http.ts';
import { registerPurchaseRoutes } from './routes.ts';
import { parseCommand } from './wire.ts';

it('accepts a supplier name with blank or omitted contact details', () => {
  expect(parseCommand('create_supplier', { name: '공급사', contact: '', phone: '' })).toMatchObject({
    fields: { name: '공급사', contact: null, phone: null, memo: null },
  });
  expect(parseCommand('create_supplier', { name: '공급사' })).toMatchObject({
    fields: { name: '공급사', contact: null, phone: null, memo: null },
  });
  expect(() => parseCommand('create_supplier', { name: '   ' })).toThrow('SUPPLIER_INVALID');
});

it('rejects purchasing requests without gateway identity before opening a database connection', async () => {
  const app = createApp('inventory', async () => {}, false);
  const storeId = randomUUID();
  const token = randomUUID();
  registerPurchaseRoutes(app, {} as Pool, token);
  try {
    const url = `/internal/v1/inventory/stores/${storeId}/suppliers`;
    const missing = await app.inject({ url });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['cache-control']).toBe('no-store');
    const crossStore = await app.inject({ url, headers: {
      authorization: `Bearer ${token}`, 'x-navis-store-role': 'owner',
      'x-navis-store-id': randomUUID(), 'x-navis-user-id': randomUUID(),
    } });
    expect(crossStore.statusCode).toBe(403);
  } finally {
    await app.close();
  }
});
