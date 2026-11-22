import { PortError, type PortTransport } from '../00';

const path = '/insight/financial-center/recommendations';

export interface FundingRecommendation {
  readonly ref: string;
  readonly title: string;
  readonly officialNoticeUrl: string;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly status?: 'closed';
}

interface FundingDetail extends FundingRecommendation {
  readonly asOf: string;
  readonly overview: string;
  readonly eligibility: string;
  readonly applicationMethod: string;
  readonly documents?: readonly string[];
}

interface FundingList {
  readonly state: 'ready' | 'not-connected';
  readonly items: readonly FundingRecommendation[];
}

const bad = () => new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
const validRef = (ref: unknown): ref is string => typeof ref === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(ref);
const isHttps = (value: unknown) => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};
const validRow = (row: FundingRecommendation) => row && validRef(row.ref) && typeof row.title === 'string' && isHttps(row.officialNoticeUrl)
  && [row.startDate, row.endDate].every(date => date === undefined || (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(date)))
  && (row.status === undefined || row.status === 'closed');

export async function readFundingList(transport: PortTransport, signal: AbortSignal): Promise<FundingList> {
  const result = await transport.request<FundingList>({ method: 'GET', path, signal });
  if (!result || !['ready', 'not-connected'].includes(result.state) || !Array.isArray(result.items) || !result.items.every(validRow)) throw bad();
  return result;
}

export async function readFundingDetail(transport: PortTransport, ref: string, signal: AbortSignal): Promise<FundingDetail> {
  if (!validRef(ref)) throw bad();
  const result = await transport.request<FundingDetail>({ method: 'GET', path: `${path}/${encodeURIComponent(ref)}`, signal });
  if (!validRow(result) || result.ref !== ref || ![result.overview, result.eligibility, result.applicationMethod, result.asOf].every(value => typeof value === 'string')
    || !Number.isFinite(Date.parse(result.asOf))
    || (result.documents !== undefined && (!Array.isArray(result.documents) || !result.documents.every(value => typeof value === 'string')))) throw bad();
  return result;
}
