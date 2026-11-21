import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CCTV_SNAPSHOT, HOURLY_DWELL, TODAY_AVG_DWELL_MIN, clearDetectionsCache, mockCctvView} from '../../../data/cctv';
import type {CctvView, DetectionsFile} from '../../../data/cctv';
import {screenPresets} from '../../../layout';
import {UiProvider} from '../../../ui';
import {CctvPlayback} from './CctvPlayback';
import {drawBoxes} from './drawBoxes';
import {snapshotView} from './snapshotView';
import {FULL_OVERLAY, PANEL_OVERLAY, placeLabels} from './overlayLayout';

const real = JSON.parse(readFileSync(resolve(process.cwd(), 'public/cnn/store-sample-detections.json'), 'utf8')) as DetectionsFile;
const host = (reducedMotion = true) => render(<UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion={reducedMotion}><CctvPlayback/></UiProvider>);
const stubFetch = (ok = true) => vi.stubGlobal('fetch', vi.fn(async () => (ok ? {ok: true, json: async () => real} : {ok: false, status: 404})));
const seekTo = (video: HTMLVideoElement, t: number) => { Object.defineProperty(video, 'currentTime', {value: t, writable: true, configurable: true}); act(() => {fireEvent.seeked(video);}); };
const nearest = (t: number) => real.frames.reduce((a, b) => Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a);

