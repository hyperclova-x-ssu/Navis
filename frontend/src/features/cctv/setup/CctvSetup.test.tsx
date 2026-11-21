import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, screen, waitFor} from '@testing-library/react';
import {renderWithKit} from '../../../ui/test-utils';
import type {CctvView, LiveConnection} from '../../../data/cctv';
import type {WidgetHost} from '../../../contracts';
import type {ZonesApi} from '../zones';
import {svgDataUrl} from './qr';

const state = {connection: 'waiting' as LiveConnection, serverDown: undefined as undefined | 'unreachable' | 'not-configured', retry: vi.fn()};
const pairing = vi.fn();
vi.mock('../live', async orig => {
  const real = await orig<typeof import('../live')>();
  return {
    ...real,
    useLiveConnection: () => ({connection: state.connection, serverDown: state.serverDown, retry: state.retry}),
    useLiveCctvView: (): CctvView => ({mode: 'live', connection: state.connection, frame: null, persons: [], cups: [], inStore: null, occupants: null, change5m: null, tables: [], avgDwell: {kind: 'live-seconds', seconds: null}, stale: false, zonesCount: 0}),
    requestPairing: (o: unknown) => pairing(o),
  };
});
const {CctvSetup} = await import('./CctvSetup');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect id="evil" width="1" height="1"/></svg>';
const okPair = (over = {}) => ({ok: true, code: 'K7Q2MX', cameraUrl: 'https://x/cam?c=K7Q2MX&lang=ko', qrSvg: SVG, expiresAt: 1, expiresInSec: 600, ...over});
const host: WidgetHost = {layer: 'board', resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn()} as never;
const api = (zones: unknown[] = []): ZonesApi => ({get: vi.fn(async () => ({revision: zones.length ? 1 : 0, savedAt: null, frameAspect: null, zones})), put: vi.fn(), suggest: vi.fn(async () => ({zones: [], frameAspect: 16 / 9}))}) as never;

beforeEach(() => { state.connection = 'waiting'; state.serverDown = undefined; pairing.mockReset(); pairing.mockResolvedValue(okPair()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('CctvSetup', () => {
  it('draws the QR only as an <img data-url>, shows the 6-letter code, and never injects the SVG as markup', async () => {
    const {container} = renderWithKit(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    const img = await screen.findByRole('img', {name: '카메라 연결 QR 코드'});
    expect(img.getAttribute('src')).toBe(svgDataUrl(SVG));
    expect(container.querySelector('#evil')).toBeNull();
    expect(screen.getByTestId('cctv-pair-code')).toHaveTextContent('K7Q2MX');
    expect(screen.getByText('카메라를 기다리고 있어요')).toBeInTheDocument();
    expect(pairing).toHaveBeenCalledWith({replace: false, lang: 'ko'});
  });

  it('phone-opened text, and the allow-camera hint only after 15 s', async () => {
    vi.useFakeTimers();
    state.connection = 'phone-opened';
    renderWithKit(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('휴대폰이 열렸어요. 영상을 기다리고 있어요')).toBeInTheDocument();
    expect(screen.queryByText('휴대폰에서 카메라를 허용했는지 확인해 주세요')).toBeNull();
    act(() => { vi.advanceTimersByTime(15_000); });
    expect(screen.getByText('휴대폰에서 카메라를 허용했는지 확인해 주세요')).toBeInTheDocument();
  });

  it('lost: message + reason + QR again; server-down: reason, no QR, retry button', async () => {
    state.connection = 'lost';
    const a = renderWithKit(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    expect(screen.getByText('카메라 연결이 끊겼어요')).toBeInTheDocument();
    expect(screen.getByText('휴대폰 화면이 꺼졌거나 Tailscale이 꺼졌는지 확인해 주세요')).toBeInTheDocument();
    await screen.findByRole('img', {name: '카메라 연결 QR 코드'});
    a.unmount();
    state.connection = 'server-down'; state.serverDown = 'unreachable';
    renderWithKit(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    expect(screen.getByText('카메라에 연결하지 못했어요')).toBeInTheDocument();
    expect(screen.queryByRole('img', {name: '카메라 연결 QR 코드'})).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: '다시 시도하기'}));
    expect(state.retry).toHaveBeenCalled();
  });

  it('after 10 minutes the QR becomes "expired" with a button that makes a new one', async () => {
    vi.useFakeTimers();
    renderWithKit(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    await act(async () => { await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(600_000); });
    expect(screen.getByText('QR이 만료됐어요')).toBeInTheDocument();
    pairing.mockResolvedValue(okPair({code: 'ZZZZZZ'}));
    await act(async () => { fireEvent.click(screen.getByRole('button', {name: '새 QR 만들기'})); });
    expect(screen.getByTestId('cctv-pair-code')).toHaveTextContent('ZZZZZZ');
  });

  it('moves on by itself when the phone connects: no zones → editor, saved zones → done', async () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const {rerender} = renderWithKit(<CctvSetup start="connect" onDone={onDone} host={host} zonesApi={api()} />);
    await act(async () => { await Promise.resolve(); });
    state.connection = 'live';
    rerender(<CctvSetup start="connect" onDone={onDone} host={host} zonesApi={api()} />);
    expect(screen.getByTestId('cctv-setup')).toHaveAttribute('data-step', 'verify');
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(screen.getByTestId('cctv-setup')).toHaveAttribute('data-step', 'zones');
    expect(onDone).not.toHaveBeenCalled();
    cleanup();

    state.connection = 'waiting';
    const saved = api([{id: 'za0000001', number: 1, source: 'drawn', mask: {cols: 160, rows: 90, runs: [0, 5, 14395]}}]);
    const r2 = renderWithKit(<CctvSetup start="connect" onDone={onDone} host={host} zonesApi={saved} />);
    await act(async () => { await Promise.resolve(); });
    state.connection = 'live';
    r2.rerender(<CctvSetup start="connect" onDone={onDone} host={host} zonesApi={saved} />);
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('"camera again" while live waits for a new phone (leaves live first) and asks the server to replace', async () => {
    vi.useFakeTimers();
    state.connection = 'live';
    const {rerender} = renderWithKit(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    await act(async () => { await Promise.resolve(); });
    expect(pairing).toHaveBeenCalledWith({replace: true, lang: 'ko'});
    expect(screen.getByTestId('cctv-setup')).toHaveAttribute('data-step', 'qr');
    state.connection = 'phone-opened';
    rerender(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    state.connection = 'live';
    rerender(<CctvSetup start="connect" onDone={vi.fn()} host={host} zonesApi={api()} />);
    expect(screen.getByTestId('cctv-setup')).toHaveAttribute('data-step', 'verify');
  });

  it('start="zones" opens the editor straight away', async () => {
    state.connection = 'live';
    renderWithKit(<CctvSetup start="zones" onDone={vi.fn()} host={host} zonesApi={api()} />);
    expect(screen.getByTestId('cctv-setup')).toHaveAttribute('data-step', 'zones');
    await waitFor(() => expect(screen.getByTestId('zone-stage')).toBeInTheDocument());
  });
});
