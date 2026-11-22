import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { KitProviders } from '../../../ui/test-utils';
import { DetailDialog } from '../../../ui';
import { CustomOrderProvider } from '../i7-custom/port';
import { createCustomTestSource } from '../i7-custom/test-source';
import { MembersDetail } from './members';
import { MenuDetail } from '../mgmt-products/menu';
import { VoiceBookingDetail } from './voice-booking';
import { CustomerAnalysisDetail } from './customer-analysis';
import { addTodayPickup } from './booking-test-fixtures';
import { orderNumber } from '../i7-custom/copy';
import { createWidgetDataStore, selectReservations, TODAY } from '../../../data/widget-data';

const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const style = document.createElement('style');
style.textContent = ['src/ui/tokens.css', 'src/ui/mastermanage.css', 'src/features/widgets/mgmt-customers/widgets.css', 'src/features/widgets/mgmt-products/pos-menu.css']
 .map(file => readFileSync(file, 'utf8')).join('\n');
document.head.append(style);
afterEach(cleanup);

it.each(['members', 'memberships', 'menu', 'customer-analysis'] as const)('%s detail bounds the grid within the available height', kind => {
 const condition = { kind: 'default' as const };
 const detail = kind === 'members' || kind === 'memberships'
  ? <MembersDetail featureId="members" condition={condition} host={host} detailRef={{featureId:'members', view:kind === 'memberships' ? 'memberships' : 'list'}}/>
  : kind === 'menu' ? <MenuDetail featureId="menu" condition={condition} host={host} detailRef={{featureId:'menu'}}/>
  : <CustomerAnalysisDetail featureId="customer-analysis" condition={condition} host={host} detailRef={{featureId:'customer-analysis'}}/>;
 const {container} = render(<KitProviders>{detail}</KitProviders>);
 const grid = container.querySelector<HTMLElement>('.ui-data-grid')!;
 const root = container.querySelector<HTMLElement>('.mc-workspace')!;
 expect(root).not.toBeNull();
 const rootStyle = getComputedStyle(root);
 expect(rootStyle.height).toBe(kind === 'customer-analysis' ? 'auto' : '100%');
 expect(rootStyle.minHeight).toBe('0');
 expect(rootStyle.display).toBe('flex');
 expect(rootStyle.flexDirection).toBe('column');
 const gridParent = grid.parentElement!;
 if (gridParent !== root) {
  const section = getComputedStyle(gridParent);
  expect(section.minHeight).toBe('0');
  expect(section.flexGrow).toBe(kind === 'customer-analysis' ? '0' : '1');
  expect(section.display).toBe('flex');
 }
 const context = root.querySelector<HTMLElement>('.mc-grid-context');
 if (kind === 'customer-analysis') {
  expect(context).not.toBeNull();
  const contextStyle = getComputedStyle(context!);
  expect(contextStyle.minHeight).toBe('0');
  expect(contextStyle.flexGrow).toBe('0');
  expect(contextStyle.overflow).toBe('visible');
  expect(grid.closest('[lang=ko]')).not.toBeNull();
 }
 const gridStyle = getComputedStyle(grid);
 expect(gridStyle.minHeight).toBe('0');
 expect(gridStyle.flexGrow).toBe('1');
});

it.each([
 ['ko', '시간대별 예약', ['시간', '예약 건수', '인원']],
 ['en', 'Bookings by time', ['Time', 'Bookings', 'People']],
] as const)('renders the booking time table headers in %s', (locale, caption, labels) => {
 render(<KitProviders locale={locale}>
  <VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} host={host} detailRef={{ featureId: 'voice-booking' }} />
 </KitProviders>);
 const disclosure = screen.getByText(caption, { selector: 'summary' }).parentElement!;
 expect(disclosure).not.toHaveAttribute('open');
 disclosure.setAttribute('open', '');
 const table = screen.getByRole('table', { name: caption });
 const headers = within(table).getAllByRole('columnheader');
 expect(headers.map(header => header.textContent)).toEqual(labels);
 for (const header of headers) expect(header).toBeVisible();
 for (const header of headers.slice(1)) {
  expect(header).toHaveClass('mc-booking-time__number');
  expect(getComputedStyle(header).textAlign).toBe('end');
 }
});

