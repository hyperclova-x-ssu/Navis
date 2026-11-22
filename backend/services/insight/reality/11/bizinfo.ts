import { readFile } from 'node:fs/promises';
import { hash, InsightError, isDate } from '../../scope.ts';

const endpoint = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const field = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const unavailable = () => new InsightError(503, 'GRANT_SOURCE_UNAVAILABLE');
const date = (value: string) => value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
const keyToken = /^[^\s"']+$/u;

export type GrantNotice = {
  noticeId: string; providerId: string; source: 'bizinfo'; title: string; agency: string; summary: string;
  officialUrl: string; startsOn: string | null; deadline: string | null; tags: string[];
  target: string; applicationMethod: string;
};

export function parseBizinfo(value: unknown): GrantNotice[] {
  const jsonArray = object(value)?.jsonArray;
  const items = object(jsonArray)?.item ?? jsonArray ?? value;
  if (!Array.isArray(items) || items.length > 2000) throw unavailable();
  const notices = new Map<string, GrantNotice>();
  for (const raw of items) {
    const row = object(raw);
    const providerId = field(row?.pblancId, 64) || field(row?.seq, 64);
    const title = field(row?.pblancNm, 300) || field(row?.title, 300);
    const agency = field(row?.jrsdInsttNm, 200) || field(row?.author, 200);
    const url = URL.parse(field(row?.pblancUrl, 2000) || field(row?.link, 2000), endpoint);
    if (!/^PBLN_[0-9]+$/.test(providerId) || !title || !agency || !url
      || url.protocol !== 'https:' || !['www.bizinfo.go.kr', 'bizinfo.go.kr'].includes(url.host)
      || url.username || url.password || url.searchParams.get('pblancId') !== providerId) continue;
    const [first = '', last = ''] = (field(row?.reqstBeginEndDe, 64) || field(row?.reqstDt, 64)).split(/\s*~\s*/).map(date);
    const tags = [...new Set((field(row?.hashTags, 2000) || field(row?.hashtags, 2000))
      .split(/[,#]/).map(tag => tag.trim().normalize('NFKC')).filter(Boolean))];
    const digest = hash(`bizinfo:${providerId}`);
    const noticeId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    notices.set(providerId, { noticeId, providerId, source: 'bizinfo', title, agency,
      summary: field(row?.bsnsSumryCn, 4000) || field(row?.description, 4000), target: field(row?.trgetNm, 200),
      applicationMethod: field(row?.reqstMthPapersCn, 1000), officialUrl: url.href, startsOn: isDate(first) ? first : null,
      deadline: isDate(last) ? last : null, tags });
  }
  if (items.length && !notices.size) throw unavailable();
  return [...notices.values()];
}

const seoul = new Set(['서울', '서울시', '서울특별시']);
const otherAreas = new Set([
  '부산', '부산광역시', '대구', '대구광역시', '인천', '인천광역시', '광주', '광주광역시',
  '대전', '대전광역시', '울산', '울산광역시', '세종', '세종특별자치시', '경기', '경기도',
  '강원', '강원도', '강원특별자치도', '충북', '충청북도', '충남', '충청남도',
  '전북', '전라북도', '전북특별자치도', '전남', '전라남도', '전남광주',
  '경북', '경상북도', '경남', '경상남도', '제주', '제주도', '제주특별자치도',
]);
const otherLocality = /(?:^|[\s[(])(?:부산|대구|인천|광주|대전|울산|세종|경기|강원|충[남북]|전[남북]|경[남북]|제주|경상[남북]|전라[남북]|충청[남북])(?:(?:광역|특별자치)?시|(?:특별자치)?도|지역|혁신도시|소재)/u;
const cafeIndustries = new Set(['카페', '음식점', '외식', '식품']);
const candidateTopics = ['소상공인', '자영업', '음식점', '외식', '식품', '카페', '창업', '디지털 전환'];

function grantArea(fields: readonly string[]) {
  const names = fields.map(value => value.trim().split(/\s+/u)[0] ?? '');
  if (fields.some(value => /^(?:전국|전\s*지역)(?:\s|$)/u.test(value.trim()))) return '전국';
  if (names.some(value => seoul.has(value))) return '서울';
  if (names.some(value => otherAreas.has(value))) return 'other';
  return undefined;
}

type MatchedNotice = GrantNotice & { matchTier: 'exact' | 'related'; matchReason: string };
export function matchNotices(notices: readonly GrantNotice[], region: string, industry: string, live = false) {
  const area = region.normalize('NFKC');
  const business = industry.normalize('NFKC');
  const matchesExact = (notice: GrantNotice) => notice.tags.includes(area) && notice.tags.includes(business);
  if (!live || !seoul.has(area)) return notices.filter(matchesExact);

  const exact: MatchedNotice[] = [];
  const related: MatchedNotice[] = [];
  for (const notice of notices) {
    const title = notice.title.normalize('NFKC');
    const heading = /^(?:\[[^\]]+\]\s*)+/u.exec(title)?.[0] ?? '';
    const labels = [...heading.matchAll(/\[([^\]]+)\]/gu)].flatMap(match => match[1]!.split(/[·,/]/u));
    const publicArea = grantArea([title, notice.target]);
    const localOnly = otherLocality.test(title) || otherLocality.test(notice.target) || otherAreas.has(notice.agency.trim());
    const scope = grantArea(labels) ?? publicArea ?? (localOnly ? 'other' : grantArea(notice.tags));
    if (!scope || scope === 'other') continue;
    if (matchesExact(notice)) {
      exact.push({ ...notice, matchTier: 'exact', matchReason: `${scope} · ${business}` });
      continue;
    }
    if (!cafeIndustries.has(business)) continue;
    const publicFields = [title, ...notice.tags, notice.target].map(value => value.replace(/\s+/gu, ''));
    const topic = candidateTopics.find(value => publicFields.some(field => field.includes(value.replace(' ', ''))));
    if (topic) related.push({ ...notice, matchTier: 'related', matchReason: `${scope} · ${topic}` });
  }
  return [...exact, ...related];
}

export type GrantProvider = { mode: 'fake' | 'live'; load(region: string): Promise<GrantNotice[]> };
export async function configureBizinfo(env: NodeJS.ProcessEnv): Promise<GrantProvider> {
  const mode = env.NAVIS_BIZINFO_MODE ?? 'fake';
  if (mode === 'fake') return bizinfoProvider();
  const keyFile = env.NAVIS_BIZINFO_KEY_FILE;
  if (mode !== 'live' || env.NAVIS_BIZINFO_A6_APPROVED !== '1' || env.NAVIS_BIZINFO_TERMS_ACCEPTED !== '1'
    || !keyFile) throw new Error('Bizinfo live configuration is incomplete');
  return { mode, async load(region) {
    const key = (await readFile(keyFile, 'utf8').catch(() => '')).trim();
    if (!keyToken.test(key)) throw unavailable();
    return bizinfoProvider({ mode, a6: true, termsAccepted: true, key }).load(region);
  } };
}

export function bizinfoProvider(options: {
  mode?: 'fake' | 'live'; a6?: boolean; termsAccepted?: boolean; key?: string; fetch?: typeof fetch;
} = {}): GrantProvider {
  const mode = options.mode ?? 'fake';
  const key = options.key?.trim();
  if (mode === 'live' && !(options.a6 && options.termsAccepted && key && keyToken.test(key))) {
    throw new Error('Bizinfo live configuration is incomplete');
  }
  return { mode, async load(region) {
    try {
      if (mode === 'fake') return parseBizinfo(JSON.parse(await readFile(new URL('./bizinfo.fixture.json', import.meta.url), 'utf8')));
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ crtfcKey: key!, dataType: 'json', searchCnt: '2000', pageUnit: '2000', pageIndex: '1', hashtags: region }).toString();
      const response = await (options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw unavailable();
      return parseBizinfo(await response.json());
    } catch {
      throw unavailable();
    }
  } };
}