beforeEach(() => {
  clearDetectionsCache();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

describe('CctvPlayback', () => {
  it('shows the reviewed drink wait in the existing zone label and table state list after a seek', async () => {
    stubFetch();
    host();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'duration', {value: 86, configurable: true});
    act(() => {fireEvent.loadedMetadata(video);});
    await waitFor(() => expect(screen.getAllByText('왼쪽 나무 테이블 · 음료 기다리는 중 3초')).toHaveLength(2));
    seekTo(video, 80);
    expect(screen.getAllByText('왼쪽 나무 테이블 · 사용 중 · 받기까지 13초')).toHaveLength(2);
    expect(screen.getAllByText('가운데 흰 테이블 · 음료 기다리는 중 19초')).toHaveLength(2);
  });

  it('shows the fixed scene before the file loads, then the numbers of the playing frame', async () => {
    stubFetch();
    host();
    expect(screen.getByTestId('now-instore').textContent).toContain(String(CCTV_SNAPSHOT.inStore));
    expect(screen.getByTestId('now-seats').textContent).toContain(`${CCTV_SNAPSHOT.occupiedTables.length}/${CCTV_SNAPSHOT.tables.length}`);
    expect(screen.getByText('직접 찍은 매장 영상을 미리 분석했어요', { exact: true })).toBeTruthy();
    const video = document.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('/cnn/store-sample.mp4');
    Object.defineProperty(video, 'duration', {value: 86, configurable: true});
    Object.defineProperty(video, 'currentTime', {value: 40, writable: true, configurable: true});
    act(() => {fireEvent.loadedMetadata(video);});
    expect(video.currentTime).toBe(20);
    await waitFor(() => expect(screen.getByTestId('cctv-overlay')).toBeTruthy());
    seekTo(video, 40);
    const f = nearest(40);
    expect(screen.getByTestId('now-instore').textContent).toContain(String(f.counts.inStore));
    expect(screen.getByTestId('now-clear').textContent).toContain(String(f.counts.tablesToClear.length));
  });

  it('numbers follow the frame: seeking to another second changes them (AC-1326)', async () => {
    stubFetch();
    host();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'duration', {value: 86, configurable: true});
    Object.defineProperty(video, 'currentTime', {value: 20, writable: true, configurable: true});
    act(() => {fireEvent.loadedMetadata(video);});
    await waitFor(() => expect(screen.getByTestId('cctv-overlay')).toBeTruthy());
    const seen = new Set<string>();
    for (const at of [2, 20, 35, 60, 80]) { seekTo(video, at); seen.add(screen.getByTestId('now-instore').textContent!); expect(screen.getByTestId('now-instore').textContent).toContain(String(nearest(at).counts.inStore)); }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('renders the replay table states and matches the headcount to the rendered boxes', async () => {
    const video = await loaded();
    for (const time of [20, 60, 69, 78, 84]) {
      seekTo(video, time);
      const boxes = screen.getByTestId('cctv-overlay').querySelectorAll('.cctv-box--person');
      expect(screen.getByTestId('now-instore').textContent).toBe(`${boxes.length}명`);
      expect(screen.getByTestId('now-change').textContent).toBe(`5분 전보다 ▼ ${6 - boxes.length}명`);
      const counter = screen.getByTestId('cctv-overlay').querySelector('[data-zone="t3"]');
      const counts = nearest(time).counts;
      const counterState = counts.tablesToClear.includes('t3') ? 'clear' : counts.occupiedTables.includes('t3') ? 'occupied' : 'empty';
      expect(counter?.getAttribute('data-state')).toBe(counterState);
      if (time === 20) {
        const centre = screen.getByTestId('cctv-overlay').querySelector('[data-zone="t2"]');
        expect(centre?.getAttribute('data-state')).toBe('empty');
      }
    }
  });

  it('wrong JSON path: numbers stay at the fixed scene, no boxes, video still there (AC-1327)', async () => {
    stubFetch(false);
    host();
    await screen.findByRole('button', {name: '다시 불러오기'});
    expect(screen.getByTestId('now-instore').textContent).toContain(String(CCTV_SNAPSHOT.inStore));
    expect(screen.queryByTestId('cctv-overlay')).toBeNull();
    expect(document.querySelector('video')).toBeTruthy();
  });

  it('video error: fallback with reload, play disabled, numbers kept; reduced motion means no autoplay (AC-1327)', async () => {
    stubFetch();
    host();
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', {value: 0, writable: true, configurable: true});
    await act(async () => {await Promise.resolve();});
    act(() => {fireEvent.loadedMetadata(video);});
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    act(() => {fireEvent.error(video);});
    expect(screen.getByText('영상을 불러오지 못했어요')).toBeTruthy();
    expect(screen.getByText('숫자는 그대로 볼 수 있어요')).toBeTruthy();
    expect(screen.getByRole('button', {name: '다시 불러오기'})).toBeTruthy();
    for (const name of ['재생', '처음부터']) expect((screen.getByRole('button', {name: new RegExp(name)}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('slider', {name: '재생 위치'}) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('switch', {name: '반복 재생'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('switch', {name: '상자 보기'}) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('영상이 없어서 쓸 수 없어요')).toBeTruthy();
    expect(screen.getByTestId('now-instore').textContent).toContain(String(CCTV_SNAPSHOT.inStore));
  });

  it('autoplays without reduced motion', async () => {
    stubFetch();
    host(false);
    const video = document.querySelector('video')!;
    Object.defineProperty(video, 'duration', {value: 86, configurable: true});
    act(() => {fireEvent.loadedMetadata(video);});
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
});

const loaded = async (t = 72) => {
  stubFetch();
  host();
  const video = document.querySelector('video')! as HTMLVideoElement;
  Object.defineProperty(video, 'duration', {value: 86, configurable: true});
  Object.defineProperty(video, 'currentTime', {value: t, writable: true, configurable: true});
  act(() => {fireEvent.loadedMetadata(video);});
  await waitFor(() => expect(screen.getByTestId('cctv-overlay')).toBeTruthy());
  return video;
};

describe('CctvPlayback controls (SCR-25 PlayerControls)', () => {
  it('has play, from the start, a position slider with a spoken value, repeat and boxes', async () => {
    const video = await loaded(72);
    const slider = screen.getByRole('slider', {name: '재생 위치'}) as HTMLInputElement;
    expect(slider.getAttribute('aria-valuetext')).toBe('00분 20초 / 01분 26초');
    expect(slider.max).toBe('86');
    expect(screen.getByRole('button', {name: /재생/})).toBeTruthy();
    expect((screen.getByRole('switch', {name: '반복 재생'})).getAttribute('aria-checked')).toBe('true');
    expect(video.loop).toBe(true);
  });
  it('slider seeks, arrow keys move 5 seconds, from the start goes to 0', async () => {
    const video = await loaded(72);
    const slider = screen.getByRole('slider', {name: '재생 위치'});
    fireEvent.change(slider, {target: {value: '50'}});
    expect(video.currentTime).toBe(50);
    fireEvent.keyDown(slider, {key: 'ArrowRight'});
    expect(video.currentTime).toBe(55);
    fireEvent.keyDown(slider, {key: 'ArrowLeft'});
    fireEvent.keyDown(slider, {key: 'ArrowLeft'});
    expect(video.currentTime).toBe(45);
    fireEvent.click(screen.getByRole('button', {name: /처음부터/}));
    expect(video.currentTime).toBe(0);
  });
  it('repeat off stops at the end and the play button says play again', async () => {
    const video = await loaded(72);
    fireEvent.click(screen.getByRole('switch', {name: '반복 재생'}));
    expect(video.loop).toBe(false);
    act(() => {fireEvent.ended(video);});
    expect(screen.getByRole('button', {name: /다시 재생/})).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: /다시 재생/}));
    expect(video.currentTime).toBe(0);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });
  it('boxes switch hides person and cup boxes but keeps the table areas', async () => {
    await loaded();
    const before = document.querySelectorAll('.cctv-box--person').length;
    expect(before).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('switch', {name: '상자 보기'}));
    expect(document.querySelectorAll('.cctv-box--person').length).toBe(0);
    expect(document.querySelectorAll('[data-zone]').length).toBe(3);
  });
});

describe('CctvPlayback averages (SCR-346 mock column)', () => {
  it('draws one hourly bar per counted hour with direct labels and the day average (DATA_MODEL 12.7)', async () => {
    await loaded();
    const bars = screen.getAllByTestId('stay-hour');
    expect(bars.length).toBe(HOURLY_DWELL.length);
    expect(bars.map(b => b.getAttribute('aria-label') ?? b.textContent)).toEqual(HOURLY_DWELL.map(r => `${r.hour}시대 ${r.minutes}분`));
    expect(screen.getByText(`오늘 평균 머문 시간 ${TODAY_AVG_DWELL_MIN}분`)).toBeTruthy();
    expect(screen.getByText('시간대별 평균 머문 시간')).toBeTruthy();
  });
  it('draws a stay bar for each table with minutes and seconds and the 5 minute caption', async () => {
    await loaded();
    const rows = screen.getAllByTestId('stay-seat');
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toMatch(/\d+분 \d+초/);
    expect(screen.getByText('최근 5분 중 사용 중이던 시간')).toBeTruthy();
    expect(screen.getByText('자리별 머문 시간')).toBeTruthy();
  });
});

describe('CctvPlayback failure texts (VideoFallback)', () => {
  it('box data failure says so in place and reload brings the retry', async () => {
    stubFetch(false);
    host();
    expect(await screen.findByText('상자 정보를 불러오지 못했어요')).toBeTruthy();
    expect(screen.getByRole('button', {name: '다시 불러오기'})).toBeTruthy();
  });
  it('slow video shows the loading text after 300ms', async () => {
    stubFetch();
    vi.useFakeTimers();
    try {
      host();
      await act(async () => {vi.advanceTimersByTime(350);});
      expect(screen.getByText('영상을 불러오고 있어요')).toBeTruthy();
    } finally {vi.useRealTimers();}
  });
});

describe('drawBoxes', () => {
  const rect = {x: 0, y: 0, width: 960, height: 540};
  const f = mockCctvView(real, 20);
  const count = (el: Element) => ({p: el.querySelectorAll('.cctv-box--person').length, c: el.querySelectorAll('.cctv-box--cup').length, z: el.querySelectorAll('[data-zone]').length});
  it('draws persons, cups and zones of a CctvView; the panel option draws persons only', () => {
    const {container} = render(<>{drawBoxes(f, rect, FULL_OVERLAY)}</>);
    expect(count(container)).toEqual({p: f.persons.length, c: f.cups.length, z: f.tables.length});
    cleanup();
    const panel = render(<>{drawBoxes(f, rect, PANEL_OVERLAY)}</>);
    expect(count(panel.container)).toEqual({p: f.persons.length, c: 0, z: 0});
  });
  it('draws live rings and hides nothing when the view has no tables', () => {
    const live: CctvView = {...snapshotView(), mode: 'live', persons: [[0.1, 0.1, 0.2, 0.3]], tables: [{id: 'z1', label: {key: 'cctv.table.n', params: {n: 1}}, state: 'occupied', occupiedSeconds: null, rings: [[[0, 0], [0.5, 0], [0.5, 0.5]], [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9]]]}]};
    const {container} = render(<>{drawBoxes(live, rect, FULL_OVERLAY)}</>);
    expect(container.querySelectorAll('.cctv-zone--occupied').length).toBe(2);
    expect(count(container).p).toBe(1);
  });
});

describe('placeLabels', () => {
  it('moves an overlapping chip below the earlier one', () => {
    const out = placeLabels([{id: 'a', x: 0, y: 10, w: 100}, {id: 'b', x: 50, y: 12, w: 100}, {id: 'c', x: 300, y: 12, w: 50}]);
    expect(out.find(o => o.id === 'b')!.y).toBeGreaterThan(out.find(o => o.id === 'a')!.y + 20);
    expect(out.find(o => o.id === 'c')!.y).toBe(12);
  });
});
