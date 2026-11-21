/** F-1: the 회원목록 side panel shows the RowDelete blocked pattern (DESIGN_SYSTEM 12.1) in its `danger` slot for members who hold 충전금·외상·회원권. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit, type KitRenderOptions } from '../../../ui/test-utils';
import { createWidgetDataStore, selectMembers } from '../../../data/widget-data';
import { selectMemberDeleteBlockers } from '../../../data/commands/member-guard';
import { MembersDetail } from './members';

const makeHost = () => ({ layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) });
const condition = { kind: 'default' as const };
const styles = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');
afterEach(cleanup);

// The café sample (D-313): who holds what is read from the same selector the panel uses, not typed in.
const seed = createWidgetDataStore().getSnapshot();
const TOTAL = selectMembers(seed, {}).total, PASSES = selectMembers(seed, {}).membershipCount;
const won = (n: number) => `${n.toLocaleString('en-US')}원`;
const holds = (memberId: string) => selectMemberDeleteBlockers(seed, memberId);
const CHARGE_PASS = 'M-0012', DEBT_PASS = 'M-0024', ALL_THREE = 'M-0052', FREE = 'M-0008', USED_UP = 'M-0001';

function openMember(memberId: string, options: KitRenderOptions = {}) {
  const store = createWidgetDataStore(), host = makeHost();
  renderWithKit(<><style>{styles}</style><MembersDetail featureId="members" condition={condition} detailRef={{ featureId: 'members', itemId: memberId }} host={host} /></>, { store, reducedMotion: true, ...options });
  return { store, host, side: screen.getByRole('region') };
}
const reasonOf = (button: HTMLElement) => document.getElementById(button.getAttribute('aria-describedby')!)!;
// The side panel fades in over 0 opacity under jsdom, so "visible" here means: real text on screen, never hidden or screen-reader-only.
const onScreen = (node: HTMLElement) => { expect(node).toBeInTheDocument(); expect(node.hidden).toBe(false); expect(node.closest('.ui-sr-only,[hidden],[inert]')).toBeNull(); expect(node.textContent!.length).toBeGreaterThan(10); };

describe('blocked member (충전금 + 이용 중인 회원권 1개)', () => {
  it('shows the delete control as blocked with a visible, described reason', () => {
    const { side } = openMember(CHARGE_PASS);
    const button = within(side).getByRole('button', { name: '회원 지우기' });
    expect(button.closest('[data-panel-slot="danger"]')).not.toBeNull(); // the last item of the panel body (DS 12.2)
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).not.toBeDisabled(); // stays focusable so keyboard users reach the reason
    expect(button).toHaveAttribute('data-blocked', 'true');
    const reason = reasonOf(button);
    onScreen(reason);
    expect(reason).toHaveTextContent(`충전금 ${won(holds(CHARGE_PASS).charge)}, 이용 중인 회원권 ${holds(CHARGE_PASS).passes}개가 남아 있어서 지울 수 없어요. 먼저 정산하고 회원권을 모두 쓰거나 환불해 주세요`);
  });

  it('pressing it shows the reason as an alert plus a notice and archives nothing', async () => {
    const { store, host, side } = openMember(CHARGE_PASS);
    const button = within(side).getByRole('button', { name: '회원 지우기' });
    expect(within(side).queryByRole('alert')).toBeNull();
    await userEvent.click(button);
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(TOTAL);
    expect(within(side).getByRole('alert')).toHaveTextContent('지울 수 없어요');
    expect(host.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', messageKey: 'data.management.error.MEMBER_HAS_OPEN_BALANCE' }));
  });

  it('Enter on the focused blocked control is not silent either', async () => {
    const { store, host, side } = openMember(CHARGE_PASS);
    const button = within(side).getByRole('button', { name: '회원 지우기' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(TOTAL);
    expect(host.notify).toHaveBeenCalledTimes(1);
  });

  it('has the blocked look from the design system: class, not-allowed cursor, tokens only', () => {
    const { side } = openMember(CHARGE_PASS);
    const button = within(side).getByRole('button', { name: '회원 지우기' });
    expect(button).toHaveClass('mc-delete-blocked');
    expect(getComputedStyle(button).cursor).toBe('not-allowed');
    expect(button.querySelector('svg')).not.toBeNull(); // disabled trash icon
    const rule = (styles.match(/[^}]*\.mc-delete-blocked[^{]*\{[^}]*\}/g) ?? []).join('\n');
    expect(rule).toMatch(/var\(--muted\)/);
    expect(rule).toMatch(/1px solid var\(--border\)/);
    expect(rule).toMatch(/var\(--disabled-foreground\)/);
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('lists a receivable and every blocker at once, each with its own reason', () => {
    cleanup();
    const debt = openMember(DEBT_PASS);
    expect(reasonOf(within(debt.side).getByRole('button', { name: '회원 지우기' }))).toHaveTextContent(`외상 ${won(holds(DEBT_PASS).receivable)}, 이용 중인 회원권 ${holds(DEBT_PASS).passes}개가 남아 있어서 지울 수 없어요`);
    cleanup();
    const all = openMember(ALL_THREE);
    const b = holds(ALL_THREE);
    expect(reasonOf(within(all.side).getByRole('button', { name: '회원 지우기' }))).toHaveTextContent(`충전금 ${won(b.charge)}, 외상 ${won(b.receivable)}, 이용 중인 회원권 ${b.passes}개가 남아 있어서 지울 수 없어요. 먼저 정산하고 회원권을 모두 쓰거나 환불해 주세요`);
  });

  it('every locale gives the reason in its own language', () => {
    for (const [locale, expected] of [['en', /Still open/], ['zh-Hans', /无法删除/], ['zh-Hant', /無法刪除/]] as const) {
      cleanup();
      const { side } = openMember(CHARGE_PASS, { locale });
      const button = within(side).getByRole('button', { name: '회원 지우기' });
      expect(reasonOf(button).textContent).toMatch(expected);
      expect(reasonOf(button).textContent).not.toMatch(/[{}]|widget\./);
    }
  });

  it('renders in dark mode at 125% text without losing the reason', () => {
    const { side } = openMember(CHARGE_PASS, { theme: 'dark', textScale: 125 });
    onScreen(reasonOf(within(side).getByRole('button', { name: '회원 지우기' })));
  });
});

describe('deletable member', () => {
  it('keeps the old flow: not blocked, archives on press, notifies with an undo token', async () => {
    const { store, host, side } = openMember(FREE);
    const button = within(side).getByRole('button', { name: '회원 지우기' });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).not.toHaveAttribute('data-blocked');
    expect(within(side).queryByRole('alert')).toBeNull();
    await userEvent.click(button);
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(TOTAL - 1);
    expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.management.notice.deleted', undoToken: expect.any(String) }));
    act(() => { store.undo(host.notify.mock.calls.at(-1)![0].undoToken!); });
    expect(selectMembers(store.getSnapshot(), {}).total).toBe(TOTAL);
    expect(selectMembers(store.getSnapshot(), {}).membershipCount).toBe(PASSES); // a member without an active pass leaves the pass count alone
  });

  it('a member whose only pass is used up is also deletable', () => {
    const { side } = openMember(USED_UP);
    expect(within(side).getByRole('button', { name: '회원 지우기' })).not.toHaveAttribute('aria-disabled');
  });
});
