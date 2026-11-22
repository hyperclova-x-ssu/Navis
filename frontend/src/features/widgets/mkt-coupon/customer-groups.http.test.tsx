import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { CellSpan, WidgetHost } from '../../../contracts';
import { defineBinding, type DomainAdapter } from '../../../data/reality/00';
import { createWidgetDataStore } from '../../../data/widget-data';
import { NAVER_BENEFIT_ADMIN_URL } from '../../../data/reality/19/dto';
import { groupsService, groupsSession, ids, person } from '../../../data/reality/19/testing';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';

const sms = vi.hoisted(() => ({ configured: true }));
// Exercise FAKE send and confirmation flows with the setup gate satisfied.
vi.mock('../../../data/reality/14/sms', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/reality/14/sms')>(),
  get smsSenderConfigured() { return sms.configured; },
}));


afterEach(cleanup);

const seed = {
  customers: {
    'churn-risk': [person(ids.stale, { memberCode: 'M-0008' }), person(ids.refused, { displayName: '박○○', marketingAllowed: false, selectable: false, blockedReason: 'NO_MARKETING_CONSENT' as const, lastVisitOn: '2026-10-05', daysSinceLast: 47 })],
    'first-visit': [person(ids.first, { groupId: 'first-visit' as const, displayName: '이○○', visitCount: 1, usualCycleDays: null, lastVisitOn: '2026-11-20', daysSinceLast: 1 })],
    regular: [person(ids.regular, { groupId: 'regular' as const, displayName: '최○○', visitCount: 9, recentVisits: 5, usualCycleDays: 3, lastVisitOn: '2026-11-19', daysSinceLast: 2 })],
  },
};
const host = (): WidgetHost => ({ layer: 'marketing', openClosing: () => true, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() });
const module = widgets.find(widget => widget.id === 'customer-groups')!;

function detail(session: ReturnType<typeof groupsSession>, widgetHost = host(), detailRef = { featureId: 'customer-groups' as const, view: 'reach-out', focus: 'action' as const }) {
  const Detail = module.Detail!;
  renderWithKit(<Detail featureId="customer-groups" condition={{ kind: 'default' }} detailRef={detailRef} host={widgetHost} />, { modules: widgets, store: session.store });
  return widgetHost;
}
function panel(session: ReturnType<typeof groupsSession>, width: number, height: number, shape: 'Q' | 'W' | 'T' | 'S' | 'L', widgetHost = host()) {
  const Panel = module.Panel;
  renderWithKit(<Panel featureId="customer-groups" condition={{ kind: 'default' }} width={width as CellSpan} height={height as CellSpan} shape={shape} presetId="A" editing={false} host={widgetHost} />, { modules: widgets, store: session.store });
  return widgetHost;
}
const posts = (session: ReturnType<typeof groupsSession>, path: string | RegExp) => session.service.backend.callsTo('POST', path);

