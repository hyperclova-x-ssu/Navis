import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { createServer, type RequestListener } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../contracts';
import { renderWithKit } from '../../ui/test-utils';
import { aiResponseModule } from './mkt-local/ai-response';
// Load the Node server without Vite rewriting its file-relative fixture URLs.
const { createBridge } = createRequire(import.meta.url)('../../../server/bridge.mjs');

it('M-81 sends one exact review edit to the displayed alias with both provider transports idle', async () => {
  const providerModel = vi.fn(() => { throw new Error('Unexpected model call'); });
  const providerSms = vi.fn(() => { throw new Error('Unexpected SMS call'); });
  const fakeSends: string[] = [];
  const bridge: RequestListener & { close(): void } = createBridge({
    fetchImpl: providerModel,
    widgets: {
      mode: 'fake', sensFetch: providerSms,
      fakeSend: async ({ body }: { body: string }) => { fakeSends.push(body); },
      onStatus() {},
    },
  });
  const server = createServer(bridge);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const httpFetch = globalThis.fetch;
  let sessionCookie = '';
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (typeof input !== 'string' || !input.startsWith('/api/navis/')) throw new Error('Unexpected request');
    const headers = new Headers(init?.headers);
    if (sessionCookie) headers.set('Cookie', sessionCookie);
    const response = await httpFetch(base + input, { ...init, headers });
    sessionCookie = response.headers.get('Set-Cookie')?.split(';')[0] ?? sessionCookie;
    return response;
  });
  try {
    const host: WidgetHost = { layer: 'marketing', openClosing: () => true, acknowledgeBriefing() {}, notify() {}, resetPreview() {}, openDetail() {}, openLinked() {} };
    const Detail = aiResponseModule.Detail!;
    renderWithKit(<Detail condition={{ kind: 'default' }} featureId="ai-response" detailRef={{ featureId: 'ai-response' }} host={host} />);
    fireEvent.click(screen.getByRole('tab', { name: '리뷰' }));
    fireEvent.click(screen.getByRole('button', { name: /소금빵이 다 나가서 다음 나오는 시간까지 기다려야/ }));
    fireEvent.click(screen.getByRole('button', { name: '답글 초안 만들기' }));
    const editor = await screen.findByRole('textbox', { name: '답글 초안' });
    expect(editor).toHaveValue('말씀해 주신 내용을 확인하겠습니다.');
    const edited = '의견 남겨 주셔서 감사합니다.';
    fireEvent.change(editor, { target: { value: edited } });
    const previewButton = screen.getByRole('button', { name: '보낼 내용 확인하기' });
    await waitFor(() => expect(previewButton).toBeEnabled());
    expect(screen.getByRole('radio', { name: '테스트 번호 1' })).toBeChecked();
    fireEvent.click(previewButton);
    const preview = screen.getByRole('region', { name: '보낼 내용 확인하기' });
    const previewText = within(preview).getByText(edited).textContent;
    expect(previewText).toBe(edited);
    expect(within(preview).getByText('테스트 번호 1')).toBeVisible();
    expect(fakeSends).toHaveLength(0);
    const confirm = screen.getByRole('button', { name: '테스트 문자 보내기' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByText('보냈어요(예시)')).toBeVisible();
    expect(fakeSends).toEqual([previewText]);
    expect(fetchSpy.mock.calls.filter(([path]) => path === '/api/navis/reply-test-send')).toHaveLength(1);
    expect(providerModel).not.toHaveBeenCalled();
    expect(providerSms).not.toHaveBeenCalled();
  } finally {
    cleanup();
    fetchSpy.mockRestore();
    bridge.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
