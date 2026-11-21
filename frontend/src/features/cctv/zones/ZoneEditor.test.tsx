import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithKit } from '../../../ui/test-utils';
import { ZoneEditor } from './ZoneEditor';
import { ZonesApiError, type ZonesApi } from './api';
import { keepDraft } from './editor-state';
import { encodeRle } from './mask';
import { CELLS, GRID, type Zone, type ZoneSet } from './types';

const rect = (c0: number, r0: number, c1: number, r1: number) => {
  const m = new Uint8Array(CELLS);
  for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) m[r * GRID.cols + c] = 1;
  return m;
};
const sug = (id: string, cells: Uint8Array): Zone => ({ id, number: 0, source: 'suggested', mask: encodeRle(cells) });
const EMPTY: ZoneSet = { revision: 0, savedAt: null, frameAspect: null, zones: [] };

function fakeApi(over: Partial<ZonesApi> = {}): ZonesApi & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; suggest: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async () => EMPTY),
    // Suggestions: A at cells (10..30, 10..20), B at (100..120, 10..20).
    suggest: vi.fn(async () => ({ zones: [sug('zsugaaaa1', rect(10, 10, 30, 20)), sug('zsugbbbb2', rect(100, 10, 120, 20))], frameAspect: 16 / 9 })),
    put: vi.fn(async (body: { zones: readonly Zone[] }) => ({ revision: 1, savedAt: '2026-11-10T00:00:00Z', frameAspect: 16 / 9, zones: body.zones })),
    ...over,
  } as never;
}

// Stage is 1600 x 900 px, so one cell = 10 px.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ left: 0, top: 0, right: 1600, bottom: 900, width: 1600, height: 900, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
  keepDraft(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); keepDraft(null); });

const stage = () => screen.getByTestId('zone-stage');
/** Visible text (not the polite announcer copy). */
const shown = (text: string | RegExp) => screen.getAllByText(text).filter(el => el.getAttribute('data-testid') !== 'zone-announce');
const zoneEl = (id: string) => stage().querySelector(`[data-zone="${id}"]`);
const down = (x: number, y: number) => fireEvent.pointerDown(stage(), { pointerId: 1, clientX: x, clientY: y, button: 0, pointerType: 'touch' });
const move = (x: number, y: number) => fireEvent.pointerMove(stage(), { pointerId: 1, clientX: x, clientY: y, pointerType: 'touch' });
const up = (x: number, y: number) => fireEvent.pointerUp(stage(), { pointerId: 1, clientX: x, clientY: y, pointerType: 'touch' });
const tap = (x: number, y: number) => { down(x, y); up(x, y); };
const drag = (pts: [number, number][]) => { down(...pts[0]); for (const p of pts.slice(1)) move(...p); up(...pts[pts.length - 1]); };

async function openFresh(api = fakeApi()) {
  const onSaved = vi.fn(); const onClose = vi.fn();
  const r = renderWithKit(<ZoneEditor api={api} onSaved={onSaved} onClose={onClose} background={<div data-testid="frame" />} />);
  await waitFor(() => expect(zoneEl('zsugaaaa1')).not.toBeNull());
  return { ...r, api, onSaved, onClose };
}

