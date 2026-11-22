// REAL-PLAN F12: the briefing detail over HTTP summarizes ready sources, shows problem states, withholds what is not connected,
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

it('collapses ready sources together, keeps problem sources visible, and withholds unavailable facts', async () => {
  const { store } = briefingSession();
  detail(store, host());
  const card = await screen.findByRole('region', { name: '출처와 기준' });
  expect(within(card).getByText('출처 12개를 불러왔어요')).toBeVisible();
  expect(within(card).queryByText('오늘 매출·입금')).not.toBeInTheDocument();
  expect(within(card).queryByText('스마트콜 통화')).not.toBeInTheDocument();
  expect(within(card).getByText('발주·입고').closest('li')).toHaveAttribute('data-state', 'partial');
  expect(within(card).getByText('CCTV').closest('li')).toHaveAttribute('data-state', 'unavailable');
  expect(within(card).getByText('예약').closest('li')).toHaveAttribute('data-state', 'not-connected');
  expect(screen.getAllByRole('note').some(note => /예약\s·\s아직 연결 전이에요/.test(note.textContent ?? ''))).toBe(true);
  expect(screen.queryByText(/세금 납부|원천세/)).not.toBeInTheDocument();
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
  // PAR-1 (D-384): the example data shows the same sources card as the service does.
  expect(screen.getByRole('region', { name: '출처와 기준' })).toBeInTheDocument();
}, 30_000);
