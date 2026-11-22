import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPortFiles, createPortTransport } from './index';
import { fakeBackend, reply } from './testing';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
afterEach(() => vi.unstubAllGlobals());

describe('attachments', () => {
  it('creates, uploads the bytes and completes, with an idempotent create keyed by the content hash', async () => {
    const backend = fakeBackend();
    backend.on('POST', '/files', () => ({ fileId: 'f-1' }));
    backend.on('PUT', '/files/f-1/content', () => reply(204, null));
    backend.on('POST', '/files/f-1/complete', () => ({ fileId: 'f-1', contentType: 'image/png', size: 8, sha256: 'server-hash' }));
    const files = createPortFiles(createPortTransport(backend.fetch));
    const file = await files.uploadDataUrl('menu-photo', PNG);
    expect(file).toEqual({ fileId: 'f-1', contentType: 'image/png', size: 8, sha256: 'server-hash' });
    const [create, put, complete] = backend.calls;
    expect(create).toMatchObject({ method: 'POST', path: '/files', body: { purpose: 'menu-photo', contentType: 'image/png', size: 8 } });
    expect((create.body as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(create.headers.get('idempotency-key')).toBe(`file:menu-photo:${(create.body as { sha256: string }).sha256}`);
    expect(put.headers.get('content-type')).toBe('image/png');
    expect(put.method).toBe('PUT');
    expect(complete.path).toBe('/files/f-1/complete');
  });

  it('rejects anything that is not a base64 data URL before calling the server', async () => {
    const backend = fakeBackend();
    const files = createPortFiles(createPortTransport(backend.fetch));
    await expect(files.uploadDataUrl('menu-photo', 'https://example.com/a.png')).rejects.toMatchObject({ code: 'VALIDATION', reason: 'FILE_INVALID' });
    expect(backend.calls).toHaveLength(0);
  });

  it('reads a file through an authorized fetch into an object URL and revokes it on request', async () => {
    const backend = fakeBackend();
    backend.on('GET', '/files/f-1/content', () => reply(200, 'bytes'));
    backend.on('DELETE', '/files/f-1', () => reply(204, null));
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:f-1') }));
    const files = createPortFiles(createPortTransport(backend.fetch));
    expect(await files.readUrl('f-1')).toBe('blob:f-1');
    expect(backend.calls[0].headers.get('authorization')).toBe('Bearer token-1');
    await files.revoke('f-1');
    expect(backend.calls[1]).toMatchObject({ method: 'DELETE', path: '/files/f-1' });
  });
});