it.each([100, 125] as const)('예약 상세는 %i 퍼센트에서 창 본문을 스크롤하지 않고, 위쪽 부분은 제 높이를 지키며 예약 표만 남는 높이를 쓴다', textScale => {
 const { port } = createCustomTestSource();
 const pickup = addTodayPickup(port);
 const today = selectReservations(createWidgetDataStore().getSnapshot(), { date: TODAY });
 render(<KitProviders textScale={textScale} reducedMotion>
  <CustomOrderProvider port={port}>
   <DetailDialog open title="예약" popupStyle={{ opacity: 1 }} onClose={() => {}}>
    <VoiceBookingDetail featureId="voice-booking" condition={{kind:'default'}} host={host} detailRef={{featureId:'voice-booking'}}/>
   </DetailDialog>
  </CustomOrderProvider>
 </KitProviders>);
 const dialog = screen.getByRole('dialog', { name: '예약' });
 const body = dialog.querySelector('.ui-overlay-body')!;
 const root = body.querySelector('.mc-workspace')!;
 // K-A #2 / DS 12.2: the workspace is the height of the window body (so the body never needs to scroll); the reservation grid takes what is left
 expect(getComputedStyle(root).height).toBe('100%');
 expect(getComputedStyle(root).minHeight).toBe('0');
 expect(getComputedStyle(root).display).toBe('flex');
 expect(getComputedStyle(root).flexDirection).toBe('column');
 const grid = within(dialog).getByRole('grid', { name: '예약 목록' });
 const gridRoot = grid.closest('.ui-data-grid')!;
 const content = gridRoot.parentElement!;
 expect(content).toHaveClass('mc-booking-content');
 expect(content.parentElement).toBe(root);
 expect(getComputedStyle(content).overflowY).toBe('auto');
 expect(getComputedStyle(gridRoot).flexGrow).toBe('1');
 expect(getComputedStyle(gridRoot).minBlockSize).toBe('var(--booking-table-min)');
 const fixed = Array.from(content.children).filter(child => !child.matches('.ui-data-grid'));
 expect(fixed.length).toBeGreaterThanOrEqual(3);
 expect(fixed.map(section => getComputedStyle(section).flexShrink)).toEqual(fixed.map(() => '0'));
 const context = root.querySelector('.mc-booking-toolbar')!;
 const stepper = within(context as HTMLElement).getByRole('group', { name: '날짜' });
 const add = within(context as HTMLElement).getByRole('button', { name: '예약 추가하기' });
 expect(add).toHaveClass('ui-button--secondary');
 expect(add.parentElement).toBe(stepper.parentElement);
 expect(getComputedStyle(add).minHeight).toBe('var(--target-default)');
 expect(getComputedStyle(add).marginInlineStart).toBe('auto');

 // the summary row: the count and the four status chips (read only), the free seats; no big cards
 const summary = within(dialog).getByRole('region', { name: '예약 현황' });
 expect(summary).toHaveTextContent(`오늘 예약 ${today.count}건`);
 for (const label of ['예약 대기', '예약 확정', '방문 완료', '취소']) expect(summary).toHaveTextContent(label);
 expect(summary).toHaveTextContent(`좌석 여유 ${today.availability.value}석`);
 expect(dialog.querySelector('.mc-kpis')).toBeNull();

 // the time table is the kit Table: header 48 (var), sticky, rows at the table row minimum, numbers right aligned
 within(dialog).getByText('시간대별 예약', { selector: 'summary' }).parentElement!.setAttribute('open', '');
 const timeTable = within(dialog).getByRole('table', { name: '시간대별 예약' });
 expect(timeTable).toHaveClass('ui-table');
 const headers = within(timeTable).getAllByRole('columnheader');
 expect(headers.map(header => header.textContent)).toEqual(['시간', '예약 건수', '인원']);
 for (const header of headers) {
  expect(getComputedStyle(header).position).toBe('sticky');
  expect(getComputedStyle(header).height).toBe('calc(var(--table-header-height) + var(--stroke-hairline))');
 }
 const timeRows = within(timeTable).getAllByRole('row').slice(1);
 expect(timeRows.map(row => within(row).getByRole('rowheader').textContent)).toEqual(today.timeGroups.map(group => group.time));
 for (const row of timeRows) {
  expect(getComputedStyle(row).height).toBe('var(--table-row-min)');
  for (const cell of within(row).getAllByRole('cell')) {
   expect(cell).toHaveClass('mc-booking-time__number');
   expect(getComputedStyle(cell).textAlign).toBe('end');
  }
 }
 const first = today.timeGroups[0]!;
 expect(within(timeRows[0]!).getAllByRole('cell').map(cell => cell.textContent)).toEqual([`${first.count}건`, `${first.partyTotal}명`]);
 // the band (time table, pickups) keeps a capped height and scrolls inside past that
 const wrap = timeTable.closest('.mc-booking-time-wrap')!;
 expect(getComputedStyle(wrap).maxHeight).toBe('var(--mc-band-max)');
 expect(getComputedStyle(wrap).overflow).toBe('auto');

 const pickupGrid = within(dialog).getByRole('grid', { name: '픽업 예약' });
 expect(getComputedStyle(pickupGrid.closest('.mc-booking-pickups')!).maxHeight).toBe('var(--mc-band-max)');
 expect(getComputedStyle(pickupGrid.querySelector('thead')!).position).toBe('sticky');

 expect(within(dialog).queryByRole('form', { name: '예약 고치기' })).not.toBeInTheDocument();
 fireEvent.click(within(grid).getByRole('gridcell', { name: new RegExp(`${(today.rows[1]!.name as { raw: string }).raw}.*예약자 정보`) }));
 const panel = within(dialog).getByRole('region', { name: `${today.rows[1]!.time} · ${(today.rows[1]!.name as { raw: string }).raw}` });
 expect(panel).toHaveClass('ui-detail-side-panel');
 // the kit overlay: a sibling of the grid, anchored to the workspace so the window body does not scroll and the grid beside it shrinks
 expect(panel.parentElement).toBe(root);
 expect(panel.dataset.layout).toBe('overlay');
 expect(getComputedStyle(panel).position).toBe('absolute');
 expect(panel.previousElementSibling).toContainElement(grid);
 expect(panel).toContainElement(within(dialog).getByRole('form', { name: '예약 고치기' }));
 expect(within(panel).getByRole('button', { name: '예약 취소하기' }).closest('[data-panel-slot="danger"]')).not.toBeNull();
 const order = within(pickupGrid).getByRole('button', { name: new RegExp(`픽업 ${orderNumber(pickup.customOrderId)}`) });
 expect(getComputedStyle(order).fontSize).toBe('inherit');
 expect(getComputedStyle(order).fontWeight).toBe('inherit');
});
