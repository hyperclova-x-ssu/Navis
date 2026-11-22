/** T-075 (2026-11-12 병합 D-230: 목업은 반복 5 CCTV 현황 화면, 실시간은 반복 5-C 화면): CCTV 손님분석 toggle, size display, status table and the unchanged day record (AC-1323~1325·1328·1330·1344). */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureId, WidgetHost } from '../../../contracts';
import type { LiveSnapshot } from '../../cctv/live/client';
import { setLiveClientForTest } from '../../cctv/live/hooks';
import { resetCctvModeForTest, setCctvMode } from '../../cctv/live/mode';
import { frameHeader, zoneSet } from '../../cctv/live/testFakes';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

const mod = (id: FeatureId) => widgets.find((w) => w.id === id)!;
const makeHost = () => ({ layer: 'management', resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) }) satisfies WidgetHost;
function panel(id: FeatureId, width: number, height: number) {
  const host = makeHost();
  const Panel = mod(id).Panel;
  return { host, ...renderWithKit(<Panel featureId={id} condition={{ kind: 'default' }} width={width as 1} height={height as 1} shape="Q" presetId="A" editing={false} host={host} />) };
}
function detail(host = makeHost(), view?: string) {
  const Detail = mod('customer-analysis').Detail!;
  return { host, ...renderWithKit(<Detail featureId="customer-analysis" condition={{ kind: 'default' }} detailRef={{ featureId: 'customer-analysis', ...(view ? { view } : {}) }} host={host} />) };
}

/** A scriptable page client: the screens read the snapshot, nothing opens a socket. */
function fakeClient(first: Partial<LiveSnapshot>) {
  let snap: LiveSnapshot = { connection: 'live', camera: 'live', frame: frameHeader(), bitmap: null, zones: zoneSet(), zonesAspectMismatch: false, e2eMs: null, ...first };
  const ls = new Set<() => void>();
  const retry = vi.fn();
  const c = { getSnapshot: () => snap, subscribe: (l: () => void) => { ls.add(l); return () => ls.delete(l); }, acquire: () => () => undefined, retry, notePaired: vi.fn() };
  setLiveClientForTest(c as never);
  return { retry, set: (p: Partial<LiveSnapshot>) => act(() => { snap = { ...snap, ...p }; ls.forEach((l) => l()); }) };
}

afterEach(() => { cleanup(); setLiveClientForTest(null); resetCctvModeForTest(); });

describe('mode toggle (AC-1323·1325)', () => {
  it('only customer-analysis has the toggle (detail header in mock, D-230), and it starts on the demo', () => {
    const a = detail();
    expect(a.container.querySelector('[data-slot="customer-analysis.mode-toggle"]')).toBeTruthy();
    expect(within(a.container).getByRole('radio', { name: '예시' })).toBeChecked();
    expect(within(a.container).getByRole('radiogroup', { name: '보기 방식, 예시 선택됨' })).toBeInTheDocument();
    a.unmount();
    for (const id of ['members', 'voice-booking'] as const) {
      const o = panel(id, 2, 1);
      expect(o.container.querySelector('[data-slot$="mode-toggle"]')).toBeNull();
      o.unmount();
    }
  });
  it('switching to live in the detail makes the panel live; the live panel switches back to the 반복 5 panel (D-230)', async () => {
    fakeClient({});
    const d = detail();
    await userEvent.click(within(d.container).getByRole('radio', { name: '실시간' }));
    d.unmount();
    const { container } = panel('customer-analysis', 2, 1);
    expect(container.querySelector('[data-mode="live"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="customer-analysis.metric.value"]')).toHaveTextContent('2명');
    await userEvent.click(within(container).getByRole('radio', { name: '예시' }));
    expect(container.querySelector('[data-mode="live"]')).toBeNull();
    expect(container).toHaveTextContent('방문 감지');
  });
  it('keeps the mock panel toggle in detail and shows the sample clip at expanded sizes', () => {
    for (const [w, h] of [[1, 1], [1, 2], [2, 1], [2, 2], [4, 4]] as const) {
      const p = panel('customer-analysis', w, h);
      expect(p.container.querySelector('[data-slot="customer-analysis.mode-toggle"]')).toBeNull();
      const clip = p.container.querySelector('video');
      if (w > 1 && h > 1) expect(clip).toHaveAttribute('src', '/cnn/store-sample.mp4');
      else expect(clip).not.toBeInTheDocument();
      p.unmount();
    }
  });
});

