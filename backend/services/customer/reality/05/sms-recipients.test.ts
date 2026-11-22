import Fastify from 'fastify';
import type { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { registerSmsRecipientRoute, smsRecipientsRoute } from './sms-recipients.ts';

const store = 'd85e9289-0b89-4e02-8eb7-3ce777285baa';

it('serves current SMS recipients only to the distinct Marketing credential and the bound store', async () => {
  expect(() => registerSmsRecipientRoute(Fastify(), {} as Pool, { marketingToken: 'pos', otherTokens: ['pos'] })).toThrow();
  const app = Fastify();
  const connect = vi.fn();
  registerSmsRecipientRoute(app, { connect } as unknown as Pool, { marketingToken: 'marketing-sms', otherTokens: ['pos'] });
  const call = (token: string, storeHeader: string, payload: object) => app.inject({ method: 'POST',
    url: smsRecipientsRoute.replace(':storeId', store), headers: { authorization: 'Bearer ' + token, 'x-navis-store-id': storeHeader },
    payload });
  try {
    expect((await call('pos', store, { memberIds: [], purpose: 'advertising' })).statusCode).toBe(401);
    expect((await call('marketing-sms', 'a85e9289-0b89-4e02-8eb7-3ce777285baa', { memberIds: [], purpose: 'advertising' })).statusCode).toBe(403);
    expect((await call('marketing-sms', store, { memberIds: [], purpose: 'everyone' })).statusCode).toBe(400);
    expect((await call('marketing-sms', store, { memberIds: ['x'], purpose: 'advertising' })).statusCode).toBe(400);
    const empty = await call('marketing-sms', store, { memberIds: [], purpose: 'advertising' });
    expect(empty.json()).toEqual({ purpose: 'advertising', items: [], eligibleCount: 0, requestedCount: 0,
      excluded: { notFound: 0, archived: 0, noContactConsent: 0, noMarketingConsent: 0 } });
    expect(empty.headers['cache-control']).toBe('no-store');
    expect(connect).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
