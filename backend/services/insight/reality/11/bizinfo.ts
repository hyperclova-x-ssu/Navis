import { readFile } from 'node:fs/promises';
import { hash, InsightError, isDate } from '../../scope.ts';

const endpoint = 'https://www.bizinfo.go.kr/uss/rss/bizinfoApi.do';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
const field = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const unavailable = () => new InsightError(503, 'GRANT_SOURCE_UNAVAILABLE');
const date = (value: string) => value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

export type GrantNotice = {
  noticeId: string; providerId: string; source: 'bizinfo'; title: string; agency: string; summary: string;
  officialUrl: string; startsOn: string | null; deadline: string | null; tags: string[];
  target: string; applicationMethod: string;
};

export function parseBizinfo(value: unknown): GrantNotice[] {
  const envelope = object(value);
  const items = Array.isArray(value) ? value : object(envelope?.jsonArray)?.item;
  if (!Array.isArray(items) || items.length > 2000) throw unavailable();
  const notices = new Map<string, GrantNotice>();
  for (const raw of items) {
    const row = object(raw);
    const providerId = field(row?.pblancId, 64);
    const title = field(row?.pblancNm ?? row?.title, 300);
    const agency = field(row?.jrsdInsttNm, 200);
    const url = URL.parse(field(row?.pblancUrl ?? row?.link, 2000), endpoint);
    if (!/^PBLN_[0-9]+$/.test(providerId) || !title || !agency || !url
      || url.protocol !== 'https:' || !['www.bizinfo.go.kr', 'bizinfo.go.kr'].includes(url.host)
      || url.username || url.password || url.searchParams.get('pblancId') !== providerId) continue;
    const [first = '', last = ''] = field(row?.reqstBeginEndDe ?? row?.reqstDt, 64).split(/\s*~\s*/).map(date);
    const tags = [...new Set(field(row?.hashTags ?? row?.hashtags, 2000).split(/[,#]/).map(tag => tag.trim().normalize('NFKC')).filter(Boolean))];
    const digest = hash(`bizinfo:${providerId}`);
    const noticeId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
    notices.set(providerId, { noticeId, providerId, source: 'bizinfo', title, agency,
      summary: field(row?.bsnsSumryCn, 4000), target: field(row?.trgetNm, 200),
      applicationMethod: field(row?.reqstMthPapersCn, 1000), officialUrl: url.href, startsOn: isDate(first) ? first : null,
      deadline: isDate(last) ? last : null, tags });
  }
  return [...notices.values()];
}

export function matchNotices(notices: readonly GrantNotice[], region: string, industry: string) {
  return notices.filter(notice => notice.tags.includes(region.normalize('NFKC'))
    && notice.tags.includes(industry.normalize('NFKC')));
}

export type GrantProvider = { mode: 'fake' | 'live'; load(region: string): Promise<GrantNotice[]> };
export async function configureBizinfo(env: NodeJS.ProcessEnv): Promise<GrantProvider> {
  const mode = env.NAVIS_BIZINFO_MODE ?? 'fake';
  if (mode === 'fake') return bizinfoProvider();
  if (mode !== 'live' || env.NAVIS_BIZINFO_A6_APPROVED !== '1' || env.NAVIS_BIZINFO_TERMS_ACCEPTED !== '1'
    || !env.NAVIS_BIZINFO_KEY_FILE) throw new Error('Bizinfo live configuration is incomplete');
  const key = await readFile(env.NAVIS_BIZINFO_KEY_FILE, 'utf8').catch(() => {
    throw new Error('Bizinfo credential file is unavailable');
  });
  return bizinfoProvider({ mode, a6: true, termsAccepted: true, key });
}

export function bizinfoProvider(options: {
  mode?: 'fake' | 'live'; a6?: boolean; termsAccepted?: boolean; key?: string; fetch?: typeof fetch;
} = {}): GrantProvider {
  const mode = options.mode ?? 'fake';
  const key = options.key?.trim();
  if (mode === 'live' && !(options.a6 && options.termsAccepted && key)) throw new Error('Bizinfo live configuration is incomplete');
  return { mode, async load(region) {
    try {
      if (mode === 'fake') return parseBizinfo(JSON.parse(await readFile(new URL('./bizinfo.fixture.json', import.meta.url), 'utf8')));
      const url = new URL(endpoint);
      url.search = new URLSearchParams({ crtfcKey: key!, dataType: 'json', searchCnt: '0', pageUnit: '100', pageIndex: '1', hashtags: region }).toString();
      const response = await (options.fetch ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw unavailable();
      return parseBizinfo(await response.json());
    } catch {
      throw unavailable();
    }
  } };
}
