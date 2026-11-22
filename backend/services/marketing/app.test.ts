import type { Pool } from 'pg';
import { expect, it } from 'vitest';
import { createFixtureSms, createMarketingApp } from './app.ts';

it.each(['promo-fixture', 'sms-confirmation-fixture'])('rejects a reused local command credential (%s)', commandToken => {
  expect(() => createMarketingApp({} as Pool, {
    promoToken: 'promo-fixture',
    confirmSmsToken: 'sms-confirmation-fixture',
    readToken: 'gateway-fixture',
    sms: createFixtureSms('test-key', false),
    artifacts: {
      async put() { throw new Error('Unexpected test artifact write'); },
      async read() { throw new Error('Unexpected test artifact read'); },
    },
  }, undefined, { readToken: 'gateway-fixture', local: { commandToken } }))
    .toThrow('Marketing workload credentials must be distinct');
});
