// D-333 (LARGE-CARDS-2): the wide, tall 예약 card also shows the request and the way each booking came in, and writes them only when the data has them.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CellSpan, ContentShape, PreviewSelection } from '../../../contracts';
import { createWidgetDataStore, dataBundles, resolveDataText, selectReservations, TODAY } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { renderWithKit } from '../../../ui/test-utils';
import { VoiceBookingPanel } from './voice-booking';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
afterEach(cleanup);
const mount = (w: CellSpan, h: CellSpan, store = createWidgetDataStore(), preview?: PreviewSelection) =>
  renderWithKit(<VoiceBookingPanel featureId="voice-booking" condition={{ kind: 'default' }} host={host} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} />, { store, preview });
const headers = () => [...document.querySelectorAll('.mc-mini thead th')].map((th) => th.textContent);
const cells = (header: string) => {
  const index = headers().indexOf(header);
  return [...document.querySelectorAll('.mc-mini tbody tr')].map((row) => row.children[index]?.textContent);
};
const ko = createTranslator<string>('ko', ...dataBundles);
type Row = ReturnType<typeof selectReservations>['rows'][number];
/** The request of a booking the way the widget reads it: its own text, else its request key. */
const requestOf = (r: Row): string => resolveDataText((key, params) => ko.t(key, params), r.request) || (r.requestKey ? ko.t(r.requestKey) : '');
const rowsOf = (store = createWidgetDataStore()) => selectReservations(store.getSnapshot(), { date: TODAY }).rows;
const base = ['예약 일시', '예약자 정보', '예약 인원', '테이블', '상태'];

describe('예약 on large cards (D-333)', () => {
  it('4x4 adds the way each booking came in (경로) and, for bookings that have one, the request (요청사항)', () => {
    const rows = rowsOf();
    expect(rows.some((r) => requestOf(r))).toBe(true);
    mount(4, 4);
    expect(headers()).toEqual(['예약 일시', '예약자 정보', '예약 인원', '테이블', '요청사항', '경로', '상태']);
    expect(cells('경로')).toEqual(rows.map((r) => (r.source === 'phone_ai' ? '전화 AI' : '직접 추가함')));
    expect(cells('요청사항')).toEqual(rows.map((r) => requestOf(r) || '—'));
  });
  it('shows a booking made with a request next to the others', () => {
    const store = createWidgetDataStore();
    act(() => { expect(store.dispatch({ type: 'booking.create', idempotencyKey: 'large-cards-2', date: TODAY, time: '20:00', partySize: 2, guest: { name: '시험 손님' }, request: '창가 자리 부탁드려요', tableChoice: 'auto' }).ok).toBe(true); });
    mount(4, 4, store);
    expect(cells('요청사항')).toContain('창가 자리 부탁드려요');
    expect(cells('요청사항')).toHaveLength(rowsOf(store).length);
  });
  it('writes no 요청사항 column when no booking has a request', () => {
    const store = createWidgetDataStore();
    const snapshot = store.getSnapshot();
    const plain = { ...snapshot, tables: { ...snapshot.tables, reservation: snapshot.tables.reservation.map((r) => ({ ...r, requestKey: null, request: null })) } };
    mount(4, 4, { ...store, getSnapshot: () => plain } as unknown as typeof store);
    expect(headers()).toEqual(['예약 일시', '예약자 정보', '예약 인원', '테이블', '경로', '상태']);
  });
  it('keeps the shorter and narrower cards as before: five columns', () => {
    for (const [w, h] of [[4, 2], [3, 3], [3, 2]] as const) {
      mount(w, h);
      expect(headers()).toEqual(base);
      cleanup();
    }
  });
  it('writes no table when the data has no booking', () => {
    mount(4, 4, createWidgetDataStore(), { family: 'empty', overrides: {} });
    expect(document.querySelector('.mc-mini')).toBeNull();
  });
});
