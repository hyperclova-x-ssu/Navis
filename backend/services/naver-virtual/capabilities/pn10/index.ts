import { randomInt } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import type {
  GeocodeAddress, GeocodeResult, SearchItems, SearchResult, SearchTrendRequest, SearchTrendResult,
} from '../../../../packages/naver/contracts/pn10/index.ts';

const name = '안숭잘부 카페';
const description = '서울 상도동 커피와 디저트';
const longitude = 126.9554;
const latitude = 37.4958;
const kstDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });
const limits = { blog: 100, cafearticle: 100, news: 100, local: 5 };
const channels = ['blog', 'cafearticle', 'news', 'local'] as const;
const isoDay = /^\d{4}-\d{2}-\d{2}$/;

function dateString(value: unknown): value is string {
  if (typeof value !== 'string' || !isoDay.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(+date) && date.toISOString().slice(0, 10) === value;
}

function intOption(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const number = Number(value);
  return number >= 1 && number <= max ? number : 0;
}

function hasKey(request: FastifyRequest, context: Parameters<PersonaCapability['register']>[1]) {
  const id = context.providerCredential(request, 'keyId');
  const key = context.providerCredential(request, 'key');
  return id !== undefined && key !== undefined && request.headers['x-ncp-apigw-api-key-id'] === id &&
    request.headers['x-ncp-apigw-api-key'] === key;
}

// https://api.ncloud-docs.com/docs/naver-api-hub-overview
function authError(reply: FastifyReply) {
  return reply.code(401).send({ error: { errorCode: '200', message: 'Authentication Failed',
    details: 'Authentication information are missing.' } });
}

const xmlEscape = (value: unknown) => String(value).replace(/[&<>"']/g, (char) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]!);

function searchXml(result: SearchResult<SearchItems[keyof SearchItems]>) {
  const fields = (object: object) => Object.entries(object)
    .map(([key, value]) => `<${key}>${xmlEscape(value)}</${key}>`).join('');
  const { items, ...metadata } = result;
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
    '<title>Naver Open API</title><link>https://search.naver.com</link>' +
    '<description>Naver Search Result</description>' + fields(metadata) +
    items.map((item) => `<item>${fields(item)}</item>`).join('') + '</channel></rss>';
}

function fixtureItems(now: Date): SearchItems {
  const time = now.toUTCString().replace('GMT', '+0000');
  return {
    blog: { title: `<b>${name}</b> 커피 기록`, link: 'https://blog.example.invalid/cafe/1', description,
      bloggername: '안숭잘부 카페', bloggerlink: 'https://blog.example.invalid/cafe',
      postdate: kstDay.format(now).replaceAll('-', '') },
    cafearticle: { title: `<b>${name}</b> 동네 카페 소식`, link: 'https://cafe.example.invalid/sangdo/1',
      description, cafename: '상도동 카페 모임', cafeurl: 'https://cafe.example.invalid/sangdo' },
    news: { title: `<b>${name}</b> 상도동 카페 소식`, link: 'https://news.example.invalid/sangdo/1',
      originallink: 'https://local-news.example.invalid/sangdo/1', description, pubDate: time },
    local: { title: name, link: 'https://place.example.invalid/cafe', category: '카페,디저트>카페',
      description: '', telephone: '', address: '서울 동작구 상도동 999-12', roadAddress: '',
      mapx: String(Math.round(longitude * 10_000_000)), mapy: String(Math.round(latitude * 10_000_000)) },
  };
}

function searchMatches(query: string, item: SearchItems[keyof SearchItems]) {
  return query.trim().toLowerCase().split(/\s+/).every((word) =>
    `${item.title} ${item.description} ${description}`.toLowerCase().includes(word));
}

function trendInput(body: unknown): body is SearchTrendRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { startDate, endDate, timeUnit, keywordGroups, device, gender, ages, ...unknown } =
    body as Partial<SearchTrendRequest>;
  return Object.keys(unknown).length === 0 && dateString(startDate) && startDate >= '2016-01-01' &&
    dateString(endDate) && startDate <= endDate && ['date', 'week', 'month'].includes(timeUnit ?? '') &&
    Array.isArray(keywordGroups) && keywordGroups.length >= 1 && keywordGroups.length <= 5 &&
    keywordGroups.every((group) => group && Object.keys(group).length === 2 &&
      typeof group.groupName === 'string' && group.groupName.trim().length > 0 &&
      Array.isArray(group.keywords) && group.keywords.length >= 1 && group.keywords.length <= 20 &&
      group.keywords.every((key: unknown) => typeof key === 'string' && key.trim().length > 0)) &&
    (device === undefined || ['pc', 'mo'].includes(device)) &&
    (gender === undefined || ['m', 'f'].includes(gender)) &&
    (ages === undefined || (Array.isArray(ages) && ages.every((age) =>
      typeof age === 'string' && /^(?:[1-9]|1[01])$/.test(age))));
}

type TrendObservation = { keyword: string; day: string; searches: number };
function trendPeriod(day: string, start: string, unit: SearchTrendRequest['timeUnit']) {
  const date = new Date(day);
  if (unit === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  if (unit === 'month') date.setUTCDate(1);
  const first = date.toISOString().slice(0, 10);
  return first < start ? start : first;
}

function calculateTrend(input: SearchTrendRequest, observations: TrendObservation[]): SearchTrendResult {
  const { startDate, endDate, timeUnit, keywordGroups } = input;
  let maximum = 0;
  const groups = keywordGroups.map(({ groupName, keywords }) => {
    const matches = new Set(keywords.map((keyword) => keyword.trim().toLowerCase()));
    const totals = new Map<string, number>();
    for (const row of observations) {
      if (row.day < startDate || row.day > endDate || !matches.has(row.keyword)) continue;
      const period = trendPeriod(row.day, startDate, timeUnit);
      const total = (totals.get(period) ?? 0) + row.searches;
      totals.set(period, total);
      maximum = Math.max(maximum, total);
    }
    return { title: groupName, keywords, totals };
  });
  return { startDate, endDate, timeUnit, results: groups.map(({ title, keywords, totals }) => ({
    title, keywords, data: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([period, count]) => ({ period, ratio: maximum ? Number((100 * count / maximum).toFixed(5)) : 0 })),
  })) };
}

function coordinateDistance(coordinate: string | undefined) {
  if (!coordinate) return 0;
  const [x, y] = coordinate.split(',').map(Number) as [number, number];
  const radians = Math.PI / 180;
  const h = Math.sin((y - latitude) * radians / 2) ** 2 +
    Math.cos(y * radians) * Math.cos(latitude * radians) * Math.sin((x - longitude) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, h)));
}

