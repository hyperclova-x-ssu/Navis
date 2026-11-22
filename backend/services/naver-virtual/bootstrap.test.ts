import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createNaverTransport, createPersonaCallback } from '../../packages/naver/transport/index.ts';
import { validatePersonaOrigin, type NaverBinding } from '../../packages/naver/config/index.ts';
import { createPersonaApp, type PersonaCapability } from './app.ts';
import { createPersonaClock, PINNED_PERSONA_INSTANT } from './clock.ts';
import { createPersonaSeedContext } from './seed.ts';

const token = 'unit-test-persona-workload-token';
const accountId = 'ansungjalbu-cafe';
const scope = { 'x-navis-naver-virtual-token': token, 'x-navis-naver-virtual-account': accountId };
const source = '/partner-assumed/v1/place';
const fixture: PersonaCapability = {
  id: 'pn01',
  register(app, context) {
    app.get(source, { config: { personaOperation: 'pn01.place.read' } }, request => ({
      account: context.accountId(request),
      workload: context.workload(request),
      now: context.now().toISOString(),
      usesProviderCredential: context.providerCredential(request, 'test') === 'fixture',
    }));
    app.patch(source, { config: { personaOperation: 'pn01.place.update' } }, () => ({ changed: true }));
  },
};

function appFor(capabilities = [fixture], ready = vi.fn(async () => {})) {
  return createPersonaApp({
    pool: {} as Pool, capabilities, ready, logging: false,
    grants: [{ workload: 'account', token, accountId, operations: ['pn01.place.read'],
      providerCredentials: { 'pn01.place.read': { test: 'fixture' } } }],
  });
}

