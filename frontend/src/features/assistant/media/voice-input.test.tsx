import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AiConversation } from '../conversation';
const { startRecording } = vi.hoisted(() => ({ startRecording: vi.fn() }));
vi.mock(import('./pcm-recording'), async original => ({ ...await original(), startRecording }));
vi.mock('../snapshot', () => ({ localizeFact: vi.fn(), questionContext: () => ({ topics: [] }) }));
const audio = new Blob(['test PCM'], { type: 'audio/wav' });
const transcript = '딸기스무디 메뉴 추가해줘';
const microphone = () => screen.getByRole('button', { name: '말로 입력' });
const stopButton = () => screen.getByRole('button', { name: '듣기 멈추기' });
const input = () => screen.getByRole('textbox', { name: '자유롭게 질문해 주세요' });
function open() {
  const submit = vi.fn();
  function Fixture() {
    const [draft, setDraft] = useState('기존 입력');
    const [visible, setVisible] = useState(true);
    return visible && <AiConversation draft={draft} onDraftChange={setDraft} messages={[]} phase="idle" onSubmit={() => submit(draft)} onCancel={() => {}} onClose={() => setVisible(false)} />;
  }
  const view = render(<Fixture />);
  return { ...view, submit };
}
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetAllMocks(); });

it('records once, stops once, appends to the latest editable draft and submits only on Send', async () => {
  const stop = vi.fn().mockResolvedValue(audio);
  startRecording.mockResolvedValue({ stop });
  const fetcher = vi.fn().mockResolvedValue(Response.json({ requestId: 'voice-1', text: transcript }));
  vi.stubGlobal('fetch', fetcher);
  const { submit } = open();
  const mic = microphone();
  await act(async () => { mic.click(); mic.click(); });
  expect(startRecording).toHaveBeenCalledOnce();
  expect(screen.getByText('듣고 있어요')).toBeInTheDocument();
  const press = stopButton();
  expect(press).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(input(), { target: { value: '듣는 동안 고친 입력' } });
  await act(async () => { press.click(); press.click(); });
  expect(stop).toHaveBeenCalledOnce();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/navis/media/transcription', expect.objectContaining({ method: 'POST', body: audio, headers: { 'Content-Type': 'audio/wav' }, signal: expect.any(AbortSignal) }));
  expect(input()).toHaveValue('듣는 동안 고친 입력 ' + transcript);
  expect(input()).toHaveFocus();
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(input(), { target: { value: '딸기 스무디 메뉴 추가해줘' } });
  fireEvent.click(screen.getByRole('button', { name: '요청 보내기' }));
  expect(submit).toHaveBeenCalledExactlyOnceWith('딸기 스무디 메뉴 추가해줘');
});

it('stops at 60 seconds and applies only the completed recognition', async () => {
  vi.useFakeTimers();
  const stop = vi.fn().mockResolvedValue(audio);
  startRecording.mockResolvedValue({ stop });
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const { submit } = open();
  await act(async () => { microphone().click(); });
  act(() => vi.advanceTimersByTime(59_999));
  expect(stop).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(stop).toHaveBeenCalledOnce();
  expect(screen.getByText('음성을 글로 바꾸고 있어요')).toBeInTheDocument();
  expect(microphone()).toBeDisabled();
  await act(async () => { finish(Response.json({ requestId: 'voice-2', text: transcript })); });
  expect(input()).toHaveValue('기존 입력 ' + transcript);
  expect(submit).not.toHaveBeenCalled();
});

it('keeps the draft and focuses typing on permission denial', async () => {
  startRecording.mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  open();
  fireEvent.click(microphone());
  expect(await screen.findByRole('alert')).toHaveTextContent('듣지 못했어요. 글로 입력해 주세요');
  expect(input()).toHaveValue('기존 입력');
  expect(input()).toHaveFocus();
  expect(fetcher).not.toHaveBeenCalled();
});

it('keeps typing available when the service cannot recognize the audio', async () => {
  startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(audio) });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'MEDIA_UNREADABLE', requestId: 'empty' }, { status: 422 })));
  const { submit } = open();
  await act(async () => { microphone().click(); });
  await act(async () => { stopButton().click(); });
  expect(screen.getByRole('alert')).toHaveTextContent('듣지 못했어요. 글로 입력해 주세요');
  expect(input()).toHaveValue('기존 입력');
  expect(input()).toHaveFocus();
  expect(submit).not.toHaveBeenCalled();
});

it('aborts an in-flight transcription on closing and ignores its stale result', async () => {
  startRecording.mockResolvedValue({ stop: vi.fn().mockResolvedValue(audio) });
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<(url: string, options: RequestInit) => Promise<Response>>(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  const { submit } = open();
  await act(async () => { microphone().click(); });
  await act(async () => { stopButton().click(); });
  const signal = fetcher.mock.calls[0]![1].signal;
  fireEvent.keyDown(input(), { key: 'Escape' });
  expect(signal?.aborted).toBe(true);
  await act(async () => { finish(Response.json({ requestId: 'late', text: transcript })); });
  expect(screen.queryByRole('textbox', { name: '자유롭게 질문해 주세요' })).not.toBeInTheDocument();
  expect(submit).not.toHaveBeenCalled();
});
