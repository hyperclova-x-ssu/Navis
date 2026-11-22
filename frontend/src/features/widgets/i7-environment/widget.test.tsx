import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { PanelChromeContext } from '../../../ui/panel-chrome';
import { renderWithKit } from '../../../ui/test-utils';
import { DialogFrame } from '../../../ui/components/overlays';
import { EnvironmentDetail, EnvironmentPanel } from './widget';
import { createWidgetDataStore } from '../../../data/db/store';
import { useStoreEnvironment } from '../../../data/react';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { insightAdapter } from '../../../data/reality/10/adapter';
import { createEnvironmentWidget } from './module';
import { environmentView } from './source';

afterEach(cleanup);
/** Picks a time in the measurement form's kit time list (the field never takes typed text). */
async function pickMeasuredTime(form: HTMLElement, time: string) {
  fireEvent.click(within(form).getByRole('button', { name: /^측정 시각\(한국 시간\)/ }));
  fireEvent.click(await screen.findByRole('option', { name: time }));
}
const view ={ status: 'ready' as const, sensorStatus: 'connected' as const, current: { temperature: 22.5, humidity: 48 }, lastMeasuredAt: '15:40', ranges: { temperature: [18,25] as const, humidity: [40,60] as const }, trend: [{ time: '15:00', temperature: 22.5, humidity: 48 }], music: { deviceStatus: 'connected' as const, playing: true, volumePct: 55, track: '오후의 재즈 피아노', playlistId: 'p1', playlists: [{ playlistId: 'p1', name: '오후 잔잔한 로파이' }, { playlistId: 'p2', name: '아침 오픈 재즈' }] } };
const port = { setPlaying: vi.fn(), skipTrack: vi.fn(), setVolume: vi.fn(), selectPlaylist: vi.fn(), retry: vi.fn() };
describe('environment detail', () => {
  it('places HTTP measurements and the record form in the original climate section', async () => {
    const backend = fakeBackend();
    const asOf = '2026-11-17T06:45:00.000Z';
    let reading = { measuredAt: asOf, temperatureC: 29, humidityPct: 45 };
    const page = (items: readonly unknown[] = []) => ({ items, nextCursor: null, asOf, sourceRevision: 1 });
    for (const path of ['/insight/cameras', '/insight/zones', '/insight/table-links', '/insight/cctv-buckets', '/insight/cctv-reviews', '/pos/tables']) {
      backend.on('GET', path, () => page());
    }
    backend.on('GET', '/insight/environment-readings', () => page([reading]));
    backend.on('GET', '/insight/environment-summary', () => ({ current: reading, asOf, sourceRevision: 1, alerts: [],
      limits: { revision: 0, temperatureRange: [18, 25], humidityRange: [40, 60] } }));
    backend.on('POST', '/insight/environment-readings', ({ body }) => {
      reading = body as typeof reading;
      return { resourceId: 'reading', revision: 1, receiptId: 'receipt', affectedSources: ['environment.summary'] };
    });
    const store = createWidgetDataStore();
    store.bindReal(createRealPort({ store, adapters: [insightAdapter], source: () => 'http', fetch: backend.fetch }));
    const module = createEnvironmentWidget('store-environment', () => {
      const result = useStoreEnvironment();
      return { view: result.status === 'ready' ? environmentView(result.model) : { status: 'empty' }, port };
    });
    const Detail = module.Detail!;
    renderWithKit(<Detail featureId="store-environment" condition={{ kind: 'default' }} detailRef={{ featureId: 'store-environment', view: 'sensor' }}
      host={{ layer: 'management', resetPreview: vi.fn(), notify: vi.fn(), openDetail: vi.fn(), openLinked: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: () => true }} />, { store });
    const climate = await screen.findByRole('group', { name: '온도와 습도' });
    expect(within(climate).getByRole('group', { name: '현재 온도 29.0°C' })).toBeInTheDocument();
    expect(within(climate).getAllByRole('img')[0]).toHaveAccessibleName(/온도: 15:45 29°C/);
    expect(screen.getByRole('group', { name: '매장 음악' })).toBeInTheDocument();
    // FIX-RV3: the window opens as the original one; the entry form opens from its button inside the climate section.
    expect(within(climate).queryByRole('form', { name: '측정값 입력' })).toBeNull();
    expect(within(climate).queryByRole('form', { name: '적정 범위' })).toBeNull();
    fireEvent.click(within(climate).getByRole('button', { name: '측정값 입력하기' }));
    const form = within(climate).getByRole('form', { name: '측정값 입력' });
    // T-27 (gate r1a W11 D1): no browser date control ("2026. 11. 22. 오후 12:07"); the kit pickers show the weekday ("11월 17일 화요일").
    expect(form.querySelector('input[type="datetime-local"], input[type="date"], input[type="time"]')).toBeNull();
    expect(within(form).getByRole('button', { name: /^측정 날짜/ })).toHaveTextContent('11월 17일 화요일');
    expect(within(form).getByRole('button', { name: /^측정 시각\(한국 시간\)/ })).toHaveTextContent('15:45');
    await pickMeasuredTime(form, '15:40');
    fireEvent.change(within(form).getByLabelText('온도(°C)'), { target: { value: '22' } });
    fireEvent.change(within(form).getByLabelText('습도(%)'), { target: { value: '43' } });
    expect(backend.callsTo('POST', '/insight/environment-readings')).toHaveLength(0);
    const scrollIntoView = vi.fn(function (this: HTMLElement) { return this.textContent; });
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    try {
      await pickMeasuredTime(form, '23:55');
      fireEvent.submit(form);
      expect(within(form).getByRole('alert')).toHaveTextContent('현재 시각 이전의 측정 시각을 입력해 주세요');
      expect(backend.callsTo('POST', '/insight/environment-readings')).toHaveLength(0);
      await pickMeasuredTime(form, '15:40');
      fireEvent.submit(form);
      expect(await within(climate).findByRole('group', { name: '현재 온도 22.0°C' })).toBeInTheDocument();
      expect(await within(form).findByText('측정값을 저장했어요')).toBeInTheDocument();
      // The time list also scrolls its chosen option into view when it opens; only the result line is under test here.
      expect(scrollIntoView.mock.results.map(result => result.value).filter(text => !/^\d\d:\d\d$/.test(text))).toEqual([
        '현재 시각 이전의 측정 시각을 입력해 주세요', '측정값을 저장했어요',
      ]);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
    expect(backend.callsTo('POST', '/insight/environment-readings').map(call => call.body)).toEqual([
      { measuredAt: '2026-11-17T06:40:00.000Z', temperatureC: 22, humidityPct: 43 },
    ]);
  });

  // FIX leftover (gate r1a T-17): a refused save reads "실행하지 못했어요 · {이유}. {다음}" like every other widget, not the bare "저장하지 못했어요".
  it('says what was refused and what to do when the measurement is refused', async () => {
    const backend = fakeBackend();
    const asOf = '2026-11-17T06:45:00.000Z';
    const page = (items: readonly unknown[] = []) => ({ items, nextCursor: null, asOf, sourceRevision: 1 });
    for (const path of ['/insight/cameras', '/insight/zones', '/insight/table-links', '/insight/cctv-buckets', '/insight/cctv-reviews', '/pos/tables', '/insight/environment-readings']) {
      backend.on('GET', path, () => page());
    }
    backend.on('GET', '/insight/environment-summary', () => ({ current: null, asOf, sourceRevision: 1, alerts: [], limits: { revision: 0, temperatureRange: [18, 25], humidityRange: [40, 60] } }));
    backend.on('POST', '/insight/environment-readings', () => reply(409, { code: 'CONFLICT', reason: 'READING_REJECTED' }));
    const store = createWidgetDataStore();
    store.bindReal(createRealPort({ store, adapters: [insightAdapter], source: () => 'http', fetch: backend.fetch }));
    const module = createEnvironmentWidget('store-environment', () => {
      const result = useStoreEnvironment();
      return { view: result.status === 'ready' ? environmentView(result.model) : { status: 'empty' }, port };
    });
    const Detail = module.Detail!;
    renderWithKit(<Detail featureId="store-environment" condition={{ kind: 'default' }} detailRef={{ featureId: 'store-environment', view: 'sensor' }}
      host={{ layer: 'management', resetPreview: vi.fn(), notify: vi.fn(), openDetail: vi.fn(), openLinked: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: () => true }} />, { store });
    fireEvent.click(await screen.findByRole('button', { name: '측정값 입력하기' }));
    const form = screen.getByRole('form', { name: '측정값 입력' });
    fireEvent.change(within(form).getByLabelText('온도(°C)'), { target: { value: '22' } });
    fireEvent.change(within(form).getByLabelText('습도(%)'), { target: { value: '43' } });
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toHaveTextContent('실행하지 못했어요 · 현재 상태에선 진행할 수 없어요. 최신 내용을 확인해 주세요');
  });

  it('keeps both trend end values next to their own charts in the climate section', () => {
    render(<EnvironmentDetail view={view} port={port} />);
    const climate = screen.getByRole('group', { name: '온도와 습도' });
    const charts = within(climate).getAllByRole('img');
    expect(charts).toHaveLength(2);
    expect(charts[0]).toHaveAccessibleName(/온도: 15:00 22.5°C/);
    expect(charts[1]).toHaveAccessibleName(/습도: 15:00 48%/);
    expect(charts[0].closest('.i7-environment-trend-row')?.querySelector('strong')?.textContent).toBe('22.5°C');
    expect(charts[1].closest('.i7-environment-trend-row')?.querySelector('strong')?.textContent).toBe('48%');
  });
  it('shows readings and sends music controls to the shared source', () => {
    render(<EnvironmentDetail view={view} port={port} />);
    expect(screen.getAllByText('22.5°C').length).toBeGreaterThan(0); expect(screen.getAllByText('48%').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '일시정지' }));
    fireEvent.click(screen.getByRole('button', { name: '다음 곡' }));
    fireEvent.change(screen.getByLabelText('음량 조절'), { target: { value: '70' } });
    fireEvent.click(screen.getByRole('radio', { name: '아침 오픈 재즈' }));
    expect(port.setPlaying).toHaveBeenCalledWith(false); expect(port.skipTrack).toHaveBeenCalledWith('next'); expect(port.setVolume).toHaveBeenCalledWith(70); expect(port.selectPlaylist).toHaveBeenCalledWith('p2');
  });
  it('shows the source reading in every panel size', () => {
    for (const width of [1, 2, 3, 4]) for (const height of [1, 2, 3, 4]) {
      render(<EnvironmentPanel view={view} port={port} width={width} height={height} />);
      expect(screen.getByRole('group', { name: '온도와 습도' })).toBeTruthy();
      expect(screen.getByRole('group', { name: '매장 음악' })).toBeTruthy();
      expect(screen.getByLabelText('현재 온도 22.5°C')).toBeTruthy();
      expect(screen.getByLabelText('현재 습도 48%')).toBeTruthy();
      expect(screen.queryByText('적정 범위')).not.toBeInTheDocument();
      expect(screen.queryByText('연결됨(예시)')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      const hasControls = height > 1 || width >= 3;
      expect(screen.queryByRole('button', { name: '일시정지' }) !== null).toBe(hasControls);
      expect(document.querySelector('.tt-disc')?.getAnimations?.() ?? []).toHaveLength(0);
      cleanup();
    }
  });
  it('replaces only the compact artwork with abnormal status and highlights only the affected reading', () => {
    const { container, rerender } = render(<EnvironmentPanel view={{ ...view, current: { ...view.current, temperature: 28.5 } }} port={port} width={1} height={1} />);
    expect(screen.getByRole('status')).toHaveTextContent('적정 범위 벗어남');
    expect(container.querySelector('.tt')).toBeNull();
    expect(screen.getByLabelText('현재 온도 28.5°C')).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByLabelText('현재 습도 48%')).not.toHaveAttribute('data-tone', 'warning');
    rerender(<EnvironmentDetail view={{ ...view, sensorStatus: 'disconnected' }} port={port} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('연결 끊김');
    expect(screen.getByRole('status')).toHaveTextContent('센서 확인 필요');
    expect(screen.getByLabelText('현재 온도 22.5°C')).toHaveAttribute('data-tone', 'stale');
    rerender(<EnvironmentDetail view={view} port={port} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('적정 범위')).not.toBeInTheDocument();
    expect(screen.queryByText('연결됨(예시)')).not.toBeInTheDocument();
  });
  it('isolates every panel control and keeps them hidden and inert in editing and waiting', () => {
    const open = vi.fn();
    const { container, rerender } = render(<div onClick={open} onPointerDown={open} onPointerUp={open} onKeyDown={open}><EnvironmentPanel view={view} port={port} width={4} height={4} /></div>);
    fireEvent.click(screen.getByRole('button', { name: '이전 곡' }));
    fireEvent.pointerDown(screen.getByLabelText('음량 조절'));
    fireEvent.pointerUp(screen.getByLabelText('음량 조절'));
    fireEvent.keyDown(screen.getByLabelText('음량 조절'), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('radio', { name: '아침 오픈 재즈' }));
    expect(open).not.toHaveBeenCalled();
    for (const chrome of [{ editing: true, waiting: false }, { editing: false, waiting: true }]) {
      rerender(<PanelChromeContext value={chrome}><EnvironmentPanel view={view} port={port} width={4} height={4} /></PanelChromeContext>);
      expect(container.querySelector('.i7-environment-control-scope')).toHaveAttribute('inert');
      expect(container.querySelector('.i7-environment-control-scope')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.queryByRole('button', { name: '일시정지' })).not.toBeInTheDocument();
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    }
  });
  it('reports DEVICE_UNAVAILABLE, shows no controls and a next step when nothing is connected, and preserves retry', () => {
    const unavailable = { ...port, setPlaying: vi.fn(() => ({ ok: false, reason: 'DEVICE_UNAVAILABLE' })) };
    const { rerender } = render(<EnvironmentDetail view={view} port={unavailable} />);
    fireEvent.click(screen.getByRole('button', { name: '일시정지' }));
    expect(screen.getByRole('alert')).toHaveTextContent('연결된 음악 장치가 없어요');
    rerender(<EnvironmentDetail view={{ status: 'empty' }} port={port} />);
    const music = screen.getByRole('group', { name: '매장 음악' });
    expect(within(music).getByText('연결된 음악 장치가 없어요')).toBeInTheDocument();
    expect(within(music).getByText('음악 장치를 연결하면 바로 재생할 수 있어요')).toBeInTheDocument();
    // P-1 leftover: nothing to control, so no transport buttons, volume or playlists (they used to show disabled).
    expect(within(music).queryByRole('button')).toBeNull();
    expect(within(music).queryByRole('slider')).toBeNull();
    expect(within(music).queryByRole('radio')).toBeNull();
    const climate = screen.getByRole('group', { name: '온도와 습도' });
    expect(within(climate).getByText('연결된 센서가 없어요')).toBeInTheDocument();
    expect(within(climate).getByText('센서를 연결하면 온도와 습도가 여기에 보여요')).toBeInTheDocument();
    rerender(<EnvironmentDetail view={{ status: 'error' }} port={port} />);
    fireEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
    expect(port.retry).toHaveBeenCalled();
  });
  it('hides the music buttons in an empty panel (2x2 and up) and keeps the sentence', () => {
    for (const [width, height] of [[2, 2], [3, 2], [4, 4]]) {
      render(<EnvironmentPanel view={{ status: 'empty' }} port={port} width={width} height={height} />);
      const music = screen.getByRole('group', { name: '매장 음악' });
      expect(within(music).getByText('연결된 음악 장치가 없어요')).toBeInTheDocument();
      expect(within(music).queryByRole('button')).toBeNull();
      expect(within(music).queryByRole('slider')).toBeNull();
      cleanup();
    }
  });
  it('shows the retry in the window as the kit default 48 button, not the 44 panel action', () => {
    render(<EnvironmentDetail view={{ status: 'error' }} port={port} />);
    expect(screen.getByRole('alert')).toHaveTextContent('매장 환경 정보를 불러오지 못했어요');
    const retry = screen.getByRole('button', { name: '다시 시도하기' });
    expect(retry).toHaveClass('ui-button--default', 'ui-button--default');
    expect(retry).not.toHaveClass('ui-panel-action');
  });
  it('puts the hourly values in the kit Table: numeric columns flagged for right alignment, one body row per reading', () => {
    const trend = Array.from({ length: 5 }, (_, i) => ({ time: `${String(8 + i).padStart(2, '0')}:00`, temperature: 21.5 + i / 10, humidity: 46 + i }));
    render(<EnvironmentDetail view={{ ...view, trend }} port={port} />);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('ui-table', 'i7-environment-table');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.map(h => h.textContent)).toEqual(['시간', '온도', '습도']);
    expect(headers.map(h => h.getAttribute('data-numeric'))).toEqual([null, 'true', 'true']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(trend.length);
    expect(Array.from(rows[0].querySelectorAll('td')).map(td => [td.textContent, td.getAttribute('data-numeric')])).toEqual([['21.5°C', 'true'], ['46%', 'true']]);
    expect(rows[4].querySelector('th')?.textContent).toBe('12:00');
  });
  it('draws the abnormal state with the kit StatusChip (tone + icon + words) except in the 1x1 status box', () => {
    const { container, rerender } = render(<EnvironmentDetail view={{ ...view, current: { ...view.current, temperature: 28.5 } }} port={port} />);
    expect(container.querySelectorAll('.ui-status-chip')).toHaveLength(1);
    expect(container.querySelector('.ui-status-chip')).toHaveAttribute('data-tone', 'warning');
    rerender(<EnvironmentDetail view={{ ...view, sensorStatus: 'disconnected' }} port={port} />);
    expect(Array.from(container.querySelectorAll('.ui-status-chip')).map(chip => [chip.getAttribute('data-tone'), chip.textContent])).toEqual([['danger', '연결 끊김'], ['warning', '센서 확인 필요']]);
    rerender(<EnvironmentPanel view={{ ...view, current: { ...view.current, temperature: 28.5 } }} port={port} width={1} height={1} />);
    expect(container.querySelector('.ui-status-chip')).toBeNull();
    expect(container.querySelector('.i7-environment-status-block')).toHaveTextContent('적정 범위 벗어남');
  });
  it('pauses the same record animation for pause, hidden document and retained hidden detail, then resumes its angle', async () => {
    const animation = { pause: vi.fn(), play: vi.fn(), cancel: vi.fn(), currentTime: 450 };
    const animate = vi.fn(() => animation);
    Object.defineProperty(SVGElement.prototype, 'animate', { configurable: true, value: animate });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    try {
      const { container, rerender, unmount } = render(<div data-retained><EnvironmentDetail view={view} port={port} /></div>);
      expect(animate).toHaveBeenCalledWith([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 1800, easing: 'linear', iterations: Infinity });
      expect(animation.play).toHaveBeenCalled();
      rerender(<div data-retained><EnvironmentDetail view={{ ...view, music: { ...view.music, playing: false } }} port={port} /></div>);
      expect(animation.pause).toHaveBeenCalled();
      expect(animation.currentTime).toBe(450);
      rerender(<div data-retained><EnvironmentDetail view={view} port={port} /></div>);
      expect(animate).toHaveBeenCalledTimes(1);
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      fireEvent(document, new Event('visibilitychange'));
      expect(container.querySelector('.tt-disc')).toHaveAttribute('data-spin', 'paused');
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      fireEvent(document, new Event('visibilitychange'));
      expect(container.querySelector('.tt-disc')).toHaveAttribute('data-spin', 'running');
      await act(async () => { container.querySelector('[data-retained]')!.setAttribute('hidden', ''); });
      expect(container.querySelector('.tt-disc')).toHaveAttribute('data-spin', 'paused');
      await act(async () => { container.querySelector('[data-retained]')!.removeAttribute('hidden'); });
      expect(container.querySelector('.tt-disc')).toHaveAttribute('data-spin', 'running');
      expect(animation.currentTime).toBe(450);
      unmount();
      expect(animation.cancel).toHaveBeenCalledOnce();
      renderWithKit(<EnvironmentDetail view={view} port={port} />, { reducedMotion: true });
      expect(animate).toHaveBeenCalledTimes(1);
    } finally {
      delete (SVGElement.prototype as unknown as { animate?: unknown }).animate;
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
  });
  it('renders disconnected and empty/error sensor states', () => {
    const rendered = render(<EnvironmentDetail view={{ ...view, sensorStatus: 'disconnected' }} port={port} />);
    expect(screen.getByText('연결 끊김')).toBeTruthy();
    rendered.rerender(<EnvironmentDetail view={{ status: 'empty' }} port={port} />);
    expect(screen.getByText('연결된 센서가 없어요')).toBeTruthy();
    rendered.rerender(<EnvironmentDetail view={{ status: 'error' }} port={port} />);
    expect(screen.getByText('매장 환경 정보를 불러오지 못했어요')).toBeTruthy();
  });
  // BUG-004: the control scope stopped every keydown, Esc included, so once focus sat on a music chip the window's Esc handler never ran.
  it('closes the window with Esc after a playlist chip was pressed, and from the other music controls too', () => {
    const closeWith = (pick: () => HTMLElement, press = false) => {
      const onClose = vi.fn();
      renderWithKit(<DialogFrame open title="매장 환경" onClose={onClose}><EnvironmentDetail view={view} port={port} /></DialogFrame>);
      const control = pick();
      if (press) fireEvent.click(control);
      control.focus();
      fireEvent.keyDown(control, { key: 'Escape', code: 'Escape' });
      fireEvent.keyUp(control, { key: 'Escape', code: 'Escape' }); // the kit swallows the rest of a dismissing key press until it is released
      cleanup();
      return onClose;
    };
    const afterChip = closeWith(() => screen.getByRole('radio', { name: '아침 오픈 재즈' }), true);
    expect(port.selectPlaylist).toHaveBeenCalledWith('p2');
    expect(afterChip).toHaveBeenCalledTimes(1);
    expect(afterChip.mock.calls[0]![0]).toBe('Esc');
    expect(closeWith(() => screen.getByRole('button', { name: '다음 곡' }))).toHaveBeenCalledTimes(1);
    expect(closeWith(() => screen.getByLabelText('음량 조절'))).toHaveBeenCalledTimes(1);
  });
  it('still keeps the other keys of the music controls inside them (arrows must not reach the panel or page handlers)', () => {
    render(<EnvironmentPanel view={view} port={port} width={4} height={2} />);
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    try {
      for (const [control, key] of [[screen.getByLabelText('음량 조절'), 'ArrowRight'], [screen.getByRole('radio', { name: '아침 오픈 재즈' }), 'ArrowDown'], [screen.getByRole('button', { name: '다음 곡' }), 'Enter']] as const) fireEvent.keyDown(control, { key });
      expect(seen).not.toHaveBeenCalled();
      fireEvent.keyDown(screen.getByRole('button', { name: '다음 곡' }), { key: 'Escape' });
      expect(seen).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener('keydown', seen); }
  });
});