it('keeps the group panel, NAVER link, coverage row and cohort tabs in both modes', async () => {
  async function structure(store: ReturnType<typeof createWidgetDataStore>) {
    const Detail = module.Detail!, Panel = module.Panel;
    const widgetHost = host();
    const { container } = renderWithKit(<>
      <Panel featureId="customer-groups" condition={{ kind: 'default' }} width={3} height={3} shape="S" presetId="A" editing={false} host={widgetHost} />
      <Detail featureId="customer-groups" condition={{ kind: 'default' }} detailRef={{ featureId: 'customer-groups' }} host={widgetHost} />
    </>, { modules: widgets, store });
    const tabs = await screen.findAllByRole('tab');
    const list = screen.getByRole('tablist');
    const guide = screen.getByRole('link', { name: '네이버에서 관리하기' });
    expect(list.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const panelActions = Array.from(container.querySelectorAll('.mkt-panel button'), el => el.textContent?.trim().replace(/\d+/gu, ''));
    const views = tabs.map(tab => {
      fireEvent.click(tab);
      return { tab: tab.textContent?.trim().replace(/\d+$/u, ''), link: screen.queryByRole('link', { name: '네이버에서 관리하기' })?.getAttribute('href'),
        coverage: !!container.querySelector('[data-slot="customer-groups.coverage"]'), basis: screen.getByText('매장 결제 기준이에요').textContent, panels: screen.getAllByRole('tabpanel').length };
    });
    cleanup();
    return { panelActions, views };
  }
  const real = await structure(groupsSession(groupsService(seed)).store);
  expect(real.views).toHaveLength(3);
  expect(real.views[0]).toMatchObject({ link: NAVER_BENEFIT_ADMIN_URL, coverage: true });
  expect(await structure(createWidgetDataStore())).toEqual(real);
});

/** A stand-in for B14's issuance binding: the same command name and arguments, an authoritative receipt. */
function reachOutBinding(): DomainAdapter {
  return {
    domain: 'coupons', tables: [], commands: [defineBinding({ type: 'coupon.sendReachOut', noticeKey: 'data.notice.sent',
      request: ({ recipientIds, messageEdits }) => ({ method: 'POST', path: '/marketing/reach-outs', body: { recipientIds, ...(messageEdits ? { messageEdits } : {}) } }) })],
    load: async () => ({ tables: {}, asOf: '2026-11-21T06:00:00.000Z', sourceRevision: 0, complete: true }),
  };
}

it('shows the service groups with counts, masked names, consent and a manage-in-NAVER link, and re-reads them in a new session', async () => {
  const service = groupsService(seed);
  detail(groupsSession(service));
  expect(await screen.findByRole('tab', { name: '떠날 수 있는 손님 2' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '첫 방문 1' })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: '단골 1' })).toBeInTheDocument();
  expect(screen.getByText(/매장 결제 기준이에요/u)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: '네이버에서 관리하기' });
  expect(link).toHaveAttribute('href', NAVER_BENEFIT_ADMIN_URL);
  expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  expect(screen.getByText('네이버 혜택 알림받기 손님은 네이버에서 관리해요')).toBeInTheDocument();
  expect(screen.getByText('회원 4명 · 그룹 밖 0명')).toBeInTheDocument();
  const list = document.querySelector('.ui-recipient-list') as HTMLElement;
  expect(within(list).getByText('김○○ · M-0008')).toBeInTheDocument();
  expect(within(list).getByText('박○○')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: '단골 1' }));
  expect(await screen.findByText('최○○')).toBeInTheDocument();
  expect(screen.getByText('최근 28일 안에 4번 이상 온 손님이에요')).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/\b01[016789]-?\d{3,4}-?\d{4}\b/u);
  cleanup();
  detail(groupsSession(service));
  expect(await screen.findByRole('tab', { name: '떠날 수 있는 손님 2' })).toBeInTheDocument();
});

it('preselects only consenting customers, disables the others with the reason and checks consent before the confirmation step', async () => {
  const session = groupsSession(groupsService(seed));
  detail(session);
  const send = await screen.findByRole('button', { name: /1명에게 쿠폰 보내기/u });
  const boxes = screen.getAllByRole('checkbox');
  expect(boxes.filter(box => (box as HTMLInputElement).getAttribute('aria-checked') === 'true')).toHaveLength(1);
  expect(boxes.filter(box => box.hasAttribute('disabled') || box.getAttribute('aria-disabled') === 'true')).toHaveLength(1);
  expect(screen.getByText('동의 안 함')).toBeInTheDocument();
  expect(posts(session, /reach-out-check/u)).toHaveLength(0);
  fireEvent.click(send);
  await waitFor(() => expect(posts(session, /reach-out-check/u)).toHaveLength(1));
  expect(posts(session, /reach-out-check/u)[0].body).toEqual({ recipientIds: [ids.stale], expectedSourceRevision: 5 });
  // No send binding yet: the owner is told so, nothing is confirmed and nothing is sent or faked locally.
  expect(await screen.findByText(/쿠폰 보내기는 아직 열려 있지 않아요/u)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /보낼까요|보내시겠어요/u })).not.toBeInTheDocument();
  expect(session.store.getSnapshot().tables.marketing.messageSend).toEqual([]);
  expect(session.store.getSnapshot().tables.marketing.coupon.filter(coupon => coupon.origin === 'group')).toEqual([]);
  expect(posts(session, /marketing/u).every(call => call.path.endsWith('/reach-out-check'))).toBe(true);
});

