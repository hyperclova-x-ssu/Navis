import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { selectCustomOrders } from '../../../data/iteration7/custom-orders';
import { createWidgetDataStore, selectReservations, TODAY } from '../../../data/widget-data';
import type { WidgetDetailProps } from '../../../contracts';
import { CustomOrderProvider } from '../i7-custom/port';
import { createCustomTestSource } from '../i7-custom/test-source';
import { VoiceBookingDetail } from './voice-booking';
import { addTodayPickup } from './booking-test-fixtures';
import { orderNumber } from '../i7-custom/copy';
import { pickDateTime } from '../i7-custom/test-pickers';

afterEach(cleanup);
const widgetCss = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const props = { featureId: 'voice-booking', condition: { kind: 'default' }, detailRef: { featureId: 'voice-booking' }, host } as WidgetDetailProps;
describe('pickup and visit reservations remain separate', () => {
  it('keeps the visit count and people while pickup rows have no table or party', () => {
    const { port } = createCustomTestSource();
    const order = addTodayPickup(port);
    const store = createWidgetDataStore();
    renderWithKit(<CustomOrderProvider port={port}><style>{widgetCss}</style><VoiceBookingDetail {...props} /></CustomOrderProvider>, { store });
    const heading = screen.getByRole('heading', { name: '픽업 1건' });
    expect(heading).toBeVisible();
    expect(screen.queryByRole('heading', { name: '픽업' })).toBeNull();
    const visits = screen.getByRole('grid', { name: '예약 목록' });
    const today = selectReservations(store.getSnapshot(), { date: TODAY });
    expect(today).toMatchObject({ count: 4, partyTotal: 10 }); // the pickup is not a visit: no seat, no party
    expect(within(visits).getByText(today.rows[1]!.time)).toBeInTheDocument();
    const pickups = screen.getByRole('grid', { name: '픽업 예약' });
    expect(heading.parentElement).toContainElement(pickups);
    expect(document.getElementById(pickups.getAttribute('aria-labelledby')!)).toHaveClass('ui-sr-only');
    expect(within(pickups).getByText(order.productLabel)).toBeInTheDocument();
    expect(within(pickups).getAllByText('—')).toHaveLength(2);
  });
  it('reschedules the same pickup identity from reservation detail without editing visit data, and follows its end', async () => {
    const { port } = createCustomTestSource();
    const added = addTodayPickup(port);
    const id = selectCustomOrders(port.read()).orders.find(row => row.customOrderId === added.customOrderId)!.pickup!.reservationId;
    const store = createWidgetDataStore();
    renderWithKit(<CustomOrderProvider port={port}><VoiceBookingDetail {...props} /></CustomOrderProvider>, { store });
    const visitTimes = selectReservations(store.getSnapshot(), { date: TODAY }).rows.map(row => row.time);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`픽업 ${orderNumber(added.customOrderId)}`) }));
    await pickDateTime(/^픽업 날짜 /, /^픽업 시각 /, TODAY, '19:00');
    fireEvent.click(screen.getByRole('button', { name: '픽업 일시 고치기' }));
    expect(selectCustomOrders(port.read()).orders.find(row => row.customOrderId === added.customOrderId)).toMatchObject({ confirmedPickupAt: `${TODAY}T19:00`, pickup: { reservationId: id } });
    const visits = within(screen.getByRole('grid', { name: '예약 목록' }));
    for (const time of visitTimes) expect(visits.getByText(time)).toBeInTheDocument();
    // The pickup state comes from the same source: when the pickup ends (here cancelled: the sample has no settled payment to receive against) the count drops and the row says so.
    act(() => { port.dispatch({ type: 'pickup.cancel', reservationId: id, idempotencyKey: 'cancelled' }); });
    expect(screen.getByRole('heading', { name: '픽업 0건' })).toBeInTheDocument();
    expect(screen.getAllByText('취소').length).toBeGreaterThan(0);
  });
});