describe('live panel states (AC-1328·1330)', () => {
  it('renders the same live stage as detail in an expanded panel, with no sample clip', () => {
    fakeClient({});
    setCctvMode('live');
    const expanded = panel('customer-analysis', 2, 2);
    expect(within(expanded.container).getByTestId('cctv-live-stage')).toHaveAttribute('data-connection', 'live');
    expect(expanded.container.querySelector('video')).not.toBeInTheDocument();
  });
  it('1x1 with no camera: status line and a button, and the setup opens only by that button', async () => {
    fakeClient({ connection: 'none', frame: null, zones: null });
    setCctvMode('live');
    const { container, host } = panel('customer-analysis', 1, 1);
    expect(container).toHaveTextContent('연결된 카메라가 없어요');
    expect(host.openDetail).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /카메라 연결하기/ }));
    expect(host.openDetail).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'customer-analysis', view: 'setup' }));
  });
  it('lost hides the numbers and offers reconnecting; reconnecting keeps them', () => {
    const f = fakeClient({});
    setCctvMode('live');
    const { container } = panel('customer-analysis', 2, 1);
    expect(container.querySelector('[data-slot="customer-analysis.metric.value"]')).toHaveTextContent('2명');
    f.set({ connection: 'reconnecting' });
    expect(container.querySelector('[data-slot="customer-analysis.metric.value"]')).toHaveTextContent('2명');
    expect(container).toHaveTextContent('다시 연결하는 중이에요');
    f.set({ connection: 'lost', frame: null });
    expect(container.querySelector('[data-slot="customer-analysis.metric.value"]')).toBeNull();
    expect(container).toHaveTextContent('카메라 연결이 끊겼어요');
    expect(screen.getByRole('button', { name: /다시 연결하기/ })).toBeInTheDocument();
  });
  it('server down offers a retry that calls the client', async () => {
    const f = fakeClient({ connection: 'server-down', serverDown: 'unreachable', frame: null, zones: null });
    setCctvMode('live');
    const { container } = panel('customer-analysis', 1, 1);
    expect(container.querySelector('.cc-status')).toBeVisible();
    expect(container.querySelector('[data-slot="customer-analysis.metric.value"]')).toHaveTextContent('—');
    await userEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
    expect(f.retry).toHaveBeenCalled();
  });
  it('no table areas: the guests stay and the panel asks to set them', () => {
    fakeClient({ zones: zoneSet({ zones: [] }) });
    setCctvMode('live');
    const { container } = panel('customer-analysis', 2, 1);
    expect(container).toHaveTextContent('테이블 영역을 정해 주세요');
    expect(container.querySelector('[data-slot="customer-analysis.metric.value"]')).toHaveTextContent('2명');
  });
  it('the ⋯ menu is on W and larger, live only: reconnect opens the setup', async () => {
    fakeClient({});
    const mock = panel('customer-analysis', 2, 1);
    expect(mock.container.querySelector('[data-slot="customer-analysis.menu"]')).toBeNull();
    mock.unmount();
    setCctvMode('live');
    const q = panel('customer-analysis', 1, 1);
    expect(q.container.querySelector('[data-slot="customer-analysis.menu"]')).toBeNull();
    q.unmount();
    const w = panel('customer-analysis', 2, 1);
    await userEvent.click(within(w.container).getByRole('button', { name: '더 보기' }));
    await userEvent.click(screen.getByRole('menuitem', { name: '카메라 다시 연결' }));
    expect(w.host.openDetail).toHaveBeenCalledWith(expect.objectContaining({ view: 'setup' }));
  });
});

describe('detail by mode (D-230)', () => {
  it('mock is the 반복 5 CCTV 현황 detail with the toggle; live shows the camera numbers above the day record', () => {
    const mock = detail();
    expect(mock.container.querySelector('.mc-workspace')).toBeTruthy();
    expect(within(mock.container).getByRole('radio', { name: '예시' })).toBeChecked();
    expect(mock.container.querySelector('[data-testid="cctv-day-record"]')).toBeNull();
    mock.unmount();
    fakeClient({});
    setCctvMode('live');
    const live = detail();
    expect(live.container.querySelector('[data-testid="cctv-live-area"]')).toBeInTheDocument();
    expect(live.container.querySelector('video[src="/cnn/store-sample.mp4"]')).not.toBeInTheDocument();
    expect(live.container.querySelector('[data-testid="cctv-day-record"] .mc-detail')).toHaveTextContent('시간대별 방문과 근무 인원');
    expect(live.container.querySelector('[data-testid="cctv-day-record"]')).toHaveTextContent('예시');
    expect(live.container.querySelector('[data-testid="cctv-day-record"]')).toHaveTextContent('카메라 값이 아니에요');
    expect(live.container.querySelector('[data-testid="now-instore"]')).toHaveTextContent('2명');
  });
  it('live detail without a camera shows the setup (QR step) in the picture area', () => {
    fakeClient({ connection: 'none', frame: null, zones: null });
    setCctvMode('live');
    const { container } = detail();
    expect(container.querySelector('[data-testid="cctv-setup"]')).toBeTruthy();
  });
});

it('shows a way back to the example when live connection is unavailable', async () => {
 fakeClient({connection:'server-down',serverDown:'not-configured',frame:null,zones:null});
 setCctvMode('live');
 const d = detail();
 expect(within(d.container).getByText('실시간 연결이 아직 준비되지 않았어요. 예시 화면은 계속 볼 수 있어요')).toBeInTheDocument();
 await userEvent.click(within(d.container).getByRole('button',{name:'예시로 보기'}));
 expect(within(d.container).getByRole('radio',{name:'예시'})).toBeChecked();
});
