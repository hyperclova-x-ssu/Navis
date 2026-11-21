import {afterEach, describe, expect, it, vi} from 'vitest';
import {ERROR_KEYS, fetchHealth, getZones, HTTP_TIMEOUT_MS, postPair, putZones, suggestZones} from './api';
import {fakeFetch, zoneSet} from './testFakes';
import {cctvBundle} from '../messages';

const base = 'https://cnn.test:8443';

describe('HTTP client (API-14·15·18)', () => {
  afterEach(() => vi.useRealTimers());

  it('not configured: nothing is called', async () => {
    const f = fakeFetch(() => ({status: 200, body: {}}));
    const r = await fetchHealth({base: null, fetch: f});
    expect(r).toMatchObject({ok: false, code: 'NOT_CONFIGURED', key: 'cctv.conn.serverNotConfigured'});
    expect(f.calls).toHaveLength(0);
  });

  it('times out after 2 s as UNREACHABLE', async () => {
    vi.useFakeTimers();
    const f = fakeFetch(() => 'hang');
    const p = fetchHealth({base, fetch: f});
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS - 1);
    let done = false;
    void p.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ok: false, code: 'UNREACHABLE'});
    expect(HTTP_TIMEOUT_MS).toBe(2000);
  });

  it('network failure is UNREACHABLE, 403 is BAD_ORIGIN', async () => {
    expect(await fetchHealth({base, fetch: fakeFetch(() => 'throw')})).toMatchObject({code: 'UNREACHABLE'});
    const f403 = fakeFetch(() => ({status: 403, body: {error: {code: 'BAD_ORIGIN', message: 'x'}}}));
    expect(await fetchHealth({base, fetch: f403})).toMatchObject({code: 'BAD_ORIGIN', key: 'cctv.conn.serverBadOrigin'});
  });

  it('pair sends lang and replace; 409 and 429 map to codes', async () => {
    const ok = fakeFetch(() => ({status: 200, body: {code: 'K7Q2MX', cameraUrl: `${base}/cam?c=K7Q2MX`, qrSvg: '<svg/>', expiresAt: 600.0, expiresInSec: 600}}));
    const r = await postPair({base, fetch: ok}, {replace: true, lang: 'en'});
    expect(ok.calls[0]).toEqual({method: 'POST', path: '/api/pair', body: {lang: 'en', replace: true}});
    expect(r.ok && r.value.expiresInSec).toBe(600);
    expect(await postPair({base, fetch: fakeFetch(() => ({status: 409, body: {error: {code: 'CAMERA_CONNECTED'}}}))}, {replace: false, lang: 'ko'})).toMatchObject({code: 'CAMERA_CONNECTED'});
    expect(await postPair({base, fetch: fakeFetch(() => ({status: 429}))}, {replace: false, lang: 'ko'})).toMatchObject({code: 'RATE_LIMITED'});
  });

  it('zones: GET, PUT body, 409 REVISION_CONFLICT keeps current, 422 INVALID_ZONES', async () => {
    const z = zoneSet();
    expect(await getZones({base, fetch: fakeFetch(() => ({status: 200, body: z}))})).toEqual({ok: true, value: z});
    const put = fakeFetch(() => ({status: 200, body: {...z, revision: 2}}));
    await putZones({base, fetch: put}, {baseRevision: 1, frameAspect: 1.778, zones: z.zones});
    expect(put.calls[0]).toMatchObject({method: 'PUT', path: '/api/zones', body: {baseRevision: 1, frameAspect: 1.778}});
    const conflict = await putZones({base, fetch: fakeFetch(() => ({status: 409, body: {error: {code: 'REVISION_CONFLICT', message: 'm'}, current: {...z, revision: 5}}}))}, {baseRevision: 1, frameAspect: null, zones: []});
    expect(conflict).toMatchObject({ok: false, code: 'REVISION_CONFLICT', current: {revision: 5}});
    const invalid = await putZones({base, fetch: fakeFetch(() => ({status: 422, body: {error: {code: 'INVALID_ZONES', message: 'rule 3'}}}))}, {baseRevision: 1, frameAspect: null, zones: []});
    expect(invalid).toMatchObject({ok: false, code: 'INVALID_ZONES', key: 'cctv.zones.saveFailed', message: 'rule 3'});
  });

  it('suggest: POST {} and 409 NO_FRAME', async () => {
    const f = fakeFetch(() => ({status: 409, body: {error: {code: 'NO_FRAME'}}}));
    expect(await suggestZones({base, fetch: f})).toMatchObject({code: 'NO_FRAME'});
    expect(f.calls[0]).toMatchObject({method: 'POST', path: '/api/zones/suggest', body: {}});
  });

  it('every error key exists in cctvBundle', () => {
    for (const k of Object.values(ERROR_KEYS)) expect(cctvBundle.ko, k).toHaveProperty([k]);
  });
});
