import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import { adsFields, type AdsDailyStats, type AdsField, type AdsMetrics, type AdsSummaryStats } from
  '../../../../packages/naver/contracts/pn12/index.ts';
import { shiftDay, validDay } from './dates.ts';

type Context = Parameters<PersonaCapability['register']>[1];
type AdRow = { day: string; ad_id: string; impressions: number; clicks: number; cost: number };
const kstDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
const authorizedRecords = new Set(['cmp-a001-01-000000000000001', 'cmp-a001-01-000000000000002']);

function json(value: unknown): unknown {
  if (typeof value !== 'string') return;
  try {
    return JSON.parse(value);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

function dateRange(preset: string | undefined, time: string | undefined, now: Date) {
  const today = kstDay.format(now);
  const yesterday = shiftDay(today, -1);
  if (time !== undefined) {
    const value = json(time);
    if (preset !== undefined || !value || typeof value !== 'object' || Array.isArray(value)) return;
    const { since, until, ...extra } = value as Record<string, unknown>;
    if (Object.keys(extra).length || !validDay(since) || !validDay(until) || since > until || until > today) return;
    return { since, until };
  }
  if (preset === 'today') return { since: today, until: today };
  if (preset === 'yesterday') return { since: yesterday, until: yesterday };
  if (preset === 'last7days' || preset === 'last30days') {
    return { since: shiftDay(today, preset === 'last7days' ? -7 : -30), until: yesterday };
  }
  if (preset === 'lastweek') {
    const monday = shiftDay(today, -((new Date(today).getUTCDay() + 6) % 7));
    return { since: shiftDay(monday, -7), until: shiftDay(monday, -1) };
  }
  if (preset === 'lastmonth' || preset === 'lastquarter') {
    const first = new Date(today);
    first.setUTCDate(1);
    if (preset === 'lastquarter') first.setUTCMonth(first.getUTCMonth() - first.getUTCMonth() % 3);
    const until = shiftDay(first.toISOString().slice(0, 10), -1);
    first.setUTCMonth(first.getUTCMonth() - (preset === 'lastmonth' ? 1 : 3));
    return { since: first.toISOString().slice(0, 10), until };
  }
}

function validSignature(request: FastifyRequest, context: Context, now: Date) {
  const timestamp = request.headers['x-timestamp'];
  const signature = request.headers['x-signature'];
  const key = context.providerCredential(request, 'key');
  const keyId = context.providerCredential(request, 'keyId');
  if (!key || !keyId || request.headers['x-api-key'] !== keyId || typeof timestamp !== 'string' ||
      !/^\d{13}$/.test(timestamp) || Math.abs(+now - Number(timestamp)) > 300_000 || typeof signature !== 'string') return false;
  const expected = createHmac('sha256', key).update(`${timestamp}.GET./stats`).digest('base64');
  return Buffer.byteLength(signature) === expected.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function selectMetrics(fields: AdsField[], rows: AdRow[]): AdsMetrics {
  const sums = rows.reduce((metrics, row) => ({
    impCnt: metrics.impCnt + row.impressions, clkCnt: metrics.clkCnt + row.clicks, salesAmt: metrics.salesAmt + row.cost,
  }), { impCnt: 0, clkCnt: 0, salesAmt: 0 });
  return Object.fromEntries(fields.map((field) => [field, sums[field]]));
}

export function registerAds(app: FastifyInstance, context: Context) {
  // https://naver.github.io/searchad-apidoc/ (Stat) and https://github.com/naver/searchad-apidoc/blob/master/java-sample/src/main/java/com/naver/searchad/api/rest/Stats.java
  app.get<{ Querystring: Record<string, string> }>('/stats', { config: { personaOperation: 'pn12.ads' } }, async (request, reply) => {
    const now = context.now();
    const customer = context.providerCredential(request, 'customerId');
    if (!customer || request.headers['x-customer'] !== customer || !validSignature(request, context, now)) {
      return reply.code(403).send({ status: 403, title: 'Forbidden' });
    }
    const { id, ids, fields: fieldParam, timeRange, datePreset, timeIncrement = 'allDays', ...extra } = request.query;
    const fields = json(fieldParam);
    const period = dateRange(datePreset, timeRange, now);
    const daily = timeIncrement === '1';
    const records = typeof id === 'string' && ids === undefined ? [id] :
      id === undefined && typeof ids === 'string' ? ids.split(',') : [];
    if (Object.keys(extra).length || !period || !records.length || records.length > 100 ||
        new Set(records).size !== records.length || (daily && (records.length !== 1 || !id)) ||
        (!daily && timeIncrement !== 'allDays') || !Array.isArray(fields) || !fields.length ||
        !fields.every((field): field is AdsField => adsFields.includes(field))) {
      return reply.code(400).send({ code: 1002, title: 'Invalid request' });
    }
    if (records.some((record) => !authorizedRecords.has(record))) {
      return reply.code(404).send({ code: 1001, title: 'Cannot find the requested resource(ID or entity).' });
    }
    const { rows } = await context.transaction(request, async (client) => client.query<AdRow>(`
      SELECT ad_id, day::text, impressions, clicks, cost FROM naver_virtual.pn12_ads
      WHERE account_id = $1 AND ad_id = ANY($2) AND day BETWEEN $3 AND $4 ORDER BY day, ad_id
    `, [context.accountId(request), records, period.since, period.until]));
    if (daily) {
      const data: AdsDailyStats = { summary: { dateStart: period.since, dateEnd: period.until },
        data: rows.map((row) => ({ dateStart: row.day, dateEnd: row.day, ...selectMetrics(fields, [row]) })) };
      return data;
    }
    const days = (Date.parse(period.until) - Date.parse(period.since)) / 86_400_000 + 1;
    const data: AdsSummaryStats = { data: records.flatMap((record) => {
      const observed = rows.filter((row) => row.ad_id === record);
      return observed.length === days ? [{ id: record, ...selectMetrics(fields, observed) }] : [];
    }) };
    return data;
  });
}
