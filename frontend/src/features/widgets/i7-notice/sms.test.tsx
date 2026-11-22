/** GAPUI-MKT (SCR-273, PN13): SMS notice as a reservation — daytime only, more than ten minutes ahead, `내일 8시` at night, two-step cancel. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { inboxClock as noticeClock } from '../../../data/reality/15/hooks';
import { ids, service } from '../../../data/reality/15/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { createNoticeWidget } from './module';

const sms = vi.hoisted(() => ({ configured: true }));
// Exercise FAKE send and confirmation flows with the setup gate satisfied.
vi.mock('../../../data/reality/14/sms', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/reality/14/sms')>(),
  get smsSenderConfigured() { return sms.configured; },
}));


afterEach(cleanup);
beforeEach(() => { sms.configured = true; noticeClock.now = () => new Date('2026-11-21T03:00:00.000Z'); }); // 12:00 in Seoul
const widget = createNoticeWidget('notice-send', () => ({ view: { status: 'empty' }, port: {} as never }));

function open(backend: ReturnType<typeof service>['backend'], detailRef: { itemId?: string; view?: string } = {}) {
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(), source: domain => domain === 'inbox' ? 'http' : 'fixture', sleep: async () => {}, reconcileDelaysMs: [0] });
  store.bindReal(port);
  const notify = vi.fn();
  const host: WidgetHost = { layer: 'marketing', openClosing: () => true, resetPreview() {}, openLinked() {}, openDetail() {}, notify, acknowledgeBriefing() {} };
  const Detail = widget.Detail!;
  renderWithKit(<Detail featureId="notice-send" condition={{ kind: 'default' }} detailRef={{ featureId: 'notice-send', ...detailRef }} host={host} />, { modules: [widget], store });
  return { store, notify };
}
async function pickTime(time: string) {
  fireEvent.click(await screen.findByRole('button', { name: /^보낼 시각(?!을)/ }));
  fireEvent.click(await screen.findByRole('option', { name: time }));
}

it('keeps sending blocked and omits the provider frame while sender setup is pending', async () => {
    sms.configured = false;
  const { backend } = service({ sms: true });
  open(backend, { itemId: ids.sms });
  await pickTime('15:00');
  expect(await screen.findByText('문자를 보내려면 발신 번호를 먼저 등록해 주세요')).toBeVisible();
  expect(screen.getByText('무료 수신 거부 번호도 등록해 주세요')).toBeVisible();
  expect(screen.queryByText(/공지 매장 · 발신자 안내/)).not.toBeInTheDocument();
  const send = screen.getByRole('button', { name: /11월 21일 15:00에 보내기/ });
  expect(send).toBeDisabled();
  fireEvent.click(send);
  expect(backend.callsTo('POST', `/marketing/notices/${ids.sms}/send`)).toHaveLength(0);
});

it('books an SMS notice for a chosen daytime minute with one card press and shows it as booked, not sent', async () => {
  const { backend, state } = service({ sms: true });
  const { notify } = open(backend, { itemId: ids.sms });
  expect(await screen.findByText(/광고 문자라서 밤 9시부터 아침 8시 사이에는 보내지 않아요/)).toBeInTheDocument();
  expect(screen.getByText(/초안의 손님 그룹에서 광고 문자에 동의한 손님/)).toBeInTheDocument();
  expect(await screen.findByText(/SMS .*71\/90바이트/)).toBeInTheDocument();
  const preview = screen.getByRole('region', { name: '문자 미리보기' });
  expect(preview.querySelector('.mkt-quote')?.textContent).toBe(state.smsPreview.content);
  expect(within(preview).getByText('광고 문자 수신에 동의한 손님 12명')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '보낼 시각을 골라 주세요' })).toBeDisabled();
  await pickTime('12:10');
  expect(await screen.findByText('10분 뒤부터 고를 수 있어요')).toBeInTheDocument();
  await pickTime('15:00');
  const book = await screen.findByRole('button', { name: /11월 21일 15:00에 보내기/ });
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  fireEvent.click(book);
  const confirm = await screen.findByRole('group', { name: '보낼 내용 확인하기' });
  expect(confirm.querySelector('.mkt-quote')?.textContent).toBe(state.smsPreview.content);
  expect(within(confirm).getByText('광고 문자 수신에 동의한 손님 12명')).toBeInTheDocument();
  expect(state.log).toEqual([]);
  const yes = within(confirm).getByRole('button', { name: /11월 21일 15:00에 보내기/ });
  fireEvent.click(yes);
  fireEvent.click(yes);
  expect(await screen.findByText(/11월 21일 15:00에 보내도록 예약했어요/)).toBeInTheDocument();
  expect(state.log).toEqual(['card:sms.schedule:press', 'action:notice.send']);
  expect(backend.callsTo('POST', `/marketing/notices/${ids.sms}/send`)[0]!.body).toMatchObject({ scheduledFor: '2026-11-21T15:00', expectedRevision: 1 });
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ messageKey: 'data.real.inbox.notice.smsScheduled' }));
  expect(screen.queryByText(/보냈어요|예시/)).toBeNull();
});

it('re-reads the live reservation status on each press and cancels only through the second confirmation', async () => {
  const { backend, state } = service({ sms: true });
  open(backend, { itemId: ids.sms });
  await pickTime('15:00');
  fireEvent.click(await screen.findByRole('button', { name: /11월 21일 15:00에 보내기/ }));
  fireEvent.click(within(await screen.findByRole('group', { name: '보낼 내용 확인하기' })).getByRole('button', { name: /에 보내기/ }));
  await screen.findByText(/보내도록 예약했어요/);
  cleanup();
  open(backend, { view: 'scheduled' });
  const list = await screen.findByRole('list', { name: '문자' });
  expect(list).toHaveClass('i7-notice-schedules');
  expect(within(list).getByRole('listitem').firstElementChild?.tagName).toBe('DIV');
  expect(within(list).getByText('보내기 전')).toBeInTheDocument();
  state.smsStatus.set(ids.sms, 'PROCESSING');
  fireEvent.click(within(list).getByRole('button', { name: /예약 상태 다시 읽기/ }));
  expect(await within(list).findByText('보내는 중')).toBeInTheDocument();
  expect(within(list).getByText('이미 보내기 시작해서 취소할 수 없어요')).toBeInTheDocument();
  expect(within(list).queryByRole('button', { name: /예약 취소하기/ })).toBeNull();
  state.smsStatus.set(ids.sms, 'READY');
  fireEvent.click(within(list).getByRole('button', { name: /예약 상태 다시 읽기/ }));
  fireEvent.click(await within(list).findByRole('button', { name: /예약 취소하기/ }));
  const ask = await within(list).findByRole('group', { name: '예약 취소하기' });
  expect(within(ask).getByText('한 번 더 확인')).toBeInTheDocument();
  expect(within(ask).getByText(/11월 21일 15:00 문자 보내기 예약을 취소할까요/)).toBeInTheDocument();
  await waitFor(() => expect(within(ask).getByRole('button', { name: '그대로 두기' })).toHaveFocus());
  expect(state.log.filter(entry => entry.includes('cancel'))).toEqual([]);
  state.log.length = 0;
  fireEvent.click(within(ask).getByRole('button', { name: '예약 취소하기' }));
  await waitFor(() => expect(state.log).toEqual(['card:sms.cancel:press', 'card:sms.cancel:confirm', 'action:notice.cancelSms']));
  expect(await screen.findByText('예약을 취소했어요')).toBeInTheDocument();
  expect(backend.callsTo('POST', `/marketing/notices/${ids.sms}/cancel-sms`)).toHaveLength(1);
});

it('offers only tomorrow 8:00 at night and uses the server LMS type and byte count for a saved draft', async () => {
  noticeClock.now = () => new Date('2026-11-20T18:00:00.000Z'); // 03:00 in Seoul
  const { backend, state } = service({ sms: true });
  state.smsPreview = { ...state.smsPreview, type: 'LMS', bytes: 112 };
  open(backend, { itemId: ids.sms });
  expect(await screen.findByText('지금은 밤이라 내일 8시로만 예약할 수 있어요')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: '내일 8시' })).toBeChecked();
  expect(screen.queryByRole('button', { name: /^보낼 시각(?!을)/ })).toBeNull();
  expect(await screen.findByText(/LMS .*112바이트.*90바이트/)).toBeInTheDocument();
  const schedule = screen.getByRole('button', { name: /11월 22일 08:00에 보내기/ });
  expect(schedule).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox', { name: '공지 내용' }), { target: { value: '가'.repeat(50) } });
  expect(screen.queryByRole('region', { name: '문자 미리보기' })).toBeNull();
  expect(schedule).toBeDisabled();
  expect(state.log).toEqual([]);
});

it('blocks scheduling when the authoritative preview has no consenting recipients', async () => {
  const { backend, state } = service({ sms: true });
  state.smsPreview = { ...state.smsPreview, recipientCount: 0, sendAllowed: false, reasons: ['SMS_CONSENT_REQUIRED'] };
  open(backend, { itemId: ids.sms });
  await pickTime('15:00');
  expect(await screen.findByText('광고 문자 수신에 동의한 손님이 없어요')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /11월 21일 15:00에 보내기/ })).toBeDisabled();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('says SMS sending is closed before any press when the service has no SENS binding, and keeps the draft', async () => {
  const { backend, state } = service();
  open(backend, { itemId: ids.sms });
  expect(await screen.findByText('문자 발송은 아직 열려 있지 않아요. 초안은 저장되어 있어요')).toBeInTheDocument();
  await pickTime('15:00');
  expect(screen.getByRole('button', { name: /11월 21일 15:00에 보내기/ })).toBeDisabled();
  expect(state.log).toEqual([]);
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('uses the service night slot for the tomorrow-8 reservation', async () => {
  noticeClock.now = () => new Date('2026-11-20T15:30:00.000Z'); // 00:30 in Seoul, after midnight
  const { backend, state } = service({ sms: true });
  state.nightWindow = { localTime: '2026-11-22T08:00', label: '내일 8시' };
  open(backend, { itemId: ids.sms });
  await waitFor(() => expect(screen.getByRole('button', { name: /11월 22일 08:00에 보내기/ })).toBeEnabled());
});

it('does not let a new SMS draft be saved without a customer group and says why', async () => {
  const { backend } = service({ sms: true });
  open(backend);
  fireEvent.click(await screen.findByRole('radio', { name: '문자' }));
  fireEvent.change(screen.getByRole('textbox', { name: /제목/ }), { target: { value: '신메뉴' } });
  fireEvent.change(screen.getByRole('textbox', { name: '공지 내용' }), { target: { value: '딸기 라떼가 나왔어요' } });
  expect(screen.getByText(/이 초안에는 받는 그룹이 없어요/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '임시 저장하기' })).toBeDisabled();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
