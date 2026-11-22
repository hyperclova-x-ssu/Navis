import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectBriefing, selectWidget, TODAY } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { getRegistry } from '../../../catalog';
import { screenPresets } from '../../../layout';
import { createRunStore } from '../../../state';
import { timePolicy } from '../../../ui';
import { createWidgetHost } from '../registry-context';
import { BriefingPanel, BriefingDetail } from './briefing';
import { briefingOf, man, openingChecklist, storeWithAllAlerts, storeWithClosure, storeWithUrgentGrant } from './test-values';
import { addIsoDays } from './shared';

afterEach(cleanup);
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const condition = { kind: 'default' } as const;
const briefingCss = ['src/ui/tokens.css', 'src/ui/mastermanage.css', 'src/features/widgets/mgmt-money/widget.css']
  .map(path => readFileSync(path, 'utf8')).join('\n');

function renderBriefingAt(textScale: 100 | 125) {
  return renderWithKit(<>
    <style>{briefingCss}</style>
    <div className="ui-dialog--detail">
      <BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={host} />
    </div>
  </>, { textScale });
}

it.each([100, 125] as const)('keeps the briefing content and final actions in the scroller at %i percent', textScale => {
  renderBriefingAt(textScale);
  const body = screen.getByRole('region', { name: '출근' });
  const tabs = screen.getByRole('tablist', { name: '브리핑 보기' });
  const style = getComputedStyle(body);
  expect(style.overflowY).toBe('auto');
  expect(style.minHeight).toBe('0');
  expect(style.flexShrink).toBe('1');
  expect(style.overscrollBehavior).toBe('contain');
  expect(getComputedStyle(body.parentElement!).overflow).toBe('visible');
  expect(body).not.toContainElement(tabs);
  expect(tabs.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(body).toHaveAttribute('tabindex', '0');
  body.focus();
  expect(body).toHaveFocus();
  expect(within(body).getByRole('button', { name: '모두 읽음으로 표시하기' })).toBeInTheDocument();

  fireEvent.click(within(tabs).getByRole('tab', { name: '퇴근' }));
  const closing = screen.getByRole('region', { name: '퇴근' });
  expect(closing).toBe(body);
  expect(within(closing).getByRole('heading', { name: '오늘 결과 요약' })).toBeInTheDocument();
  expect(within(closing).getByRole('button', { name: '마감 정산하기' })).toBeInTheDocument();
}, 30_000);

it.each([[100, '56px'], [125, '64px']] as const)('aligns linked and plain briefing rows to the same height and divider at %i percent', (textScale, rowMin) => {
  renderBriefingAt(textScale);
  const schedule = screen.getByRole('heading', { name: '일정 브리핑' }).closest('section')!;
  // Today's group: the link row, the staff row, then one row per entry counted today.
  const model = briefingOf();
  const rows = within(within(schedule).getAllByRole('list')[0]!).getAllByRole('listitem');
  expect(rows).toHaveLength(2 + model.schedules.todayEntries.length);
  expect(getComputedStyle(schedule).gap).toBe('var(--space-4)');
  expect(getComputedStyle(schedule.closest('[data-text-scale]')!).getPropertyValue('--table-row-min').trim()).toBe(rowMin);
  for (const row of rows) {
    const style = getComputedStyle(row);
    expect(row).toHaveClass('mm-briefing-row');
    expect(style.minHeight).toBe('var(--table-row-min)');
    expect(style.alignItems).toBe('center');
  }
  expect(getComputedStyle(rows[1]!).borderBlockStart).toBe('var(--stroke-hairline) solid var(--border)');
  const link = within(rows[0]!).getByRole('button', { name: `오늘 일정 ${model.schedules.todayCount}개` });
  expect(link).toHaveClass('ui-button--ghost');
  // The chevron ends the row; a value or status chip, when there is one, sits just before it.
  expect(link.querySelector('.ui-press-surface > .mm-briefing-link__end > svg:last-child')).toBeInTheDocument();
  expect(rows[1]!.querySelector('button, svg')).toBeNull();
}, 30_000);

it('counts alert items and updates after the checklist and application', () => {
  const { store, noticeId } = storeWithUrgentGrant();
  renderWithKit(<BriefingPanel featureId="briefing" condition={condition} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} />, { store, textScale: 125, reducedMotion: true });
  const count = () => briefingOf(store).importantAlerts.count;
  const first = count();
  expect(screen.getByText(String(first))).toBeInTheDocument();
  const { manualId, open } = openingChecklist(store);
  act(() => { for (const stepNo of open) store.dispatch({ type: 'manuals.toggleStep', manualId, stepNo }); });
  expect(count()).toBe(first - 1);
  expect(screen.getByText(String(first - 1))).toBeInTheDocument();
  act(() => { store.dispatch({ type: 'grants.apply', noticeId, idempotencyKey: 'briefing-test' }); });
  expect(count()).toBe(first - 2);
  expect(screen.getByText(String(first - 2))).toBeInTheDocument();
});
it('opens the shared closing window from the closing briefing', async () => {
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={host} />);
  await userEvent.click(screen.getByRole('tab', { name: /퇴근/ }));
  await userEvent.click(screen.getByRole('button', { name: '마감 정산하기' }));
  expect(host.openClosing).toHaveBeenCalled();
});
it('shows the tax amount and deadline, reservation summary, and source navigation', async () => {
 const openLinked = vi.fn();
 const store = createWidgetDataStore();
 const model = briefingOf(store);
 const alert = model.importantAlerts.groups.find(group => group.id === 'tax')!.items[0]!;
 const taxPayment = (selectWidget(store.getSnapshot(), 'tax', condition, 'normal') as never as { model: { payments: { taxPaymentId: string; amount: number; dueOn: string }[] } }).model.payments.find(p => alert.id === `tax:${p.taxPaymentId}`)!;
 renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={{ ...host, openLinked }} />, { store });
 expect(screen.getByText(`오늘 ${model.reservations.count}건 · ${model.reservations.partyTotal}명`)).toBeInTheDocument();
 const [, month, day] = taxPayment.dueOn.split('-').map(Number);
 const alerts = within(screen.getByRole('heading', { name: /중요 알림/ }).closest('section')!);
 const tax = alerts.getByRole('button', { name: new RegExp(`원천세.*${man(taxPayment.amount).replace('.', '\\.')}만.*${month}/${day}`) });
 // The row ends with how long is left, as a status chip with its icon.
 expect(within(tax).getByText(/일 남음$/)).toBeInTheDocument();
 await userEvent.click(tax);
 expect(openLinked).toHaveBeenCalledWith({ featureId: 'tax', itemId: taxPayment.taxPaymentId });
});
it('keeps the tasks group for a missing order and disconnected camera after checklist and grant completion', () => {
 const { store, noticeId } = storeWithUrgentGrant();
 const { manualId, open } = openingChecklist(store);
 for (const stepNo of open) store.dispatch({ type: 'manuals.toggleStep', manualId, stepNo });
 store.dispatch({ type: 'grants.apply', noticeId, idempotencyKey: 'camera-test' });
 renderWithKit(<BriefingPanel featureId="briefing" condition={condition} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} />, { store, preview: { family: 'normal', overrides: { 'customer-analysis': 'camera-disconnected' } } });
 const withCamera = selectBriefing(store.getSnapshot(), { date: TODAY, viewContext: { cameraDisconnected: true } }).importantAlerts;
 // The checklist and the grant are done, so the tasks group is only there for the camera.
 expect(withCamera.groups.find(group => group.id === 'tasks')!.items.map(item => item.id.split(':')[0])).toEqual(['camera']);
 expect(screen.getByText(String(withCamera.count))).toBeInTheDocument();
});
it('summarizes schedules and reservations alongside alert groups in the square panel', () => {
 renderWithKit(<BriefingPanel featureId="briefing" condition={condition} width={2} height={2} shape="S" presetId="A" editing={false} host={host} />);
 // PRD 12.3 F-277 keeps the summary schedules and appends the staff handoff.
 const model = briefingOf(), staff = model.staff.today;
 expect(screen.getByText(`오늘 일정 ${model.schedules.todayCount}개`, { exact: false })).toHaveTextContent(`오늘 일정 ${model.schedules.todayCount}개 · 오늘 근무 ${staff.workingCount}명 · ${staff.nextHandoffAt} 교대`);
 expect(screen.getByText(`오늘 ${model.reservations.count}건 · ${model.reservations.partyTotal}명`)).toBeInTheDocument();
});

