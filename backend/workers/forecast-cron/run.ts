const dayMs = 86_400_000;
const modelVersion = 'weekday-4w-v1';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

type Endpoint = { baseUrl: string; token: string };
type Result = {
  targetDate: string | null;
  modelVersion: string;
  status: 'ready' | 'no_data';
  results: Array<{ scope: 'store' | 'menu' | 'ingredient'; targetId: string | null; expected: string }>;
};
type Config = { storeId: string; insight: Endpoint; inventory: Endpoint; now?: () => Date };

function asDate(value: string) {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')
    || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid forecast business day');
  return date;
}

async function request(endpoint: Endpoint, path: string, storeId: string, body?: object): Promise<unknown> {
  const url = new URL(path, endpoint.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid forecast endpoint');
  const headers: Record<string, string> = {
    authorization: `Bearer ${endpoint.token}`,
    'x-navis-store-id': storeId,
  };
  if (body) headers['content-type'] = 'application/json';
  const response = await fetch(url, {
    method: body ? 'PUT' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Forecast dependency returned HTTP ${response.status}`);
  }
  return response.json();
}

function salesBaseline(sales: unknown, comparable: string[]) {
  if (!record(sales) || !Array.isArray(sales.days)) throw new Error('Invalid Insight sales response');
  const totals = new Map<string, bigint>();
  const observed = new Set<string>();

  for (const day of sales.days) {
    if (!record(day) || typeof day.businessDate !== 'string' || !Array.isArray(day.menu)) {
      throw new Error('Invalid Insight sales day');
    }
    if (!comparable.includes(day.businessDate)) continue;
    if (observed.has(day.businessDate)) throw new Error('Duplicate Insight sales day');
    observed.add(day.businessDate);
    const seen = new Set<string>();
    for (const line of day.menu) {
      if (!record(line) || typeof line.menuId !== 'string' || !uuid.test(line.menuId) || seen.has(line.menuId)
        || typeof line.quantity !== 'number' || !Number.isSafeInteger(line.quantity) || line.quantity < 0) {
        throw new Error('Invalid Insight sales quantity');
      }
      seen.add(line.menuId);
      totals.set(line.menuId, (totals.get(line.menuId) ?? 0n) + BigInt(line.quantity));
    }
  }

  if (observed.size !== comparable.length || !totals.size) return null;
  return [...totals].map(([menuId, total]) => ({ menuId, fourWeekQuantity: total.toString() }));
}

/** Run once for a configured store. The scheduler owns when to run it. */
export async function runForecast({ storeId, insight, inventory, now = () => new Date() }: Config): Promise<Result> {
  if (!uuid.test(storeId)) throw new Error('Invalid forecast store ID');
  const root = `/internal/v1/inventory/stores/${storeId}`;
  const at = now().toISOString();
  const day = await request(inventory, `${root}/forecast-business-day?at=${encodeURIComponent(at)}`, storeId);
  if (!record(day) || (day.targetDate !== null && typeof day.targetDate !== 'string')) {
    throw new Error('Invalid inventory business day response');
  }
  const { targetDate } = day;
  const noData = { targetDate, modelVersion, status: 'no_data' as const, results: [] };
  if (targetDate === null) return noData;

  const target = +asDate(targetDate);
  const previous = (days: number) => new Date(target - days * dayMs).toISOString().slice(0, 10);
  const comparable = [28, 21, 14, 7].map(previous);
  const sales = await request(insight,
    `/internal/v1/insight/stores/${storeId}/sales?from=${comparable[0]}&to=${previous(1)}`, storeId);
  const menus = salesBaseline(sales, comparable);
  if (!menus) return noData;

  const result = await request(inventory, `${root}/forecasts/${targetDate}/${modelVersion}`, storeId, { menus });
  if (!record(result) || result.targetDate !== targetDate || result.modelVersion !== modelVersion
    || (result.status !== 'ready' && result.status !== 'no_data') || !Array.isArray(result.results)) {
    throw new Error('Invalid inventory forecast response');
  }
  return { targetDate, modelVersion, status: result.status, results: result.results };
}