describe('NAVER Virtual Server bootstrap', () => {
  it('accepts the private virtual service name and rejects other hosts', () => {
    expect(validatePersonaOrigin('http://naver-virtual:3000')).toBe('http://naver-virtual:3000');
    expect(validatePersonaOrigin('http://naver-virtual.navis.svc.cluster.local:3000'))
      .toBe('http://naver-virtual.navis.svc.cluster.local:3000');
    expect(() => validatePersonaOrigin('http://api-gateway:3000')).toThrow();
    expect(() => validatePersonaOrigin('http://naver-virtual.example.invalid:3000')).toThrow();
  });

  it('rejects missing, wrong account and wrong operation scopes before executing routes', async () => {
    const app = appFor();
    try {
      expect((await app.inject(source)).statusCode).toBe(401);
      expect((await app.inject({ url: source, headers: { ...scope, 'x-navis-naver-virtual-account': 'other-cafe' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'PATCH', url: source, headers: { ...scope, 'content-type': 'application/json' },
        payload: '{malformed',
      })).statusCode).toBe(403);
      expect((await app.inject({ url: source, headers: scope })).json()).toEqual({
        account: accountId, workload: 'account', now: PINNED_PERSONA_INSTANT, usesProviderCredential: true,
      });
      expect((await app.inject('/unregistered')).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('fails startup when a registrar omits a scoped operation', async () => {
    const app = appFor([{ id: 'pn01', register(router) { router.get('/unscoped', () => 'private'); } }]);
    await expect(app.ready()).rejects.toThrow('personaOperation');
    await app.close().catch(() => {});
  });

  it('keeps liveness available and reports unavailable readiness on DB failure', async () => {
    const app = appFor([], vi.fn(async () => { throw new Error('DB unavailable'); }));
    try {
      expect((await app.inject('/healthz')).json()).toEqual({ service: 'naver-virtual', status: 'ok' });
      const readiness = await app.inject('/readyz');
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toEqual({ service: 'naver-virtual', status: 'unavailable' });
    } finally { await app.close(); }
  });

  it('pins local time and generates hosted data by the deployment instant in Seoul', () => {
    const local = createPersonaSeedContext();
    expect(local.now.toISOString()).toBe(PINNED_PERSONA_INSTANT);
    expect(local.cafe.businessDate).toBe('2026-11-17');
    expect(createPersonaClock('fixed')().toISOString()).toBe(PINNED_PERSONA_INSTANT);
    const instant = new Date('2026-12-02T15:30:00.000Z');
    const hosted = createPersonaSeedContext(instant);
    expect(hosted).toMatchObject({ accountId, generation: instant.toISOString(), cafe: {
      end: '2026-12-03', businessDate: '2026-12-02', days: 90,
    } });
    expect(createPersonaClock('real', () => instant.getTime())()).toEqual(instant);
  });
});

const binding = {
  operation: 'pn10.blog', storeId: 'navis-store', providerAccount: accountId, grade: 'W',
  method: 'GET', route: /^\/search\/v1\/blog$/, timeoutMs: 1000, maxResponseBytes: 24,
} as const;

describe('NAVER binding transport', () => {
  it('keeps fake requests in-process and never resolves a network credential', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const readCredential = vi.fn();
    const transport = createNaverTransport({
      bindings: [{ ...binding, mode: 'fake', handler: () => new Response('{"items":[]}') }],
      fakeOnly: true, fetcher, readCredential,
    });
    const result = await transport.request(binding.operation, binding.storeId, '/search/v1/blog?query=cafe');
    expect(await result.json()).toEqual({ items: [] });
    expect(fetcher).not.toHaveBeenCalled();
    expect(readCredential).not.toHaveBeenCalled();
  });

  it('adds private auth only to persona, preserves official auth and forbids redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.invalid/' } }));
    const transport = createNaverTransport({ bindings: [{ ...binding, mode: 'virtual',
      origin: 'http://naver-virtual:3000', privateTokenFile: '/test/persona-token',
      credentialFile: '/test/official-fixture', authorize: (_request, credential) => ({ 'x-ncp-apigw-api-key': credential }),
    }], fetcher, readCredential: name => name.endsWith('persona-token') ? token : 'fixture-wire' });
    await expect(transport.request(binding.operation, 'other-store', '/search/v1/blog')).rejects.toThrow('binding');
    await expect(transport.request(binding.operation, binding.storeId, '//unexpected.invalid/search/v1/blog')).rejects.toThrow('path');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(transport.request(binding.operation, binding.storeId, '/search/v1/blog')).rejects.toThrow('redirect');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('http://naver-virtual:3000/search/v1/blog');
    expect(new Headers(init?.headers).get('x-ncp-apigw-api-key')).toBe('fixture-wire');
    expect(new Headers(init?.headers).get('x-navis-naver-virtual-account')).toBe(accountId);
    expect(init?.redirect).toBe('manual');
  });

  it('rejects live requests before credential reads or network access when A6 denies', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const readCredential = vi.fn();
    const live = { ...binding, mode: 'live', origin: 'https://naverapihub.apigw.ntruss.com', allowedOrigins: ['https://naverapihub.apigw.ntruss.com'],
      approve: vi.fn(async () => false), credentialFile: '/test/real-key', authorize: () => ({}) } satisfies NaverBinding;
    expect(() => createNaverTransport({ bindings: [live], fakeOnly: true })).toThrow('fake');
    const transport = createNaverTransport({ bindings: [live], readCredential, fetcher });
    await expect(transport.request(binding.operation, binding.storeId, '/search/v1/blog')).rejects.toThrow('A6');
    expect(readCredential).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds a streamed response even without Content-Length', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(25)); controller.close(); },
    })));
    const transport = createNaverTransport({ bindings: [{ ...binding, mode: 'virtual',
      origin: 'http://naver-virtual:3000', privateTokenFile: '/test/persona-token',
    }], fetcher, readCredential: () => token });
    const result = await transport.request(binding.operation, binding.storeId, '/search/v1/blog');
    await expect(result.arrayBuffer()).rejects.toThrow('response limit');
  });

  it('pins callbacks to the corresponding private receiving path and rejects redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { location: 'https://unexpected.invalid/' } }));
    expect(() => createPersonaCallback({ talktalk: 'http://customer:3000/internal/v1/naver/talktalk/webhook' }, fetcher)).toThrow('destination');
    expect(fetcher).not.toHaveBeenCalled();
    const callback = createPersonaCallback({ talktalk: 'http://marketing:3000/internal/v1/naver/talktalk/webhook' }, fetcher);
    await expect(callback('aicall', {})).rejects.toThrow('unavailable');
    await expect(callback('talktalk', { body: '{"event":"send"}', headers: { 'content-type': 'application/json' } })).rejects.toThrow('redirect');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual(['http://marketing:3000/internal/v1/naver/talktalk/webhook',
      expect.objectContaining({ method: 'POST', redirect: 'manual' }),
    ]);
  });
});
