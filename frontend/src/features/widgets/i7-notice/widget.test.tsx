import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render as renderBare, screen, within } from '@testing-library/react';
import { addDays, TODAY, YESTERDAY } from '../../../data/db/time';
import { createTranslator } from '../../../i18n/translator';
import { DetailFooterContext } from '../../../ui';
import { createWidgetDataStore } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { NoticeEditor, NoticePanel, type NoticeDraftInput, type NoticeDraftMemory, type NoticePort, type NoticeView } from './widget';

afterEach(cleanup);
const format = createTranslator('ko').format;
/** The editor needs the kit providers (calendar popover, grid); one fake DB for the whole file, as the editors only use their own fake port. */
const store = createWidgetDataStore();
const render = (ui: Parameters<typeof renderWithKit>[0]) => renderWithKit(ui, { store });
const view = { status: 'ready' as const, unsentCount: 1, nextClosure: { eventId: 'closure', title: '11/02 임시 휴무' }, closures: [{ eventId: 'closure', title: '11/02 임시 휴무' }], drafts: [], sent: [], scheduled: [], groups: [] };
const preview = { previewId: 'p1', draftRevision: 1, contentClass: 'informational' as const, recipientCount: 126, excludedCount: 0, renderedBody: '하루 쉬어요', adMarker: false, optOutText: '', sendAllowed: true, reasons: [] };
const makePort = () => ({ importClosure: vi.fn(async () => ({ ok: true as const, draft: { noticeId: 'n1', revision: 1, kind: 'temporary_closure' as const, title: '휴무 안내', body: '하루 쉬어요', startDate: '2026-11-02', endDate: '2026-11-02', closureEventId: 'closure', audience: 'all_contactable' as const, groupIds: [] } })), saveDraft: vi.fn(async () => ({ ok: true as const, noticeId: 'n1', revision: 1 })), cancelSchedule: vi.fn(async () => ({ ok: true as const })), deleteDraft: vi.fn(async () => ({ ok: true as const })), preview: vi.fn<NoticePort['preview']>(async () => ({ ok: true as const, preview })), send: vi.fn<NoticePort['send']>(async () => ({ ok: true as const })), retry: vi.fn() });
const makeMemory = () => { let kept: NoticeDraftInput | null = null; return { read: () => kept, write: (draft: NoticeDraftInput | null) => { kept = draft; } } satisfies NoticeDraftMemory; };
const sentRows = [
  { sentId: 's2', title: '저녁 좌석 안내', kind: 'other', recipientCount: 460, sentAt: `${TODAY}T15:45` },
  { sentId: 's1', title: `${format.date(YESTERDAY, 'short')} 임시 휴무`, kind: 'temporary_closure', recipientCount: 312, sentAt: `${YESTERDAY}T09:05` },
];

