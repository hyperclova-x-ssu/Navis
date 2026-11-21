import { CCTV_SNAPSHOT } from '../../../data/cctv';
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeatureId, Locale, PreviewSelection, WidgetHost, WidgetModule } from '../../../contracts';
import { findDuplicateKeys, findKoGaps } from '../../../i18n/bundles';
import type { MessageBundle } from '../../../i18n';
import { baseBundles } from '../../../i18n/messages';
import { createTranslator } from '../../../i18n';
import { dataBundle } from '../../../data/widget-data';
import { createWidgetDataStore, selectMembers, selectReservations, selectWidget, TODAY, type WidgetDataStore } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { bundles, customersBundle, r2Review, widgets } from './index';
import { cctvBundle, setCctvMode } from '../../cctv';
import { sourcedRows, writtenRows } from './messages';
import { proposalTimes, upcomingSlots } from './voice-booking';
import { pastConfirmedBooking } from './booking-test-fixtures';

afterEach(cleanup);
const locales: readonly Locale[] = ['ko', 'en', 'zh-Hans', 'zh-Hant'];
const mod = (id: FeatureId): WidgetModule => widgets.find((w) => w.id === id)!;
const makeHost = () => ({ layer: 'management', resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) }) satisfies WidgetHost;
const previewOf = (id: FeatureId, variant: string): PreviewSelection => ({ family: 'normal', overrides: { [id]: variant } });
type Opts = { locale?: Locale; store?: WidgetDataStore; preview?: PreviewSelection; width?: number; height?: number; textScale?: 100 | 125 };
function panel(id: FeatureId, opts: Opts = {}) {
  const host = makeHost();
  const Panel = mod(id).Panel;
  const view = renderWithKit(<Panel featureId={id} condition={{ kind: 'default' }} width={(opts.width ?? 1) as 1} height={(opts.height ?? 1) as 1} shape="Q" presetId="A" editing={false} host={host} />, { locale: opts.locale, store: opts.store, preview: opts.preview, textScale: opts.textScale });
  return { host, ...view };
}
function detail(id: FeatureId, opts: Opts = {}) {
  const host = makeHost();
  const Detail = mod(id).Detail!;
  const view = renderWithKit(<Detail featureId={id} condition={{ kind: 'default' }} detailRef={{ featureId: id }} host={host} />, { locale: opts.locale, store: opts.store, preview: opts.preview });
  return { host, ...view };
}
const slot = (container: HTMLElement, name: string) => container.querySelector(`[data-slot="${name}"]`);