it('counts alert items and lists only the schedules counted today', () => {
 const store = createWidgetDataStore();
 const data = store.getSnapshot();
 const model = selectBriefing(data, {date:TODAY});
 expect(model.importantAlerts.count).toBe(model.importantAlerts.groups.flatMap(g=>g.items).length);
 renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{featureId:'briefing'}} host={host} />, {store});
 // Today's group holds the entries counted today; the next days are listed under their own headings.
 const today = within(screen.getByRole('heading', { name: '오늘의 주요 일정' }).closest('section')!.querySelector('ul')!);
 const [, month, day] = addIsoDays(TODAY, 1).split('-').map(Number);
 expect(today.queryByText(new RegExp(`${month}/${day}\\(`))).not.toBeInTheDocument();
 expect(today.queryByText(/^\d+\/\d+\(.\)/)).not.toBeInTheDocument();
 for (const entry of model.schedules.todayEntries) {
   if (entry.time) expect(today.getByText(new RegExp(`^${entry.time} `))).toBeInTheDocument();
 }
});

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const weekdayOf = (iso: string) => WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()]!;

it('shows the store-notice date with its weekday (K-C: short dates are M/D(요일))', () => {
  const { store, day } = storeWithClosure();
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={host} />, { store });
  const [, month, date] = day.split('-').map(Number);
  expect(screen.getByRole('button', { name: new RegExp(`^${month}/${date}\\(${weekdayOf(day)}\\) 임시 휴무 공지를 아직 안 보냈어요`) })).toBeInTheDocument();
  // The panel rows read the same sentence.
  cleanup();
  renderWithKit(<BriefingPanel featureId="briefing" condition={condition} width={2} height={3} shape="L" presetId="A" editing={false} host={host} />, { store });
  expect(document.body.textContent).toContain(`${month}/${date}(${weekdayOf(day)}) 임시 휴무 공지를 아직 안 보냈어요`);
});