describe('notice editor', () => {
  it('shows the delivery channel before its recipient controls and keeps draft deletion out of a blank editor', () => {
    render(<NoticeEditor view={view} port={makePort()} deliveryChannels />);
    expect(screen.getByText('공지 종류', { exact: true })).toBeVisible();
    expect(screen.getByText('보낼 곳', { exact: true })).toBeVisible();
    expect(screen.queryByRole('button', { name: '임시 저장 지우기' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '톡톡 마케팅' }));
    expect(screen.queryByRole('radio', { name: '연락처가 있는 회원 전체' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: '문자' }));
    expect(screen.getByRole('button', { name: '예약하기' })).toHaveClass('ui-button--default');
    expect(screen.getByText('보낼 시각을 골라 주세요')).toBeVisible();
  });
  it('keeps the compact action alongside the number and hides the third line', () => {
    const open = vi.fn();
    const { container } = renderBare(<NoticePanel view={view} width={1} height={1} onOpen={open} onRetry={() => {}} />);
    expect(screen.queryByText('11/02 임시 휴무')).toBeNull();
    expect(container.querySelector('.i7-notice-metric-line button')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /공지 보내기/ }));
    expect(open).toHaveBeenCalledOnce();
  });
  it('shows the source closure count in every panel size', () => {
    for (const width of [1, 2, 3, 4]) for (const height of [1, 2, 3, 4]) {
      renderBare(<NoticePanel view={view} width={width} height={height} onOpen={() => {}} onRetry={() => {}} />);
      expect(screen.getByText('안 보낸 공지')).toBeTruthy();
      cleanup();
    }
  });
  it('gives a wide notice panel source labels and a next step on the empty scheduled tab', () => {
    render(<>
      <NoticePanel view={view} width={4} height={4} onOpen={() => {}} onRetry={() => {}} />
      <NoticeEditor view={view} port={makePort()} detailRef={{ featureId: 'notice-send', view: 'scheduled' }} />
    </>);
    expect(screen.getByRole('heading', { name: '다가오는 매장 휴무' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '임시 저장한 공지' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '보낸 기록' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '공지 작성하기' }));
    expect(screen.getByRole('tab', { name: '공지 작성' })).toHaveAttribute('aria-selected', 'true');
  });
  it('writes the panel history times as 오늘 {time} or {M/D(요일)} {time}, never ISO', () => {
    renderBare(<NoticePanel view={{ ...view, sent: sentRows }} width={2} height={3} onOpen={() => {}} onRetry={() => {}} />);
    const rows = within(screen.getByLabelText('보낸 기록')).getAllByText(/\d{2}:\d{2}/).map(node => node.textContent);
    expect(rows).toEqual([format.dateTime(sentRows[0]!.sentAt, { today: TODAY }), format.dateTime(sentRows[1]!.sentAt, { today: TODAY })]);
    expect(rows[0]).toBe('오늘 15:45');
    expect(rows.join(' ')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('requires a title before saving or previewing', async () => {
    const port = makePort(); render(<NoticeEditor view={view} port={port} />);
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByText('공지 제목을 넣어 주세요')).toBeTruthy();
    expect(screen.getByLabelText('공지 제목')).toHaveFocus();
    expect(port.preview).not.toHaveBeenCalled();
  });
  it('keeps the notice type and draft tools in separate rows', () => {
    const { container } = render(<NoticeEditor view={view} port={makePort()} />);
    const style = document.createElement('style');
    style.textContent = ['src/ui/tokens.css', 'src/features/widgets/i7-notice/widget.css']
      .map(path => readFileSync(path, 'utf8')).join('\n');
    container.prepend(style);
    const types = screen.getByRole('radiogroup', { name: '공지 종류' });
    const load = screen.getByRole('button', { name: '캘린더에서 불러오기' });
    const toolbar = load.parentElement!;
    expect(types.parentElement).toBe(toolbar.parentElement);
    expect(getComputedStyle(toolbar).display).toBe('flex');
    expect(getComputedStyle(toolbar).flexWrap).toBe('wrap');
    expect(load).toHaveClass('ui-button--secondary');
    expect(getComputedStyle(load).flexGrow).toBe('0');
    expect(getComputedStyle(load).width || 'auto').toBe('auto');
    expect(getComputedStyle(load).minWidth).toContain('120px');
    expect(getComputedStyle(load).minHeight).toBe('var(--target-default)');
    expect(getComputedStyle(load).marginInlineStart).toBe('auto');
  });
  it('imports a closure, previews its current recipients, and prevents repeated sends', async () => {
    const port = makePort(); let finish!: (value: { ok: true }) => void;
    port.send.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<NoticeEditor view={view} port={port} />);
    fireEvent.click(screen.getByRole('button', { name: '캘린더에서 불러오기' }));
    fireEvent.click(screen.getByRole('button', { name: '11/02 임시 휴무' }));
    await screen.findByDisplayValue('휴무 안내');
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByText('받는 사람 126명')).toBeTruthy();
    const send = screen.getByRole('button', { name: '공지 보내기' });
    vi.useFakeTimers();
    fireEvent.click(send); fireEvent.click(send); fireEvent.click(send);
    expect(screen.getByText('공지를 보내고 있어요')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(port.send).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    vi.useRealTimers();
    expect(await screen.findByText('보냈어요')).toBeTruthy();
    // Sent: the form starts empty again and the status points at the history.
    expect(screen.getByLabelText('공지 제목')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '보낸 기록 보기' }));
    expect(screen.getByRole('tab', { name: '보낸 기록' })).toHaveAttribute('aria-selected', 'true');
  });

  it('prevents sending to zero recipients; the promotional band keeps the night limit (AC-1465)', async () => {
    const port = makePort();
    port.preview.mockResolvedValue({ ok: true, preview: { ...preview, contentClass: 'promotional', recipientCount: 0, sendAllowed: false, renderedBody: '(광고) 할인 쿠폰', reasons: ['NO_RECIPIENTS'] } });
    render(<NoticeEditor view={view} port={port} />);
    fireEvent.change(screen.getByLabelText('공지 제목'), { target: { value: '할인' } });
    fireEvent.change(screen.getByLabelText('공지 내용'), { target: { value: '쿠폰' } });
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByText('보낼 수 있는 손님이 없어요')).toBeTruthy();
    expect(screen.getByText(/밤 9시부터 아침 8시/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '공지 보내기' }) as HTMLButtonElement).disabled).toBe(true);
    expect(port.send).not.toHaveBeenCalled();
  });
  it('says why 공지 보내기 is off, and shows a warning or info icon in the rule band', async () => {
    const port = makePort();
    const { container } = render(<NoticeEditor view={view} port={port} />);
    const send = screen.getByRole('button', { name: '공지 보내기' });
    expect(send).toBeDisabled();
    expect(screen.getByText('미리보기를 먼저 눌러 내용을 확인해 주세요')).toBeInTheDocument();
    expect(send).toHaveAccessibleDescription(/미리보기를 먼저/);
    const band = container.querySelector<HTMLElement>('.i7-notice-rule')!;
    expect(band).toHaveAttribute('data-tone', 'info');
    expect(band.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('공지 제목'), { target: { value: '할인 안내' } });
    expect(band).toHaveAttribute('data-tone', 'warning');
    expect(band.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
  });
  it('puts the footer in the window bottom row, outside the body, with the status sentence in it', async () => {
    const slot = document.createElement('div'); document.body.append(slot);
    const port = makePort();
    render(<DetailFooterContext.Provider value={{ slot, claim: () => {} }}><NoticeEditor view={view} port={port} /></DetailFooterContext.Provider>);
    for (const name of ['임시 저장하기', '미리보기', '공지 보내기']) expect(within(slot).getByRole('button', { name })).toBeInTheDocument();
    expect(within(slot).queryByRole('button', { name: '임시 저장 지우기' })).not.toBeInTheDocument();
    expect(within(slot).getByRole('button', { name: '미리보기' })).toHaveClass('ui-button--secondary');
    expect(within(slot).getByRole('button', { name: '공지 보내기' })).toHaveClass('ui-button--default');
    expect(within(slot).getByRole('button', { name: '공지 보내기' })).toBeDisabled();
    expect(screen.getByRole('tab', { name: '공지 작성' }).closest('.i7-notice-detail')!.contains(slot)).toBe(false);
    fireEvent.click(within(slot).getByRole('button', { name: '미리보기' }));
    expect(await screen.findByText('공지 제목을 넣어 주세요')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('공지 제목'), { target: { value: '휴무 안내' } });
    fireEvent.change(screen.getByLabelText('공지 내용'), { target: { value: '하루 쉬어요' } });
    fireEvent.click(within(slot).getByRole('button', { name: '임시 저장하기' }));
    expect(await within(slot).findByText('임시 저장했어요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '보낸 기록' }));
    expect(within(slot).queryByRole('button', { name: '미리보기' })).not.toBeInTheDocument();
    slot.remove();
  });
  it('picks the audience with a kit radio group and the groups with kit checkboxes', () => {
    const groups = [{ groupId: 'regular' as const, name: '단골' }, { groupId: 'churn-risk' as const, name: '이탈 위험' }];
    render(<NoticeEditor view={{ ...view, groups }} port={makePort()} />);
    const audience = screen.getByRole('radiogroup', { name: '받는 사람' });
    expect(within(audience).getAllByRole('radio').map(radio => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(within(audience).getByRole('radio', { name: '손님 그룹 선택' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '단골' }));
    expect(screen.getByRole('checkbox', { name: '단골' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '이탈 위험' })).not.toBeChecked();
    fireEvent.click(within(audience).getByRole('radio', { name: '연락처가 있는 회원 전체' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });
  it('lets the end date start no earlier than the start date', async () => {
    render(<NoticeEditor view={view} port={makePort()} />);
    const start = addDays(TODAY, 2), before = addDays(TODAY, 1);
    await userEvent.click(screen.getByRole('button', { name: /^시작 날짜/ }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: '날짜 고르기' })).getByRole('button', { name: format.date(start, 'long') }));
    await userEvent.click(screen.getByRole('button', { name: /^종료 날짜/ }));
    const dialog = await screen.findByRole('dialog', { name: '날짜 고르기' });
    expect(within(dialog).getByRole('button', { name: format.date(before, 'long') })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: format.date(start, 'long') })).toBeEnabled();
  });
  it('keeps what was typed when the window is closed and reopened, and starts clean after a send', async () => {
    const memory = makeMemory(), port = makePort();
    const first = render(<NoticeEditor view={view} port={port} memory={memory} />);
    fireEvent.change(screen.getByLabelText('공지 제목'), { target: { value: '저녁 휴무' } });
    fireEvent.change(screen.getByLabelText('공지 내용'), { target: { value: '일찍 닫아요' } });
    first.unmount();
    render(<NoticeEditor view={view} port={port} memory={memory} />);
    expect(screen.getByLabelText('공지 제목')).toHaveValue('저녁 휴무');
    expect(screen.getByLabelText('공지 내용')).toHaveValue('일찍 닫아요');
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    await screen.findByText('받는 사람 126명');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: '공지 보내기' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    vi.useRealTimers();
    expect(await screen.findByText('보냈어요')).toBeInTheDocument();
    expect(memory.read()).toBeNull();
  });
  it('drops a kept draft id that no longer exists among the saved drafts', () => {
    const memory = makeMemory();
    memory.write({ noticeId: 'gone', revision: 3, kind: 'other', title: '지워진 초안', body: '내용', startDate: TODAY, endDate: TODAY, audience: 'all_contactable', groupIds: [] });
    render(<NoticeEditor view={view} port={makePort()} memory={memory} />);
    expect(screen.getByLabelText('공지 제목')).toHaveValue('지워진 초안');
    expect(screen.queryByRole('button', { name: '임시 저장 지우기' })).toBeNull();
  });
  it('lists the sent notices in the kit grid: 56 rows, aligned recipients, short dates, a next action when empty', () => {
    const full = render(<NoticeEditor view={{ ...view, sent: sentRows } as NoticeView} port={makePort()} />);
    fireEvent.click(screen.getByRole('tab', { name: '보낸 기록' }));
    const grid = screen.getByRole('grid', { name: '보낸 기록' });
    expect(within(grid).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['공지 제목', '공지 종류', '받는 사람', '보낸 일시']);
    expect(within(grid).getByText('오늘 15:45')).toBeInTheDocument();
    expect(within(grid).getByText(format.dateTime(sentRows[1]!.sentAt, { today: TODAY }))).toBeInTheDocument();
    expect(within(grid).getByText('460명')).toBeInTheDocument();
    expect(grid.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(within(grid).getByText('460명').closest('[role="gridcell"]')).toHaveAttribute('data-kind', 'number');
    full.unmount();
    render(<NoticeEditor view={view} port={makePort()} />);
    fireEvent.click(screen.getByRole('tab', { name: '보낸 기록' }));
    fireEvent.click(screen.getByRole('button', { name: '공지 작성하기' }));
    expect(screen.getByRole('tab', { name: '공지 작성' })).toHaveAttribute('aria-selected', 'true');
  });
  it('shows empty sent history and provides retry for failed loading', () => {
    const port = makePort(); const rendered = render(<NoticeEditor view={view} port={port} />);
    fireEvent.click(screen.getByRole('tab', { name: '보낸 기록' }));
    const empty = screen.getByRole('heading', { name: '아직 보낸 공지가 없어요' }).closest<HTMLElement>('.ui-inline-state')!;
    expect(within(empty).getByText('공지를 보내면 여기에 남아요')).toHaveClass('ui-inline-state__description');
    expect(empty.parentElement!.querySelector('svg[aria-hidden="true"]')).toBeInTheDocument();
    rendered.rerender(<NoticeEditor view={{ status: 'error' }} port={port} />);
    fireEvent.click(screen.getByRole('button', { name: /다시 시도하기/ }));
    expect(port.retry).toHaveBeenCalledOnce();
  });
});

it('shows the scheduled time and recipients and asks before cancelling', async () => {
  const port = makePort();
  const row = { sentId: 'scheduled-1', noticeId: 'n1', title: '휴무 안내', recipientCount: 126, sendAt: `${addDays(TODAY, 1)}T08:00`, cancellable: true };
  render(<NoticeEditor view={{ ...view, scheduled: [row] }} port={port} />);
  fireEvent.click(screen.getByRole('tab', { name: '예약한 공지' }));
  expect(screen.getByText(row.title)).toBeTruthy();
  expect(screen.getByText(/08:00.*126명/u)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '예약 취소' }));
  expect(port.cancelSchedule).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('form', { name: '발송 예약을 취소할까요?' })).getByRole('button', { name: '예약 취소' }));
  expect(port.cancelSchedule).toHaveBeenCalledExactlyOnceWith(row.sentId);
  expect(await screen.findByText('발송 예약을 취소했어요')).toBeTruthy();
});
