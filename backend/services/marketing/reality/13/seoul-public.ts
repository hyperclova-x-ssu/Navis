import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const endpoint = 'http://openapi.seoul.go.kr:8088';
export const sangdoRegion = '서울 동작구 상도동';
export const sangdoDongs = ['11590530', '11590540', '11590550', '11590560'];
const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
export const seoulDay = (at: Date) => dateFmt.format(at);
const dataset = (service: string, id: number) => ({
  service, sourceUrl: `https://data.seoul.go.kr/dataList/OA-${id}/S/1/datasetView.do`,
});
export const seoulDatasets = {
  events: dataset('culturalEventInfo', 15486),
  general: dataset('LOCALDATA_072404_DJ', 18671),
  rest: dataset('LOCALDATA_072405_DJ', 18696),
  population: dataset('Spop250mLocalResdDong', 23016),
};
export type SeoulDataset = keyof typeof seoulDatasets;
type Row = Record<string, unknown>;
const object = (value: unknown): Row | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
const unavailable = () => new Error('Seoul public data is unavailable');

export function seoulProvider(key: string, transport = fetch) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error('Seoul Open Data credential is invalid');
  return {
    async page(name: SeoulDataset, first: number, last: number, filters: readonly string[] = []) {
      const { service } = seoulDatasets[name];
      const query = filters.length ? '/' + filters.map(encodeURIComponent).join('/') : '';
      try {
        const response = await transport(`${endpoint}/${key}/json/${service}/${first}/${last}${query}`, {
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw unavailable();
        const envelope = object(await response.json());
        const data = object(envelope?.[service]);
        const code = object(data?.RESULT ?? envelope?.RESULT)?.CODE;
        if (code === 'INFO-200') return { total: 0, rows: [] };
        const total = data?.list_total_count;
        const rows = Array.isArray(data?.row) ? data.row.map(object) : [];
        if (code !== 'INFO-000' || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
          || rows.length > last - first + 1 || rows.some(row => !row) || (total >= first && !rows.length)) throw unavailable();
        return { total, rows: rows as Row[] };
      } catch {
        // The request URL contains the credential and must stay out of exception logs.
        throw unavailable();
      }
    },
  };
}
export type SeoulProvider = ReturnType<typeof seoulProvider>;

export async function configureSeoulPublic(env: NodeJS.ProcessEnv) {
  const mode = env.NAVIS_SEOUL_PUBLIC_DATA_MODE ?? 'off';
  if (mode === 'off') return undefined;
  if (mode !== 'live' || !env.NAVIS_SEOUL_OPENAPI_KEY_FILE) throw new Error('Seoul Open Data configuration is incomplete');
  const key = await readFile(env.NAVIS_SEOUL_OPENAPI_KEY_FILE, 'utf8').catch(() => {
    throw new Error('Seoul Open Data credential file is unavailable');
  });
  return seoulProvider(key.trim());
}

export async function allSeoulRows(provider: SeoulProvider, name: SeoulDataset, filters?: readonly string[]) {
  const rows: Row[] = [];
  const size = 1000;
  const maxRows = name === 'population' ? 8000 : 50000;
  for (let first = 1; first <= maxRows; first += size) {
    const page = await provider.page(name, first, first + size - 1, filters);
    rows.push(...page.rows);
    if (page.total > maxRows) throw unavailable();
    if (first + size > page.total) return rows;
    if (page.rows.length !== size) throw unavailable();
  }
  throw unavailable();
}

const tidy = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const clip = (value: string, size: number) => value.length > size ? value.slice(0, size - 1) + '…' : value;
const decode = (value: unknown) => tidy(value).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const date = (value: unknown) => {
  const input = tidy(value).slice(0, 10).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
  const stamp = new Date(`${input}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(input) && Number.isFinite(+stamp) && stamp.toISOString().startsWith(input) ? input : '';
};
const from = (at: Date) => seoulDay(new Date(+at - 180 * 86400000));

function stableId(name: string) {
  const namespace = Buffer.from('b7a4f0d24f375c1e9a551b9c0b2f6d13', 'hex');
  const hash = createHash('sha1').update(namespace).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type SeoulChange = {
  id: string; kind: 'festival' | 'food-license'; changeType?: 'opening' | 'closure';
  title: string; authority: string; referenceDate: string; sourceUrl: string;
};

export function eventRows(rows: readonly Row[], at: Date): SeoulChange[] {
  const earliest = from(at);
  return rows.flatMap(row => {
    const place = decode(row.PLACE);
    const referenceDate = date(row.STRTDATE);
    const name = decode(row.TITLE);
    const category = tidy(row.CODENAME);
    const url = URL.parse(tidy(row.HMPG_ADDR).replace(/^http:/, 'https:'));
    if (tidy(row.GUNAME) !== '동작구' || !/상도|숭실/.test(place) || referenceDate < earliest || !name || !category
      || !url || url.origin !== 'https://culture.seoul.go.kr' || url.username || url.password) return [];
    const suffix = ` · ${clip(place, 40)}`;
    const title = clip(`[${category}] ${name}`, 160 - suffix.length) + suffix;
    const authority = clip(decode(row.ORG_NAME) || '서울특별시', 100);
    if (`${title}${authority}`.includes('\uFFFD')) return [];
    return [{ id: stableId(`festival:${url.searchParams.get('cultcode') ?? url.href}`), kind: 'festival',
      title, authority, referenceDate, sourceUrl: url.href }];
  });
}

export function licenseRows(rows: readonly Row[], name: 'general' | 'rest', at: Date) {
  const earliest = from(at);
  const today = seoulDay(at);
  let referenceDate = '';
  const changes: SeoulChange[] = [];
  for (const row of rows) {
    const updated = date(row.UPDATEDT);
    if (updated && updated <= today && updated > referenceDate) referenceDate = updated;
    const address = tidy(row.SITEWHLADDR);
    const road = tidy(row.RDNWHLADDR);
    if (!(/^서울특별시 동작구 상도1?동 /.test(address) || (!address && /\(상도1?동[,)]/.test(road)))) continue;
    const number = tidy(row.MGTNO);
    const business = tidy(row.BPLCNM);
    if (!number || !business) continue;
    const label = name === 'general' ? '일반음식점' : '휴게음식점';
    const type = tidy(row.UPTAENM);
    const location = road.replace(/^서울특별시 동작구 /, '').replace(/\s*\(.*\)$/, '').split(',')[0]?.trim()
      || address.replace(/^서울특별시 동작구 /, '');
    const title = clip([business, type ? `${label}(${type})` : label, location].filter(Boolean).join(' · '), 160);
    if (title.includes('\uFFFD')) continue;
    const base = { kind: 'food-license' as const, title, authority: '서울특별시 동작구', sourceUrl: seoulDatasets[name].sourceUrl };
    const opened = date(row.APVPERMYMD);
    const closed = date(row.DCBYMD);
    const status = tidy(row.TRDSTATENM);
    if (opened >= earliest && opened <= today && ['영업/정상', '폐업'].includes(status)) changes.push({
      ...base, id: stableId(`food-license:${number}`), changeType: 'opening', referenceDate: opened,
    });
    if (closed >= earliest && closed <= today && status === '폐업') changes.push({
      ...base, id: stableId(`food-license:closure:${number}`), changeType: 'closure', referenceDate: closed,
    });
  }
  return { rows: changes, referenceDate };
}

export function populationBands(rows: readonly Row[], at: Date) {
  const hours = new Map<string, Map<string, number>>();
  const today = seoulDay(at);
  for (const row of rows) {
    const day = date(row.YMD);
    const hour = tidy(row.TT);
    const dong = tidy(row.H_DNG_CD);
    const population = tidy(row.SPOP);
    if (!day || day > today || !/^(?:[01]\d|2[0-3])$/.test(hour) || !sangdoDongs.includes(dong) || !/^\d+(?:\.\d+)?$/.test(population)) continue;
    const key = `${day}|${hour}`;
    const values = hours.get(key) ?? new Map<string, number>();
    values.set(dong, Number(population));
    hours.set(key, values);
  }
  const bands = new Map<string, { quarter: string; weekday: number; hour: number; sum: number; count: number }>();
  const dates = new Map<string, string>();
  for (const [key, values] of hours) {
    if (values.size !== sangdoDongs.length) continue;
    const day = key.slice(0, 10);
    const hour = Number(key.slice(11));
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
    const quarter = `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
    const bandKey = `${quarter}|${weekday}|${hour}`;
    const band = bands.get(bandKey) ?? { quarter, weekday, hour, sum: 0, count: 0 };
    band.sum += [...values.values()].reduce((sum, value) => sum + value, 0);
    band.count++;
    bands.set(bandKey, band);
    if (day > (dates.get(quarter) ?? '')) dates.set(quarter, day);
  }
  return [...bands.values()].map(({ quarter, weekday, hour, sum, count }) => ({
    quarter, weekday, startHour: hour, endHour: hour + 1, estimate: Math.round(sum / count),
    referenceDate: dates.get(quarter)!, refreshedAt: at.toISOString(), sourceUrl: seoulDatasets.population.sourceUrl,
  }));
}