it('ends every alert row with its value or status chip, then the chevron (SCR-226 G-13)', () => {
  const { store } = storeWithAllAlerts();
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={host} />, { store });
  const alerts = within(screen.getByRole('heading', { name: /중요 알림/ }).closest('section')!);
  const rows = alerts.getAllByRole('listitem');
  expect(rows).toHaveLength(briefingOf(store).importantAlerts.count);
  for (const row of rows) {
    const end = row.querySelector('.mm-briefing-link__end')!;
    expect(end.querySelector('svg:last-child'), row.textContent ?? '').not.toBeNull();
    expect((end.textContent ?? '').trim(), row.textContent ?? '').not.toBe('');
  }
  // Chips carry an icon with their words (done ✓ is not used here; waiting ◷ and warning ⚠ are).
  for (const chip of document.querySelectorAll('.mm-briefing-link__end .ui-status-badge')) expect(chip.querySelector('svg')).not.toBeNull();
});

it('splits the schedule card into today, scheduled and coming up', () => {
  const { store } = storeWithClosure();
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={host} />, { store });
  const card = screen.getByRole('heading', { name: '일정 브리핑' }).closest('section')!;
  expect(within(card).getByRole('heading', { name: '오늘의 주요 일정' })).toBeInTheDocument();
  // The unpaid tax is the first thing coming up, with its due date.
  const later = within(card).getByRole('heading', { name: '다가오는 일정' });
  expect(within(later.parentElement!).getByRole('button', { name: /원천세/ })).toBeInTheDocument();
});

it('opens tomorrow’s reservations from the closing tab, and keeps one primary button there', async () => {
  const openLinked = vi.fn();
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={{ ...host, openLinked }} />);
  await userEvent.click(screen.getByRole('tab', { name: /퇴근/ }));
  await userEvent.click(screen.getByRole('button', { name: /^내일 예약/ }));
  expect(openLinked).toHaveBeenCalledWith({ featureId: 'voice-booking', date: addIsoDays(TODAY, 1) });
  expect(screen.getByRole('button', { name: '마감 정산하기' })).toHaveClass('ui-button--secondary');
  expect(screen.getByRole('button', { name: '모두 읽음으로 표시하기' })).not.toHaveClass('ui-button--secondary');
});

it('follows the run: a chat acknowledgement turns the open detail button off (D-327)', () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  const live = createWidgetHost(run, { featureId: 'briefing', layer: 'management' });
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={live} />);
  const button = screen.getByRole('button', { name: '모두 읽음으로 표시하기' });
  expect(button).toBeEnabled();
  expect(screen.queryByRole('status')).toBeNull();
  act(() => { run.actions.acknowledgeBriefing(); });
  expect(button).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('오늘 브리핑은 다시 띄우지 않아요');
  cleanup();
  // A detail opened after the briefing was already acknowledged starts read.
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={live} />);
  expect(screen.getByRole('button', { name: '모두 읽음으로 표시하기' })).toBeDisabled();
  run.dispose();
});

it('keeps its own press state when the host has no run (previews)', async () => {
  const acknowledgeBriefing = vi.fn();
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={{ ...host, acknowledgeBriefing }} />);
  await userEvent.click(screen.getByRole('button', { name: '모두 읽음으로 표시하기' }));
  expect(acknowledgeBriefing).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '모두 읽음으로 표시하기' })).toBeDisabled();
});

/* FIX-PKG-A / T-02 (gate r1a W17-F2, G-13): a due-date entry that falls today carries what it is and a status chip, never only its label. */
it('shows today\'s tax due-date entry with a status chip and a link, not as a bare label', async () => {
  const tables = createWidgetDataStore().getSnapshot().tables;
  const store = createWidgetDataStore({
    calendarProjection: [{ source: 'tax-due', sourceId: 'tax-due-1', sourceRevision: 1, featureId: 'tax', categoryId: 'tax-admin', visibility: 'deadline', date: TODAY, endDate: null, time: null, title: '세금 납부 기한' }],
    calendarSettings: { ...tables.calendarSettings, deadline: true },
  } as never);
  renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={{ featureId: 'briefing' }} host={host} />, { store, reducedMotion: true });
  const card = screen.getByRole('heading', { name: '일정 브리핑' }).closest('section')!;
  const row = within(card).getByText(/세금 납부 기한/).closest('li')!;
  expect(within(row).getByText('오늘까지')).toBeInTheDocument();
  await act(async () => { fireEvent.click(within(row).getByRole('button')); });
  expect(host.openLinked).toHaveBeenCalledWith(expect.objectContaining({ featureId: 'tax', itemId: 'tax-due-1' }));
});
