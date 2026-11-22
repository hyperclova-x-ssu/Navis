import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { dbPool, readSecret } from '../../packages/db/index.ts';
import type { NaverBinding } from '../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../packages/naver/transport/index.ts';
import { connectStreams } from '../../packages/streams/index.ts';
import { demoIdentity } from '../account/identity.ts';
import { createPersonaOwnerGrants } from '../account/naver/persona-grants.ts';
import { createCustomerApp } from './app.ts';
import { createCustomerConsumer } from './consumer.ts';
import { createCustomerNaver } from './naver/index.ts';
import { createPosClient, isRecord, isUuid } from './pos-client.ts';
import type { ReadTables } from './reality/06/routes.ts';
import { BookingUnavailable } from './reality/06/wire.ts';
import { createCalendarProjectionConsumers } from './reality/07/projection.ts';
import type { NaverCalendarOptions } from './reality/07/naver.ts';

const gatewayFile = process.env.NAVIS_GATEWAY_CUSTOMER_TOKEN_FILE;
const posFile = process.env.NAVIS_CUSTOMER_POS_TOKEN_FILE;
const privateFile = process.env.NAVIS_POS_CUSTOMER_TOKEN_FILE;
const posOrigin = process.env.NAVIS_POS_URL;
const fixtureNow = process.env.NAVIS_CUSTOMER_FIXTURE_NOW;
const replayNow = disposableReplayClock();
const now = replayNow ?? (() => fixtureNow ? new Date(fixtureNow) : new Date());
if (gatewayFile && (!posFile || !posOrigin)) throw new Error('Customer claim routes require scoped POS credentials and origin');
if (fixtureNow && !Number.isFinite(Date.parse(fixtureNow))) throw new Error('Invalid NAVIS_CUSTOMER_FIXTURE_NOW');