describe('ZoneEditor (SCR-349)', () => {
  it('AC-1335: asks for suggestions once and shows them dotted; tap adopts (solid, Table 1)', async () => {
    const { api } = await openFresh();
    expect(api.suggest).toHaveBeenCalledTimes(1);
    expect(screen.getByText('처음이시죠?')).toBeInTheDocument();
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'false');
    expect(screen.getAllByText('추천')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '완료' })).toBeDisabled();
    tap(200, 150);
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'true');
    expect(screen.getByText('테이블 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '완료' })).toBeEnabled();
    // Tapping again selects it (delete button).
    tap(200, 150);
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-selected', 'true');
    expect(within(stage()).getByRole('button', { name: '테이블 1 지우기' })).toBeInTheDocument();
  });

  it('AC-1336: dragging around draws a closed zone; a tiny drawing makes none and says so', async () => {
    await openFresh();
    drag([[500, 500], [700, 500], [700, 650], [500, 650]]); // left open: closes itself
    const drawn = stage().querySelectorAll('[data-adopted="true"]');
    expect(drawn).toHaveLength(1);
    expect(screen.getByText('테이블 1')).toBeInTheDocument();
    drag([[900, 800], [915, 800], [915, 812]]);
    expect(stage().querySelectorAll('[data-adopted="true"]')).toHaveLength(1);
    expect(shown('테이블을 빙 둘러 그려 주세요')).toHaveLength(1);
  });

  it('AC-1337/1339: eraser removes part of a suggested zone, long press deletes it with a ring, undo restores, can redraw', async () => {
    await openFresh();
    fireEvent.click(screen.getByRole('button', { name: /지우개/ }));
    drag([[100, 150], [140, 150]]);
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'true');
    expect(screen.getByText('테이블 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /둘러 그리기/ }));

    vi.useFakeTimers();
    down(1100, 150);
    expect(screen.getByTestId('long-press-ring')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(300); });
    up(1100, 150); // short release cancels: still there and not adopted
    expect(zoneEl('zsugbbbb2')).toHaveAttribute('data-adopted', 'false');
    down(250, 150);
    act(() => { vi.advanceTimersByTime(500); });
    up(250, 150);
    expect(zoneEl('zsugaaaa1')).toBeNull();
    expect(shown('테이블 1을 지웠어요')).toHaveLength(1);
    vi.useRealTimers();

    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /되돌리기/ }));
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'true');
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /되돌리기/ }));
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'false');
    fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: /되돌리기/ }));
    expect(within(screen.getByRole('toolbar')).getByRole('button', { name: /되돌리기/ })).toBeDisabled();
  });

  it('AC-1338: undo one step at a time, then Done saves the adopted zones and closes only after success', async () => {
    const { api, onSaved } = await openFresh();
    tap(200, 150); tap(1100, 150);
    expect(screen.getByText('테이블 2')).toBeInTheDocument();
    fireEvent.keyDown(stage(), { key: 'z', ctrlKey: true });
    expect(screen.queryByText('테이블 2')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '완료' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const body = api.put.mock.calls[0][0];
    expect(body.baseRevision).toBe(0);
    expect(body.zones.map((z: Zone) => [z.id, z.number])).toEqual([['zsugaaaa1', 1]]);
  });

  it('AC-1341: a failed save keeps the editor and the drawing, with the reason and Try again', async () => {
    let fail = true;
    const api = fakeApi({ put: vi.fn(async (b: { zones: readonly Zone[] }) => { if (fail) throw new ZonesApiError('UNREACHABLE', 'cctv.conn.serverUnreachable'); return { revision: 1, savedAt: 'x', frameAspect: 1.78, zones: b.zones }; }) as never });
    const { onSaved } = await openFresh(api);
    tap(200, 150);
    fireEvent.click(screen.getByRole('button', { name: '완료' }));
    await screen.findByRole('alert');
    expect(shown('저장하지 못했어요. 다시 시도해 주세요')).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'true');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('409 conflict keeps the draft and retries on the current revision', async () => {
    const current: ZoneSet = { revision: 4, savedAt: 'x', frameAspect: 1.78, zones: [] };
    const put = vi.fn().mockRejectedValueOnce(new ZonesApiError('REVISION_CONFLICT', 'k', current)).mockImplementation(async (b: { zones: readonly Zone[] }) => ({ revision: 5, savedAt: 'x', frameAspect: 1.78, zones: b.zones }));
    const { onSaved } = await openFresh(fakeApi({ put: put as never }));
    tap(200, 150);
    fireEvent.click(screen.getByRole('button', { name: '완료' }));
    await screen.findByRole('alert');
    expect(shown(/다른 곳에서 바뀌었어요/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '다시 시도하기' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(put.mock.calls[1][0].baseRevision).toBe(4);
  });

  it('Close keeps the draft in page memory; reopening continues without loading', async () => {
    const { onClose, unmount } = await openFresh();
    tap(200, 150);
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalled();
    unmount();
    const api2 = fakeApi();
    renderWithKit(<ZoneEditor api={api2} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'true');
    expect(api2.get).not.toHaveBeenCalled();
    expect(api2.suggest).not.toHaveBeenCalled();
  });

  it('AC-1340: saved zones open adopted with no suggestion call and the guide folded', async () => {
    const saved: ZoneSet = { revision: 2, savedAt: 'x', frameAspect: 16 / 9, zones: [{ id: 'zsaved001', number: 1, source: 'drawn', mask: encodeRle(rect(40, 40, 60, 60)) }] };
    const api = fakeApi({ get: vi.fn(async () => saved) as never });
    renderWithKit(<ZoneEditor api={api} onSaved={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(zoneEl('zsaved001')).toHaveAttribute('data-adopted', 'true'));
    expect(api.suggest).not.toHaveBeenCalled();
    expect(screen.queryByText('처음이시죠?')).toBeNull();
    expect(screen.getByRole('button', { name: '사용법' })).toBeInTheDocument();
  });

  it('shows the no-suggestion guidance when the server finds none', async () => {
    const api = fakeApi({ suggest: vi.fn(async () => ({ zones: [], frameAspect: 1.78 })) as never });
    renderWithKit(<ZoneEditor api={api} onSaved={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('추천할 테이블을 찾지 못했어요. 손가락으로 둘러 그려 주세요')).toBeInTheDocument();
  });

  it('keyboard path: the table list adopts and deletes', async () => {
    await openFresh();
    fireEvent.click(screen.getAllByRole('button', { name: '채택' })[0]);
    expect(zoneEl('zsugaaaa1')).toHaveAttribute('data-adopted', 'true');
    fireEvent.click(screen.getByRole('button', { name: '테이블 1 지우기' }));
    expect(zoneEl('zsugaaaa1')).toBeNull();
  });
});