it('drops a member whose consent changed before the press, shows why and stays on the form', async () => {
  const service = groupsService(seed);
  const session = groupsSession(service, [reachOutBinding()]);
  detail(session);
  const send = await screen.findByRole('button', { name: /1명에게 쿠폰 보내기/u });
  // The service now refuses this member (consent revoked after the page loaded). The projection revision did not move.
  service.control.customers['churn-risk'][0] = person(ids.stale, { marketingAllowed: false, selectable: false, blockedReason: 'NO_MARKETING_CONSENT' });
  fireEvent.click(send);
  expect(await screen.findByText(/문자를 받을 수 없는 1명을 목록에서 뺐어요/u)).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: /보낼까요|보내시겠어요/u })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /0명에게 쿠폰 보내기/u })).toBeDisabled();
  expect(posts(session, '/marketing/reach-outs')).toHaveLength(0);
});

it('reloads and asks again when the groups changed after the page loaded', async () => {
  const service = groupsService(seed);
  const session = groupsSession(service, [reachOutBinding()]);
  detail(session);
  const send = await screen.findByRole('button', { name: /1명에게 쿠폰 보내기/u });
  service.control.revision = 6;
  fireEvent.click(send);
  expect(await screen.findByText(/그사이 손님 그룹이 바뀌었어요/u)).toBeInTheDocument();
  await waitFor(() => expect(session.store.getSnapshot().tables.realGroups?.groups?.sourceRevision).toBe(6));
  expect(posts(session, '/marketing/reach-outs')).toHaveLength(0);
});

it('sends one authoritative request for the consenting recipients only after the confirmation and the owner press', async () => {
  const service = groupsService(seed);
  const session = groupsSession(service, [reachOutBinding()]);
  service.backend.on('POST', '/marketing/reach-outs', () => ({ resourceId: 'send-1', revision: 1, receiptId: 'receipt-1', affectedSources: ['coupons'] }));
  const widgetHost = detail(session);
  fireEvent.click(await screen.findByRole('button', { name: /1명에게 쿠폰 보내기/u }));
  const confirm = await screen.findByRole('region', { name: /보낼까요|보내시겠어요|1명/u });
  expect(posts(session, '/marketing/reach-outs')).toHaveLength(0);
  const press = within(confirm).getByRole('button', { name: '보내기' });
  fireEvent.click(press);
  fireEvent.click(press);
  await waitFor(() => expect(posts(session, '/marketing/reach-outs')).toHaveLength(1));
  const [call] = posts(session, '/marketing/reach-outs');
  expect(call.body).toEqual({ recipientIds: [ids.stale] });
  expect(call.headers.get('idempotency-key')).toBeTruthy();
  await waitFor(() => expect(widgetHost.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.notice.sent' })));
  expect(await screen.findByText(/쿠폰 보내기를 요청했어요/u)).toBeInTheDocument();
  // A blocked recipient never reaches the send request.
  expect(JSON.stringify(call.body)).not.toContain(ids.refused);
});

it('panels show the churn count from the service, and a failed read is an error with a real retry', async () => {
  const service = groupsService(seed);
  service.control.fail.add('groups');
  const session = groupsSession(service);
  panel(session, 2, 2, 'S');
  // The other sections answered, so only this widget's section is an error.
  expect(await screen.findByText(/자료를 불러오지 못했어요/u)).toBeInTheDocument();
  const reads = service.backend.callsTo('GET', '/marketing/groups').length;
  service.control.fail.clear();
  fireEvent.click(screen.getByRole('button', { name: /다시 시도/u }));
  expect(await screen.findByText('2')).toBeInTheDocument();
  expect(service.backend.callsTo('GET', '/marketing/groups').length).toBeGreaterThan(reads);
  expect(screen.getAllByText(/떠날 수 있는 손님/u).length).toBeGreaterThan(0);
});

it('keeps the empty state with its next step when no member has a counted visit', async () => {
  const widgetHost = detail(groupsSession(groupsService()), host(), { featureId: 'customer-groups', view: 'regular', focus: 'action' as never });
  expect(await screen.findByText(/방문 기록이 쌓이면 손님을 나눠 드릴게요/u)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /회원/u }));
  expect(widgetHost.openLinked).toHaveBeenCalledWith({ featureId: 'members' });
});
