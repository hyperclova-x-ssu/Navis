// REAL-PLAN F12: the briefing detail over HTTP shows the service's sources with their period and state, withholds what is not connected,
// and records the owner's explicit acknowledgement once, the same one in a new session.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import type { WidgetHost } from '../../../contracts';
import { reply } from '../../../data/reality/00/testing';
import { ackKey, briefingDay, briefingSession } from '../../../data/reality/12/testing';
import { BriefingDetail } from './briefing';

afterEach(cleanup);
const host = (dismissed = false): WidgetHost => ({
  layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(),
  briefingAcknowledged: { subscribe: () => () => undefined, getSnapshot: () => dismissed },
});
const detail = (store: ReturnType<typeof briefingSession>['store'], ui: WidgetHost) =>
  renderWithKit(<BriefingDetail featureId="briefing" condition={{ kind: 'default' }} detailRef={{ featureId: 'briefing' }} host={ui} />, { store, reducedMotion: true });

it('shows every source with its period and state, Navis records apart from what NAVER reported, and withholds what is not connected', async () => {
  const { store } = briefingSession();
  detail(store, host());
  const card = await screen.findByRole('region', { name: '출처와 기준' });
  const navis = within(card).getByRole('heading', { name: 'Navis 기록·초안' }).closest('[data-group]') as HTMLElement;
  const naver = within(card).getByRole('heading', { name: '네이버에서 확인한 것' }).closest('[data-group]') as HTMLElement;
  expect(within(navis).getByText('오늘 매출·입금').closest('li')).toHaveAttribute('data-state', 'ready');
  expect(within(navis).getByText('발주·입고').closest('li')).toHaveAttribute('data-state', 'partial');
  expect(within(navis).getByText('CCTV').closest('li')).toHaveAttribute('data-state', 'unavailable');
  expect(within(navis).getByText('예약').closest('li')).toHaveAttribute('data-state', 'not-connected');
  expect(within(navis).getByText('재고 소비기한').closest('li')).toHaveTextContent('지금 상태');
  // NAVER-reported statistics keep the period the provider returned and are not mixed into Navis' own records.
  expect(within(naver).getByText('스마트콜 통화').closest('li')).toHaveTextContent('11/10');
  expect(within(naver).queryByText('예약')).not.toBeInTheDocument();
  expect(within(navis).queryByText('스마트콜 통화')).not.toBeInTheDocument();
  // The reservation section says so instead of showing rows the seed holds; the tax alerts are gone, not shown as zero.
  expect(screen.getAllByRole('note').some(note => /예약\s·\s아직 연결 전이에요/.test(note.textContent ?? ''))).toBe(true);
  expect(screen.queryByText(/세금 납부/)).not.toBeInTheDocument();
  // The upcoming-schedule list does not borrow the seed's next tax payment while the service has no tax source.
  expect(screen.queryByText(/원천세/)).not.toBeInTheDocument();
}, 30_000);

it('records one acknowledgement from the explicit press, shows it, and a new session shows the same one with no second write', async () => {
  const { store, backend, state, open } = briefingSession();
  const ui = host();
  detail(store, ui);
  const press = await screen.findByRole('button', { name: '모두 읽음으로 표시하기' });
  expect(press).toBeEnabled();
  await userEvent.click(press);
  await userEvent.click(press); // a double press while pending adds no second request
  await waitFor(() => expect(screen.getByText('오늘 브리핑은 다시 띄우지 않아요')).toBeInTheDocument());
  expect(backend.callsTo('POST', `/insight/briefings/${briefingDay}/ack`)).toHaveLength(1);
  expect(backend.callsTo('POST', `/insight/briefings/${briefingDay}/ack`)[0]!.headers.get('idempotency-key')).toBe(ackKey(briefingDay));
  expect(ui.acknowledgeBriefing).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '모두 읽음으로 표시하기' })).toBeDisabled();
  expect(screen.getByText(/에 확인했어요/)).toBeInTheDocument();
  expect(state.acknowledgements).toBe(1);
  cleanup();
  // Reload / new session: the acknowledgement comes from the service, the button is already done, nothing is written.
  const next = open();
  detail(next.store, host());
  await waitFor(() => expect(screen.getByText('오늘 브리핑은 다시 띄우지 않아요')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: '모두 읽음으로 표시하기' })).toBeDisabled();
  expect(backend.callsTo('POST', /\/ack$/)).toHaveLength(1);
}, 30_000);

it('does not count a closed arrival card as the acknowledgement and keeps the press available after a failed record', async () => {
  const { store, backend } = briefingSession();
  backend.on('POST', /\/ack$/, () => reply(409, { code: 'BRIEFING_DAY_CHANGED', reason: 'BRIEFING_DAY_CHANGED' }));
  const ui = host(true); // the run already closed the arrival card
  detail(store, ui);
  const press = await screen.findByRole('button', { name: '모두 읽음으로 표시하기' });
  expect(press).toBeEnabled();
  await userEvent.click(press);
  expect(await screen.findByRole('alert')).toHaveTextContent('영업일이 바뀌었어요');
  expect(ui.acknowledgeBriefing).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '모두 읽음으로 표시하기' })).toBeEnabled();
  expect(screen.queryByText('오늘 브리핑은 다시 띄우지 않아요')).not.toBeInTheDocument();
}, 30_000);

it('keeps the run flag as the whole acknowledgement in a fixture build', async () => {
  const { store, backend } = briefingSession({ source: 'fixture' });
  const ui = host();
  detail(store, ui);
  await userEvent.click(await screen.findByRole('button', { name: '모두 읽음으로 표시하기' }));
  expect(ui.acknowledgeBriefing).toHaveBeenCalledTimes(1);
  expect(backend.calls.filter(call => call.path.startsWith('/insight'))).toHaveLength(0);
  expect(screen.queryByRole('region', { name: '출처와 기준' })).not.toBeInTheDocument();
}, 30_000);