const gatewayToken = gatewayFile ? readSecret(gatewayFile) : undefined;
const posToken = posFile ? readSecret(posFile) : undefined;
const privateToken = privateFile ? readSecret(privateFile) : undefined;
if (gatewayToken && gatewayToken === posToken) throw new Error('Customer workload credentials must be distinct');
if (privateToken && (privateToken === posToken || privateToken === gatewayToken)) {
  throw new Error('Customer workload credentials must be distinct');
}
const pos = posOrigin && posToken ? createPosClient(posOrigin, posToken) : undefined;
const posBaseUrl = posOrigin && new URL(posOrigin);
const readTables: ReadTables | undefined = posBaseUrl && posToken ? async (storeId, actorId) => {
  try {
    const response = await fetch(new URL(`/internal/v1/pos/stores/${storeId}/booking-tables`, posBaseUrl), {
      redirect: 'error', signal: AbortSignal.timeout(2_000), headers: {
        authorization: `Bearer ${posToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId, 'x-navis-store-role': 'owner',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('POS tables unavailable');
    }
    const wire: unknown = await response.json();
    if (!isRecord(wire) || typeof wire.enabled !== 'boolean' || !Array.isArray(wire.tables)) {
      throw new Error('Invalid POS table response');
    }
    const tables = wire.tables.map((row: unknown) => {
      if (!isRecord(row) || !isUuid(row.tableId) || typeof row.label !== 'string' || typeof row.seats !== 'number'
        || !Number.isInteger(row.seats) || row.seats < 1 || row.seats > 30
        || (row.layoutTableId !== null && typeof row.layoutTableId !== 'string')
        || (row.number !== null && (typeof row.number !== 'number' || !Number.isSafeInteger(row.number) || row.number < 1))) {
        throw new Error('Invalid POS table row');
      }
      return { tableId: row.tableId, label: row.label, seats: row.seats, layoutTableId: row.layoutTableId, number: row.number };
    });
    return { enabled: wire.enabled, tables };
  } catch {
    throw new BookingUnavailable('POS_TABLES_UNAVAILABLE');
  }
} : undefined;
const {
  NAVIS_NAVER_VIRTUAL_STORE_ID: storeId,
  NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: providerAccount,
  NAVIS_NAVER_VIRTUAL_ORIGIN: origin,
  NAVIS_NAVER_VIRTUAL_TOKEN_FILE: privateTokenFile,
  NAVIS_NAVER_VIRTUAL_AICALL_CALLBACK_TOKEN_FILE: callbackFile,
} = process.env;
if ((storeId || providerAccount || callbackFile) && (!isUuid(storeId) || !providerAccount || !origin || !privateTokenFile)) {
  throw new Error('Incomplete private booking provider configuration');
}
const bookingOperations = [
  ['pn02.bookings.list', 'GET', /\/partner-assumed\/v1\/bookings/],
  ['pn02.bookings.read', 'GET', /\/partner-assumed\/v1\/bookings\/[A-Za-z0-9_-]{1,64}/],
  ['pn02.bookings.change', 'PATCH', /\/partner-assumed\/v1\/bookings\/[A-Za-z0-9_-]{1,64}/],
  ['pn02.bookings.confirm', 'POST', /\/partner-assumed\/v1\/bookings\/[A-Za-z0-9_-]{1,64}\/confirm/],
  ['pn02.bookings.cancel', 'POST', /\/partner-assumed\/v1\/bookings\/[A-Za-z0-9_-]{1,64}\/cancel/],
  ['pn02.booking-products.list', 'GET', /\/partner-assumed\/v1\/booking-products/],
  ['pn08.smartcall.calls', 'GET', /\/partner-assumed\/v1\/smartcall\/calls/],
] as const;
const naver = storeId && providerAccount && origin && privateTokenFile ? createCustomerNaver(createNaverTransport({
  bindings: bookingOperations.map(([operation, method, route]): NaverBinding => ({
    operation, method, route, storeId, providerAccount,
    grade: method === 'GET' && operation !== 'pn08.smartcall.calls' ? 'P' : 'O',
    mode: 'virtual', origin, privateTokenFile, timeoutMs: 2_000,
  })),
})) : undefined;
const callbackToken = callbackFile && readSecret(callbackFile);
const credentialsDir = process.env.NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR;
function calendarBinding(binding: { storeId: string; providerAccount: string; origin: string; privateTokenFile: string },
  directory: string): NaverCalendarOptions {
  const owner = { storeId: binding.storeId, actorId: demoIdentity.userId };
  const base = { ...binding, mode: 'virtual' as const, timeoutMs: 2_000 };
  const calendarRoute = /^\/v1\.0\/users\/fixture-owner\/calendars\/fixture-team\/events$/;
  const eventRoute = /^\/v1\.0\/users\/fixture-owner\/calendars\/fixture-team\/events\/[A-Za-z0-9_-]+$/;
  const grants = createPersonaOwnerGrants({ owner, scopes: ['calendar'], now, bindings: [{
    ...base, operation: 'pn11.fixture.owner-grant', grade: 'P', method: 'POST', route: /^\/partner-assumed\/v1\/fixture\/owner-grants$/,
  }] });
  const works = [
    ['pn11.works.list', 'GET', calendarRoute, 'nvirtual_works_read'],
    ['pn11.works.create', 'POST', calendarRoute, 'nvirtual_works_write'],
    ['pn11.works.update', 'PUT', eventRoute, 'nvirtual_works_write'],
    ['pn11.works.delete', 'DELETE', eventRoute, 'nvirtual_works_write'],
  ] as const;
  return {
    bindings: [
      { ...base, operation: 'pn11.calendar.create', grade: 'W', method: 'POST', route: /^\/calendar\/createSchedule\.json$/ },
      ...works.map(([operation, method, route, file]) => ({ ...base, operation, method, route, grade: 'W' as const,
        credentialFile: join(directory, file), authorize: (_request: unknown, key: string) => ({ authorization: `Bearer ${key}` }) })),
    ],
    readCalendarGrant: grants.read,
    resolveWorksTarget: async scope => scope.storeId === owner.storeId && scope.actorId === owner.actorId
      ? { userId: 'fixture-owner', calendarId: 'fixture-team' } : undefined,
  };
}
const calendarNaver = storeId === demoIdentity.storeId && providerAccount && origin && privateTokenFile && credentialsDir
  ? calendarBinding({ storeId, providerAccount, origin, privateTokenFile }, credentialsDir) : undefined;
if (callbackToken && callbackToken === posToken) throw new Error('AiCall intake requires a distinct credential');
const briefingSecret = process.env.NAVIS_INSIGHT_CUSTOMER_READ_TOKEN_FILE;
const briefingToken = briefingSecret && readSecret(briefingSecret);
const closureFile = process.env.NAVIS_MARKETING_CUSTOMER_READ_TOKEN_FILE;
const closureToken = closureFile && readSecret(closureFile);
const couponFile = process.env.NAVIS_MARKETING_CUSTOMER_TOKEN_FILE;
const couponToken = couponFile && readSecret(couponFile);
const smsRecipientFile = process.env.NAVIS_MARKETING_CUSTOMER_SMS_TOKEN_FILE;
const smsRecipientToken = smsRecipientFile && readSecret(smsRecipientFile);
if (posToken && [briefingToken, closureToken, couponToken, smsRecipientToken].includes(posToken)) {
  throw new Error('Scoped Customer reads require a distinct credential');
}
const consume = Boolean(process.env.NAVIS_REDIS_URL);
const pool = dbPool('customer');
const app = createCustomerApp(pool, {
  gatewayToken, privateToken, pos, consume, briefingToken, closureToken, couponToken, smsRecipientToken,
  now, calendarNaver,
  booking: readTables ? { readTables, naver } : undefined,
  aicall: storeId && callbackToken ? { storeId, token: callbackToken } : undefined,
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));

const stop = new AbortController();
const redis = consume ? await connectStreams('customer') : undefined;
const workers = redis ? [
  createCustomerConsumer(pool, redis, `customer-${randomUUID()}`),
  ...createCalendarProjectionConsumers(pool, redis, `customer-calendar-${randomUUID()}`, ['inventory', 'insight', 'marketing']),
].map(worker => worker.run(stop.signal)) : [];
app.addHook('onClose', async () => {
  stop.abort();
  redis?.close();
  await Promise.all(workers);
  await pool.end();
});
await listen(app);
