import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { withStoreTransaction } from '../store-transaction.ts';
import {
  ForecastInputConflict, readForecast, readForecastBusinessDay, saveForecast, type ForecastKey, type MenuBaseline,
} from './forecast.ts';

const root = '/internal/v1/inventory/stores/:storeId';
const resource = root + '/forecasts/:targetDate/:modelVersion';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const model = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const maxQuantity = BigInt(Number.MAX_SAFE_INTEGER) * 4n;
const digest = (token: string) => createHash('sha256').update(token).digest();

function isDate(value: string) {
  const date = new Date(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000')
    && Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function authorize(
  req: FastifyRequest<{ Params: { storeId: string } }>, reply: FastifyReply,
  workload: Buffer | undefined, gateway?: Buffer,
) {
  reply.header('cache-control', 'no-store');
  const bearer = req.headers.authorization?.match(/^Bearer ([^\s,]{1,512})$/i)?.[1];
  const token = bearer ? digest(bearer) : undefined;
  const isWorkload = token && workload && timingSafeEqual(token, workload);
  const isGateway = token && gateway && timingSafeEqual(token, gateway);
  if (!isWorkload && !isGateway) return reply.code(401).send({ code: 'UNAUTHENTICATED' });

  const { storeId } = req.params;
  const actor = req.headers['x-navis-user-id'];
  if (!uuid.test(storeId) || req.headers['x-navis-store-id'] !== storeId
    || (isGateway && (req.headers['x-navis-store-role'] !== 'owner' || typeof actor !== 'string' || !uuid.test(actor)))) {
    return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
  }
}

function parseMenus(body: unknown): MenuBaseline[] | null {
  if (!body || typeof body !== 'object' || Object.keys(body).length !== 1 || !('menus' in body)
    || !Array.isArray(body.menus) || !body.menus.length || body.menus.length > 1000) return null;
  const result: MenuBaseline[] = [];
  const seen = new Set<string>();
  for (const menu of body.menus) {
    if (!menu || typeof menu !== 'object' || Object.keys(menu).length !== 2 || typeof menu.menuId !== 'string'
      || !uuid.test(menu.menuId) || seen.has(menu.menuId) || typeof menu.fourWeekQuantity !== 'string'
      || !/^(0|[1-9]\d{0,16})$/.test(menu.fourWeekQuantity) || BigInt(menu.fourWeekQuantity) > maxQuantity) return null;
    seen.add(menu.menuId);
    result.push({ menuId: menu.menuId, fourWeekQuantity: menu.fourWeekQuantity });
  }
  return result;
}

export function registerForecastRoutes(
  app: FastifyInstance, pool: Pool, gatewayToken: string, forecastToken: string | undefined, now: () => Date,
) {
  if (forecastToken === gatewayToken) throw new Error('Inventory workload credentials must be distinct');
  const gateway = digest(gatewayToken);
  const workload = forecastToken ? digest(forecastToken) : undefined;
  const invalid = (reply: FastifyReply) => reply.code(400).send({ code: 'INVALID_REQUEST' });

  app.get<{ Params: ForecastKey }>(resource, {
    onRequest: async (req, reply) => authorize(req, reply, workload, gateway),
  }, async ({ params }, reply) => {
    if (!isDate(params.targetDate) || !model.test(params.modelVersion)) return invalid(reply);
    return withStoreTransaction(pool, params.storeId, db => readForecast(db, params), { readOnly: true });
  });

  if (!workload) return;

  app.get<{ Params: { storeId: string }; Querystring: { at?: string } }>(root + '/forecast-business-day', {
    onRequest: async (req, reply) => authorize(req, reply, workload),
  }, async (req, reply) => {
    const { at } = req.query;
    if (Object.keys(req.query).length !== 1 || typeof at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(at)) return invalid(reply);
    const timestamp = new Date(at);
    if (!Number.isFinite(+timestamp) || timestamp.toISOString() !== at || at.startsWith('0000')) return invalid(reply);
    const { storeId } = req.params;
    return withStoreTransaction(pool, storeId, db => readForecastBusinessDay(db, storeId, timestamp), { readOnly: true });
  });

  app.put<{ Params: ForecastKey }>(resource, {
    onRequest: async (req, reply) => authorize(req, reply, workload),
  }, async ({ params, body }, reply) => {
    if (!isDate(params.targetDate) || !model.test(params.modelVersion)) return invalid(reply);
    const menus = parseMenus(body);
    if (!menus) return invalid(reply);
    try {
      return await withStoreTransaction(pool, params.storeId, db => saveForecast(db, params, menus, now()));
    } catch (error) {
      if (!(error instanceof ForecastInputConflict)) throw error;
      return reply.code(409).send({ code: 'CONFLICT', reason: 'IDEMPOTENCY_MISMATCH' });
    }
  });
}