describe('bundle shape and messages', () => {
  it('exports the three active modules, with independent demand and membership panels absent (API-201)', () => {
    expect(widgets.map((w) => w.id)).toEqual(['customer-analysis', 'members', 'voice-booking']);
    for (const w of widgets) { expect(w.Detail).not.toBeNull(); expect(typeof w.useSummary).toBe('function'); expect(typeof w.Panel).toBe('function'); }
    expect(bundles).toEqual([customersBundle, cctvBundle]);
  });
  it('has non-empty Korean and resolves every key in four languages with ko fallback (API-213)', () => {
    const keys = Object.keys(customersBundle.ko);
    for (const lang of ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const) {
      const translator = createTranslator<string>(lang, customersBundle);
      for (const key of keys) {
        const params = Object.fromEntries([...new Set(locales.flatMap(locale => [...((customersBundle[locale] as Readonly<Record<string,string>>)[key] ?? '').matchAll(/\{(\w+)/g)].map(match => match[1])))].map(name => [name, /^(n|count|hour|people|staff|visits|s|e)$/.test(name) ? 2 : '예시']));
        const value = translator.t(key, params);
        expect(value, `${lang} ${key}`).not.toBe('');
        expect(value, `${lang} ${key}`).not.toBe(key);
      }
    }
    expect(findKoGaps(customersBundle)).toEqual([]);
    expect(findDuplicateKeys(customersBundle, dataBundle, ...(baseBundles as unknown as readonly MessageBundle<string>[]))).toEqual([]);
    expect(r2Review.rows).toBe(Object.keys(writtenRows).length);
    expect(Object.keys(sourcedRows).length).toBeGreaterThan(8);
  });
  it('keeps the plan-1 / DS 11.11 key tables letter by letter', () => {
    expect(customersBundle.ko['widget.customer-analysis.todayVisits']).toBe('방문 감지');
    expect(customersBundle.en['widget.customer-analysis.staffOnShift']).toBe('Staff on shift');
    expect(customersBundle.ko['widget.voice-booking.needsReview']).toBe('확인 필요 {count}건');
  });
  it('reservation helpers propose later times', () => {
    expect(proposalTimes('17:00')).toEqual(['17:30', '18:00', '18:30']);
    // the view starts one hour before the clock (15:45): the 14:30 table is gone, the 14:45 one is the first kept
    expect(upcomingSlots([{ time: '11:00', count: 4, people: 8, seatsFree: 10 }, { time: '14:30', count: 1, people: 3, seatsFree: 15 }, { time: '14:45', count: 1, people: 2, seatsFree: 15 }, { time: '17:00', count: 2, people: 8, seatsFree: 10 }]).map((s) => s.time)).toEqual(['14:45', '17:00']);
  });
});

describe('all widgets: 16 sizes x 4 languages never show a message key (AC-210·214)', () => {
  const ids: FeatureId[] = ['customer-analysis', 'members', 'voice-booking'];
  for (const id of ids) {
    it(`${id}: renders the panel in every size and language without keys`, () => {
      for (const locale of locales) {
        for (const width of [1, 2, 3, 4]) {
          for (const height of [1, 2, 3, 4]) {
            const { container, unmount } = panel(id, { locale, width, height });
            const text = container.textContent ?? '';
            expect(text, `${id} ${locale} ${width}x${height}`).not.toMatch(/widget\.|data\.|common\.|unit\.|format\./);
            expect(container.querySelector('[data-slot$=".metric.value"]')).toBeTruthy();
            unmount();
          }
        }
      }
    });
    it(`${id}: detail renders in every language without keys`, () => {
      for (const locale of locales) {
        const { container, unmount } = detail(id, { locale });
        expect(container.textContent ?? '', `${id} ${locale}`).not.toMatch(/widget\.|data\.|common\.|unit\.|format\./);
        unmount();
      }
    });
    it(`${id}: error state shows the retry action that resets only this widget`, async () => {
      const { host, container } = panel(id, { preview: previewOf(id, 'error') });
      expect(slot(container, `${id}.state.message`)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
      expect(host.resetPreview).toHaveBeenCalledTimes(1);
    });
  }
});

/** The CCTV model the widget draws, read through the same selector (café sample, D-313): expectations follow it instead of literals. */
const cctvModel = (variant = 'normal') => {
  const view = selectWidget(createWidgetDataStore().getSnapshot(), 'customer-analysis', { kind: 'default' }, variant);
  if (view.status !== 'ready') throw new Error(`customer-analysis is ${view.status}`);
  return view.model;
};

describe('CCTV 손님분석 (AC-250·251)', () => {
  it('1x1 shows today\'s visits as an estimate; 2x1 adds the peak hour visits and staff; the camera chip counts the cameras', () => {
    const m = cctvModel();
    const peak = m.peak!;
    const q = panel('customer-analysis');
    // D-323: the big number is the headcount right now (the detail's 지금 숫자 source); today's visits are the smaller secondary line
    expect(slot(q.container, 'customer-analysis.metric.value')).toHaveTextContent(String(CCTV_SNAPSHOT.inStore));
    expect(q.container).toHaveTextContent('지금 숫자');
    expect(q.container).toHaveTextContent(`방문 감지 ${m.totalVisits}건`);
    q.unmount();
    const w = panel('customer-analysis', { width: 2, height: 1 });
    expect(w.container).toHaveTextContent('붐빈 시간과 근무');
    expect(w.container.querySelector(`[data-row-id="h${peak.hour}-visits"]`)).toHaveTextContent(`${peak.hour}시대 방문${peak.visits}건`);
    expect(w.container.querySelector(`[data-row-id="h${peak.hour}-staff"]`)).toHaveTextContent(`${peak.hour}시대 근무${peak.staff}명`);
    w.unmount();
    const big = panel('customer-analysis', { width: 2, height: 2 });
    expect(big.container).toHaveTextContent(`카메라 ${m.cameras.length}대 정상`);
  });
  it('2x3 adds one hourly bar per counted hour below the still frame, with the hour unit (SCR-221)', () => {
    const m = cctvModel();
    const { container } = panel('customer-analysis', { width: 2, height: 3 });
    expect(container.querySelectorAll('.mc-bar')).toHaveLength(m.hours.length);
    expect(container.querySelector(`[data-bar-id="h${m.peak!.hour}"]`)).toHaveAttribute('data-tone', 'peak');
    for (const h of m.hours) expect(container.querySelector(`[data-bar-id="h${h.hour}"] .mc-bar__label`)).toHaveTextContent(`${h.hour}시`);
  });
  it('detail: the peak hour shows its visits and staff, marks the hour once (shape marker, no staff evaluation)', async () => {
    const m = cctvModel();
    const peak = m.peak!;
    const { host, container } = detail('customer-analysis');
    expect(container).toHaveTextContent(`방문 ${peak.visits}건 · 근무 ${peak.staff}명`);
    expect(container).toHaveTextContent('방문 감지는 사람 수가 아니에요');
    expect(slot(container, 'customer-analysis.metric.value')).toHaveTextContent(String(m.totalVisits));
    const mark = screen.getByRole('button', { name: '다음 근무표에서 살펴보기' });
    await userEvent.click(mark);
    expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.notice.peakMarked' }));
    expect(screen.getByRole('button', { name: '다음 근무표에서 살펴보기' })).toBeDisabled();
    expect(container.querySelector(`[data-bar-id="h${peak.hour}"] [data-marker="review"]`)).toBeTruthy();
    expect(container).toHaveTextContent('살펴볼 시간');
  });
  it('detail: another hour can be picked from the chart', async () => {
    const m = cctvModel();
    const other = m.hours.find((h) => h.hour !== m.peak!.hour && h.status === 'ok' && h.visits !== null)!;
    const { container } = detail('customer-analysis');
    await userEvent.click(container.querySelector(`[data-bar-id="h${other.hour}"]`)!);
    expect(container).toHaveTextContent(`방문 ${other.visits}건 · 근무 ${other.staff}명`);
  });
  it('gaps: shows the missing hour as ‘일부 시간 미집계’ and keeps the visits (AC-251)', () => {
    const m = cctvModel('gaps');
    const kept = m.hours.find((h) => h.status === 'ok' && h.visits !== null)!;
    const { container } = detail('customer-analysis', { preview: previewOf('customer-analysis', 'gaps') });
    expect(container).toHaveTextContent('일부 시간 미집계');
    expect(container).toHaveTextContent('미집계');
    expect(container.querySelector('[data-bar-id="h12"] [data-marker="gap"]')).toBeTruthy();
    expect(container.querySelector(`[data-bar-id="h${kept.hour}"]`)).toHaveTextContent(String(kept.visits));
  });
  it('no entries is 0 visits (not an error); no shifts keeps the visits; no coverage says it cannot be counted', () => {
    const zero = panel('customer-analysis', { preview: previewOf('customer-analysis', 'no-entries') });
    expect(zero.container).toHaveTextContent('방문 감지 0건'); // the secondary line; the big number is the headcount (D-323)
    zero.unmount();
    const none = panel('customer-analysis', { preview: previewOf('customer-analysis', 'no-shifts'), width: 2, height: 1 });
    expect(none.container).toHaveTextContent('근무표가 없어서 방문만 보여요');
    expect(none.container).toHaveTextContent(String(cctvModel('no-shifts').totalVisits));
    none.unmount();
    const empty = panel('customer-analysis', { preview: previewOf('customer-analysis', 'no-coverage') });
    expect(empty.container).toHaveTextContent('집계할 수 없어요');
  });
  it('detail states keep a next step: 0 visits and 집계 불가 offer the camera check (H1), the failed state retries', async () => {
    const zero = detail('customer-analysis', { preview: previewOf('customer-analysis', 'no-entries') });
    expect(zero.container).toHaveTextContent('오늘은 아직 감지된 방문이 없어요');
    expect(within(zero.container).getByRole('button', { name: '카메라 연결 확인하기' })).toBeInTheDocument();
    zero.unmount();
    const empty = detail('customer-analysis', { preview: previewOf('customer-analysis', 'no-coverage') });
    expect(empty.container).toHaveTextContent('집계할 수 없어요');
    await userEvent.click(within(empty.container).getByRole('button', { name: '카메라 연결 확인하기' }));
    expect(empty.container.querySelector('[data-widget="customer-analysis"][data-mode="live"]')).toBeTruthy();
    setCctvMode('mock');
    empty.unmount();
    const failed = detail('customer-analysis', { preview: { family: 'error', overrides: {} } });
    expect(within(failed.container).getByRole('button', { name: '다시 시도하기' })).toBeInTheDocument();
    expect(within(failed.container).queryByRole('button', { name: '카메라 연결 확인하기' })).toBeNull();
  });
});

describe('음성 예약확정 (AC-227·256·257)', () => {
  // The café sample (D-313): every number is read from the selector the widget draws, never typed in.
  const todayOf = (variant = 'normal') => selectReservations(createWidgetDataStore().getSnapshot(), { date: TODAY, variant });
  const modelOfBooking = (variant = 'normal') => {
    const view = selectWidget(createWidgetDataStore().getSnapshot(), 'voice-booking', { kind: 'default' }, variant);
    if (view.status !== 'ready') throw new Error(`voice-booking is ${view.status}`);
    return view.model;
  };
  const guestOf = (row: { name: unknown }) => typeof row.name === 'string' ? row.name : 'raw' in (row.name as object) ? (row.name as { raw: string }).raw : '장○○';
  it('1x1: today\'s reservations and the ones to review; 1x2 lists every time; 2x1 the next two', () => {
    const rv = todayOf();
    const q = panel('voice-booking');
    expect(slot(q.container, 'voice-booking.metric.value')).toHaveTextContent(String(rv.count));
    expect(q.container).toHaveTextContent(`대기 ${rv.needsCheckCount}건`);
    q.unmount();
    const t = panel('voice-booking', { width: 1, height: 2 });
    for (const g of rv.timeGroups) expect(t.container.querySelector(`[data-row-id="${g.time}"]`)).toHaveTextContent(`${g.count}건 · ${g.partyTotal}명`);
    t.unmount();
    const w = panel('voice-booking', { width: 2, height: 1 });
    // the view starts one hour before the clock (15:45): from 14:45 on
    expect([...w.container.querySelectorAll('.mc-row')].map((r) => r.getAttribute('data-row-id'))).toEqual(rv.timeGroups.filter((g) => g.time >= '14:45').slice(0, 2).map((g) => g.time));
  });
  const needs = previewOf('voice-booking', 'needs-confirmation');
  it('needs-confirmation state: one more reservation to review, over the seats', () => {
    const rv = todayOf('needs-confirmation'), over = modelOfBooking('needs-confirmation').slots.find((s) => s.seatsFree < 0)!;
    const { container } = panel('voice-booking', { preview: needs, width: 2, height: 2 });
    expect(slot(container, 'voice-booking.metric.value')).toHaveTextContent(String(rv.count));
    expect(container).toHaveTextContent(`대기 ${rv.needsCheckCount}건`);
    expect(container).toHaveTextContent(`${-over.seatsFree}석 초과`);
  });
  const OVER = 'sample-booking-over-capacity';
  const overRow = () => todayOf('needs-confirmation').rows.find((r) => r.reservationId === OVER)!;
  const summaryOf = (container: HTMLElement) => container.querySelector('.mc-booking-summary')!;
  it('confirm keeps the count and takes one off the reservations to review (AC-256)', async () => {
    const store = createWidgetDataStore(), before = todayOf('needs-confirmation');
    const { host, container } = detail('voice-booking', { store, preview: needs });
    await userEvent.click(container.querySelector(`[data-grid-row="${OVER}"] [data-grid-column-id="guest"]`)!);
    const panel = within(screen.getByRole('region', { name: `${overRow().time} · ${guestOf(overRow())}` }));
    await userEvent.click(panel.getByRole('button', { name: new RegExp(`${guestOf(overRow())}, ${overRow().time} 예약 확정`) }));
    expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.management.notice.bookingConfirmed' }));
    expect(summaryOf(container)).toHaveTextContent(`${before.count}건`);
    expect(summaryOf(container)).toHaveTextContent(`예약 대기 ${before.needsCheckCount - 1}건`);
    expect(panel.getByRole('status')).toHaveTextContent('예약을 확정했어요');
  });
  it('suggest another time takes the booking out of the count and shows a ‘제안함’ badge (AC-256)', async () => {
    const store = createWidgetDataStore(), before = todayOf('needs-confirmation');
    const { host, container } = detail('voice-booking', { store, preview: needs });
    await userEvent.click(container.querySelector(`[data-grid-row="${OVER}"] [data-grid-column-id="guest"]`)!);
    const panel = within(screen.getByRole('region', { name: `${overRow().time} · ${guestOf(overRow())}` }));
    await userEvent.click(panel.getByRole('button', { name: new RegExp(`${guestOf(overRow())}, ${overRow().time} 예약에 다른 시간 제안`) }));
    expect(panel.getByRole('button', { name: '제안하기' })).toBeDisabled();
    const [first] = proposalTimes(overRow().time);
    await userEvent.click(panel.getByRole('radio', { name: first! }));
    await userEvent.click(panel.getByRole('button', { name: '제안하기' }));
    expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.management.notice.saved' }));
    expect(summaryOf(container)).toHaveTextContent(`${before.count - 1}건`);
    expect(container.querySelector(`[data-grid-row="${OVER}"]`)).toHaveTextContent('제안함');
  });
  it('call summary shows the connection (sample), the extracted values and no recording', async () => {
    const call = modelOfBooking('needs-confirmation').calls.find((c) => c.callId === overRow().callId)!;
    const { container } = detail('voice-booking', { preview: needs });
    await userEvent.click(container.querySelector(`[data-grid-row="${OVER}"] [data-grid-column-id="guest"]`)!);
    const summary = within(screen.getByRole('region', { name: `${overRow().time} · ${guestOf(overRow())}` })).getByRole('region', { name: '통화 요약' });
    expect(summary).toHaveTextContent('전화 연결됨(예시)');
    expect(summary).toHaveTextContent('녹음은 보관하지 않고 요약만 남겨요');
    expect(summary.querySelector('.mc-call__summary')).toHaveTextContent('예약을 원해요');
    // the extracted values follow the booking (the sample's one-line summary still names 17:00 / 20명: reported to the data owner)
    expect(summary.querySelector('.mc-extracted')).toHaveTextContent(call.extracted.time);
    expect(summary.querySelector('.mc-extracted')).toHaveTextContent(`${call.extracted.party}명`);
    expect(summary.querySelector('audio')).toBeNull();
  });
  it('direct bookings have no call; a confirmed booking before the time cannot be marked no-show, after it can', async () => {
    const future = todayOf().rows.find((r) => r.status === 'confirmed')!;
    const { container } = detail('voice-booking');
    await userEvent.click(container.querySelector(`[data-grid-row="${future.reservationId}"] [data-grid-column-id="guest"]`)!);
    const later = within(screen.getByRole('region', { name: `${future.time} · ${guestOf(future)}` }));
    expect(later.getByRole('region', { name: '통화 요약' })).toHaveTextContent('전화 통화 없이 직접 넣었어요');
    expect(later.getByRole('button', { name: new RegExp(`${guestOf(future)}, ${future.time} 예약을 오지 않음으로 바꾸기`) })).toBeDisabled();
    cleanup();
    // the 13:49 booking, set back to confirmed, is a confirmed booking whose time has passed
    const { store, row: past } = pastConfirmedBooking(), count = selectReservations(store.getSnapshot(), { date: TODAY }).count;
    const view = detail('voice-booking', { store });
    await userEvent.click(view.container.querySelector(`[data-grid-row="${past.reservationId}"] [data-grid-column-id="guest"]`)!);
    const earlier = within(screen.getByRole('region', { name: `${past.time} · ${guestOf(past)}` }));
    await userEvent.click(earlier.getByRole('button', { name: new RegExp(`${guestOf(past)}, ${past.time} 예약을 오지 않음으로 바꾸기`) }));
    expect(view.container.querySelector(`[data-grid-row="${past.reservationId}"]`)).toHaveTextContent('오지 않음');
    expect(summaryOf(view.container)).toHaveTextContent(`${count}건`);
  });
  it('empty and phone-disconnected states (AC-257)', async () => {
    expect(panel('voice-booking', { preview: previewOf('voice-booking', 'none') }).container).toHaveTextContent('오늘 예약이 없어요');
    cleanup();
    const off = panel('voice-booking', { preview: previewOf('voice-booking', 'phone-disconnected') });
    expect(off.container).toHaveTextContent('전화 연결이 필요해요');
    await userEvent.click(screen.getByRole('button', { name: /연결하기\(예시\)/ }));
    expect(off.host.resetPreview).toHaveBeenCalledTimes(1);
  });
});

describe('summaries and 125% text', () => {
  const members = selectMembers(createWidgetDataStore().getSnapshot(), {});
  it('useSummary sentences are complete in each language', () => {
    for (const locale of locales) {
      for (const id of ['customer-analysis', 'members', 'voice-booking'] as const) {
        const Probe = () => <p data-testid="s">{mod(id).useSummary({ featureId: id, condition: { kind: 'default' } })}</p>;
        const view = renderWithKit(<Probe />, { locale });
        const text = view.getByTestId('s').textContent ?? '';
        expect(text.length, `${id} ${locale}`).toBeGreaterThan(6);
        expect(text).not.toMatch(/widget\.|data\./);
        view.unmount();
      }
    }
    const Ko = () => <p data-testid="k">{mod('members').useSummary({ featureId: 'members', condition: { kind: 'default' } })}</p>;
    expect(renderWithKit(<Ko />).getByTestId('k')).toHaveTextContent(`회원 ${members.total}명, 이용 중 회원권 ${members.membershipCount}개`);
  });
  it('renders at 125% text without keys or a different value', () => {
    const { container } = panel('members', { textScale: 125, width: 2, height: 2 });
    expect(slot(container, 'members.metric.value')).toHaveTextContent(String(members.total));
  });
});
