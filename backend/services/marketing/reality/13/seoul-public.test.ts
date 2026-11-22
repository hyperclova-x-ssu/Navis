import { describe, expect, it, vi } from 'vitest';
import { configureSeoulPublic, eventRows, licenseRows, populationBands, seoulDatasets, seoulProvider } from './seoul-public.ts';

const at = new Date('2026-11-22T04:00:00.000Z');

describe('Seoul Open Data', () => {
  it('is disabled by default and uses the documented service and page bounds when enabled', async () => {
    expect(await configureSeoulPublic({})).toBeUndefined();
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({
      culturalEventInfo: { RESULT: { CODE: 'INFO-000' }, list_total_count: 1, row: [{ TITLE: '문화 행사' }] },
    }));
    const page = await seoulProvider('sample-key', transport).page('events', 1, 1000);
    expect(page).toEqual({ total: 1, rows: [{ TITLE: '문화 행사' }] });
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toBe('http://openapi.seoul.go.kr:8088/sample-key/json/culturalEventInfo/1/1000');
    expect(options?.redirect).toBe('error');
  });

  it('distinguishes a valid empty feed from an upstream error without returning error text', async () => {
    const failure = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ RESULT: { CODE: 'INFO-200' } }))
      .mockResolvedValueOnce(Response.json({ RESULT: { CODE: 'ERROR-300', MESSAGE: 'private request data' } }));
    const provider = seoulProvider('sample-key', failure);
    await expect(provider.page('events', 1, 1000)).resolves.toEqual({ total: 0, rows: [] });
    await expect(provider.page('events', 1, 1000)).rejects.toThrow(/^Seoul public data is unavailable$/);
  });

  it('uses only Dongjak events in Sangdo with a portal link', () => {
    const row = { TITLE: '가을 음악회', GUNAME: '동작구', CODENAME: '콘서트', PLACE: '숭실대학교', ORG_NAME: '동작구',
      STRTDATE: '2026-11-22 00:00:00.0', HMPG_ADDR: 'http://culture.seoul.go.kr/culture/culture/cultureEvent/view.do?cultcode=42' };
    expect(eventRows([row, { ...row, GUNAME: '강남구' }, { ...row, PLACE: '사당역' }], at)).toMatchObject([
      { title: '[콘서트] 가을 음악회 · 숭실대학교', referenceDate: '2026-11-22',
        sourceUrl: 'https://culture.seoul.go.kr/culture/culture/cultureEvent/view.do?cultcode=42' },
    ]);
  });

  it('derives separate opening and closure rows from documented dates and excludes other neighborhoods', () => {
    const row = { MGTNO: 'fixture-1', APVPERMYMD: '20260801', DCBYMD: '20261119', TRDSTATENM: '폐업',
      SITEWHLADDR: '서울특별시 동작구 상도동 30', RDNWHLADDR: '서울특별시 동작구 상도로 30 (상도동)',
      BPLCNM: '동네 카페', UPTAENM: '커피숍', UPDATEDT: '2026-11-20 00:00:00' };
    const result = licenseRows([row, { ...row, MGTNO: 'other-area', SITEWHLADDR: '서울특별시 동작구 사당동 30' }], 'rest', at);
    expect(result.referenceDate).toBe('2026-11-20');
    expect(result.rows).toMatchObject([{ changeType: 'opening', referenceDate: '2026-08-01',
      title: '동네 카페 · 휴게음식점(커피숍) · 상도로 30' },
    { changeType: 'closure', referenceDate: '2026-11-19', sourceUrl: seoulDatasets.rest.sourceUrl }]);
    expect(result.rows[0]?.id).not.toBe(result.rows[1]?.id);
  });

  it('sums all four dongs before averaging and ignores partial or suppressed hours', () => {
    const rows = ['20261108', '20261115'].flatMap((YMD, index) => ['11590530', '11590540', '11590550', '11590560']
      .map((H_DNG_CD, dong) => ({ YMD, TT: '12', H_DNG_CD, SPOP: String(100 * (index + 1) + dong) })));
    rows.push({ YMD: '20261122', TT: '12', H_DNG_CD: '11590530', SPOP: '999' });
    expect(populationBands(rows, at)).toEqual([{ quarter: '2026-Q4', weekday: 7, startHour: 12, endHour: 13,
      estimate: 606, referenceDate: '2026-11-15', refreshedAt: at.toISOString(), sourceUrl: seoulDatasets.population.sourceUrl }]);
  });
});