function geocodedAddress(distance: number, language: unknown): GeocodeAddress {
  const english = language === 'eng';
  const jibunAddress = '서울특별시 동작구 상도동 999-12';
  const englishAddress = '999-12 Sangdo-dong, Dongjak-gu, Seoul';
  const names = [english ? 'Seoul' : '서울특별시', english ? 'Dongjak-gu' : '동작구',
    english ? 'Sangdo-dong' : '상도동', '', '', '', '', '999-12', ''];
  const types = ['SIDO', 'SIGUGUN', 'DONGMYUN', 'RI', 'ROAD_NAME', 'BUILDING_NUMBER', 'BUILDING_NAME',
    'LAND_NUMBER', 'POSTAL_CODE'];
  return {
    roadAddress: '', jibunAddress: english ? englishAddress : jibunAddress, englishAddress,
    addressElements: types.map((type, index) => ({
      types: [type], longName: names[index]!, shortName: index === 0 && !english ? '서울' : names[index]!, code: '',
    })),
    x: String(longitude), y: String(latitude), distance,
  };
}

export const personaCapability: PersonaCapability = {
  id: 'pn10',
  migrations: [{
    id: 'pn10-observations-001',
    up: `
      CREATE TABLE naver_virtual.pn10_trend (
        account_id text NOT NULL, keyword text NOT NULL, day date NOT NULL,
        searches integer NOT NULL CHECK (searches >= 0),
        PRIMARY KEY (account_id, day, keyword)
      );
      ALTER TABLE naver_virtual.pn10_trend ENABLE ROW LEVEL SECURITY;
      CREATE POLICY account_scope ON naver_virtual.pn10_trend
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      GRANT SELECT ON naver_virtual.pn10_trend TO nvirtual_run;
    `,
    down: 'DROP TABLE naver_virtual.pn10_trend;',
  }],
  async seed(client, { accountId, now }) {
    await client.query('DELETE FROM naver_virtual.pn10_trend WHERE account_id = $1', [accountId]);
    await client.query(`
      INSERT INTO naver_virtual.pn10_trend (account_id, keyword, day, searches)
      SELECT $1, entries.keyword, $2::date - entries.days_ago, entries.searches
      FROM (VALUES ('커피', 2, 40), ('커피', 1, 50), ('카페', 2, 24), ('카페', 1, 31),
        ('카페라떼', 2, 15), ('카페라떼', 1, 29), ('아메리카노', 2, 30), ('아메리카노', 1, 34))
        AS entries(keyword, days_ago, searches)
    `, [accountId, kstDay.format(now)]);
  },
  register(app, context) {
    // https://api.ncloud-docs.com/docs/naver-api-hub-search-{blog,cafearticle,news,local}
    for (const channel of channels) {
      app.get<{ Querystring: Record<string, string> }>(`/search/v1/${channel}`, {
        config: { personaOperation: `pn10.${channel}` },
      }, (request, reply) => {
        if (!hasKey(request, context)) return authError(reply);
        const { query, display: size, start: offset, sort, format = 'json', ...unknown } = request.query;
        const error = (errorCode: string, errorMessage: string) => reply.code(400).send({ errorCode, errorMessage });
        if (typeof query !== 'string' || !query.trim() || !['xml', 'json'].includes(format) || Object.keys(unknown).length) {
          return error('SE01', 'Incorrect query request (잘못된 쿼리요청입니다.)');
        }
        const local = channel === 'local';
        const display = intOption(size, local ? 1 : 10, limits[channel]);
        if (!display) return error('SE02', 'Invalid display value (부적절한 display 값입니다.)');
        const start = intOption(offset, 1, local ? 1 : 1000);
        if (!start) return error('SE03', 'Invalid start value (부적절한 start 값입니다.)');
        if (sort !== undefined && !(local ? ['random', 'comment'] : ['sim', 'date']).includes(sort)) {
          return error('SE04', 'Invalid sort value (부적절한 sort 값입니다.)');
        }
        const now = context.now();
        const item = fixtureItems(now)[channel];
        const total = searchMatches(query, item) ? 1 : 0;
        const items = total && start === 1 ? [item] : [];
        const data = { lastBuildDate: now.toUTCString().replace('GMT', '+0000'), total, start, display: items.length, items };
        return format === 'xml' ? reply.type('application/xml; charset=utf-8').send(searchXml(data)) : reply.send(data);
      });
    }

    // https://api.ncloud-docs.com/docs/naver-api-hub-search-trend
    app.post('/search-trend/v1/search', { config: { personaOperation: 'pn10.trend' } }, async (request, reply) => {
      if (!hasKey(request, context)) return authError(reply);
      const input = request.body;
      if (!trendInput(input)) {
        const timestamp = new Date(+context.now() + 9 * 3_600_000).toISOString().slice(0, 19) + '+09:00';
        return reply.code(400).send({ errMsg: 'TypeError: Invalid request body',
          errId: `${timestamp}/${randomInt(100_000_000, 1_000_000_000)}-${randomInt(10_000_000, 100_000_000)}` });
      }
      // The synthetic observation series has no device, gender or age attribution.
      if (input.device || input.gender || input.ages?.length) return calculateTrend(input, []);
      const observations = await context.transaction(request, async (client) => {
        const result = await client.query<TrendObservation>(`
          SELECT keyword, day::text, searches FROM naver_virtual.pn10_trend
          WHERE account_id = $1 AND day BETWEEN $2 AND $3 ORDER BY day, keyword
        `, [context.accountId(request), input.startDate, input.endDate]);
        return result.rows;
      });
      return calculateTrend(input, observations);
    });

    // https://api.ncloud-docs.com/docs/application-maps-geocoding
    app.get<{ Querystring: Record<string, string> }>('/map-geocode/v2/geocode', {
      config: { personaOperation: 'pn10.geocode' },
    }, (request, reply) => {
      if (!hasKey(request, context)) return authError(reply);
      const { query, coordinate, filter, language = 'kor', page: pageParam, count: countParam, ...unknown } = request.query;
      const page = intOption(pageParam, 1, Number.MAX_SAFE_INTEGER);
      const count = intOption(countParam, 10, 100);
      const [x, y] = typeof coordinate === 'string' ? coordinate.split(',').map(Number) : [];
      const validCoordinate = coordinate === undefined || (typeof coordinate === 'string' &&
        /^-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?$/.test(coordinate) && Math.abs(x!) <= 180 && Math.abs(y!) <= 90);
      const validFilter = filter === undefined || (typeof filter === 'string' && /^(?:HCODE|BCODE)@\d{10}(?:;\d{10})*$/.test(filter));
      if (typeof query !== 'string' || !query.trim() || !page || !count || !validCoordinate || !validFilter ||
          !['kor', 'eng'].includes(language) || !request.headers.accept?.includes('application/json') || Object.keys(unknown).length) {
        return reply.code(400).send({ status: 'INVALID_REQUEST' });
      }
      const matchingArea = !filter || filter.slice(filter.indexOf('@') + 1).split(';').includes(
        filter.startsWith('HCODE') ? '1159052000' : '1159010200',
      );
      const totalCount = /상도동\s*999-12|999-12\s+sangdo-dong/i.test(query) && matchingArea ? 1 : 0;
      const addresses = totalCount && page === 1 ? [geocodedAddress(coordinateDistance(coordinate), language)] : [];
      const response: GeocodeResult = { status: 'OK', meta: { totalCount, page, count: addresses.length }, addresses, errorMessage: '' };
      return response;
    });
  },
};
