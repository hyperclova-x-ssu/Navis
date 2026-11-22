import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useMemo, useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../../data/db/generated/manifest.json';
import { addDays, TODAY, YESTERDAY } from '../../../data/db/time';
import { createTranslator } from '../../../i18n/translator';
import { createWidgetDataStore } from '../../../data/widget-data';
import { selectNotices, selectStoreClosures } from '../../../data/iteration7/notices';
import type { DataCommand } from '../../../data/commands/types';
import { renderWithKit } from '../../../ui/test-utils';
import { NoticeEditor } from './widget';
import { createNoticePort, noticeView } from './source';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const STALE = '휴무 일정이 바뀌었어요. 휴무를 다시 불러와 주세요';
const format = createTranslator('ko').format;
/** The name of a day button in the kit calendar and the text of a filled DateField. */
const longDate = (iso: string) => format.date(iso, 'long');
/** Informational notices go to every member with a contact; the cafe seed's count is the manifest's (AC-1465). */
const EVERYONE = manifest.counts.members;
type Store = ReturnType<typeof createWidgetDataStore>;
let keys = 0;
function Harness({ store, spy }: { store: Store; spy?: (command: DataCommand) => void }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const view = noticeView(selectNotices(snapshot), selectStoreClosures(snapshot), []);
  const port = useMemo(() => createNoticePort(command => { spy?.(command); return store.dispatch(command); }, id => store.getSnapshot().tables.noticeDraft.find(draft => draft.noticeId === id), () => {}, () => `closure-ui:${++keys}`), [store, spy]);
  return <NoticeEditor view={view} port={port} />;
}
const closureTitle = (date: string) => `${format.date(date, 'short')} 임시 휴무`;
/** The cafe seed has no closure on its calendar: add one a few days ahead, as the 캘린더 widget does, and import it into a draft. */
function seedClosureDraft(store: Store, date = addDays(TODAY, 3)) {
  const added = store.dispatch({ type: 'calendar.addEvent', title: closureTitle(date), date, memo: '매장 내부 정비로 하루 쉬어요', storeClosure: { kind: 'temporary', endDate: date } });
  expect(added.ok).toBe(true);
  const eventId = (added as { value: { eventId: string } }).value.eventId;
  const imported = store.dispatch({ type: 'notice.importClosure', eventId, idempotencyKey: `closure-ui-seed:${eventId}` });
  expect(imported.ok).toBe(true);
  return { eventId, date, noticeId: (imported as { value: { noticeId: string } }).value.noticeId };
}
const openDraft = (noticeId: string) => fireEvent.change(screen.getByLabelText('임시 저장한 공지'), { target: { value: noticeId } });
const editCalendarClosure = (store: Store, eventId: string, patch: Partial<Extract<DataCommand, { type: 'calendar.updateEvent' }>> = {}) => act(() => {
  expect(store.dispatch({ type: 'calendar.updateEvent', eventId, ...patch }).ok).toBe(true);
});
const dateButton = (label: '시작 날짜' | '종료 날짜') => screen.getByRole('button', { name: new RegExp(`^${label}`) });
/** Opens the kit calendar of a date field and presses the day (no typing delay: the popover is the slow part under jsdom). */
async function pickDate(label: '시작 날짜' | '종료 날짜', iso: string) {
  const user = userEvent.setup({ delay: null });
  await user.click(dateButton(label));
  const dialog = await screen.findByRole('dialog', { name: '날짜 고르기' });
  await user.click(within(dialog).getByRole('button', { name: longDate(iso) }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '날짜 고르기' })).not.toBeInTheDocument());
}

describe('GD-2 notice draft follows its calendar closure', () => {
  it('calendar closure change -> draft goes stale with the re-import offer -> re-import brings a fresh preview', async () => {
    const store = createWidgetDataStore();
    const { eventId, noticeId } = seedClosureDraft(store);
    renderWithKit(<Harness store={store} />, { store });
    openDraft(noticeId);
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByText(`받는 사람 ${EVERYONE}명`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '공지 보내기' })).toBeEnabled();

    const moved = addDays(TODAY, 4);
    editCalendarClosure(store, eventId, { title: closureTitle(moved), date: moved, storeClosure: { kind: 'temporary', endDate: moved } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(STALE);
    expect(screen.queryByLabelText('미리보기', { selector: 'section' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '공지 보내기' })).toBeDisabled();

    fireEvent.click(within(alert).getByRole('button', { name: '캘린더에서 다시 가져오기' }));
    await waitFor(() => expect(screen.queryByText(STALE)).not.toBeInTheDocument());
    expect(screen.getByLabelText('공지 제목')).toHaveValue(closureTitle(moved));
    expect(dateButton('시작 날짜')).toHaveTextContent(longDate(moved));
    expect(screen.getByRole('button', { name: '공지 보내기' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    expect(await screen.findByText(`받는 사람 ${EVERYONE}명`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '공지 보내기' })).toBeEnabled();
    expect(selectNotices(store.getSnapshot()).closureLinks[noticeId]).toBe('current');
  });
  it('shows the stale reason when 미리보기 is pressed on a stale draft and never reaches send', async () => {
    const store = createWidgetDataStore(), spy = vi.fn();
    const { eventId, noticeId, date } = seedClosureDraft(store);
    renderWithKit(<Harness store={store} spy={spy} />, { store });
    editCalendarClosure(store, eventId, { title: `${closureTitle(date)}(내용 변경)`, memo: '재고 조사로 하루 쉬어요' });
    const sentBefore = store.getSnapshot().tables.noticeSent.length;
    openDraft(noticeId);
    expect(screen.getByRole('alert')).toHaveTextContent(STALE);
    fireEvent.click(screen.getByRole('button', { name: '미리보기' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'notice.preview' })));
    expect(screen.queryByLabelText('미리보기', { selector: 'section' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '공지 보내기' })).toBeDisabled();
    expect(spy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'notice.send' }));
    expect(store.getSnapshot().tables.noticeSent).toHaveLength(sentBefore);
  });
  it('does not mark a draft whose closure is untouched', () => {
    const store = createWidgetDataStore();
    const { noticeId } = seedClosureDraft(store);
    renderWithKit(<Harness store={store} />, { store });
    openDraft(noticeId);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '캘린더에서 다시 가져오기' })).not.toBeInTheDocument();
  });
  it('shows a past date refusal under the date fields and saves nothing; today still saves', async () => {
    const store = createWidgetDataStore();
    renderWithKit(<Harness store={store} />, { store });
    const drafts = store.getSnapshot().tables.noticeDraft.length;
    fireEvent.change(screen.getByLabelText('공지 제목'), { target: { value: '입구 안내' } });
    fireEvent.change(screen.getByLabelText('공지 내용'), { target: { value: '옆문으로 들어와 주세요' } });
    await pickDate('시작 날짜', YESTERDAY);
    await pickDate('종료 날짜', YESTERDAY);
    expect(dateButton('시작 날짜')).toHaveTextContent(longDate(YESTERDAY));
    fireEvent.click(screen.getByRole('button', { name: '임시 저장하기' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('지난 날짜에는 공지를 만들 수 없어요. 오늘 이후로 골라 주세요');
    expect(dateButton('시작 날짜')).toHaveAttribute('aria-invalid', 'true');
    expect(store.getSnapshot().tables.noticeDraft).toHaveLength(drafts);
    await pickDate('시작 날짜', TODAY);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await pickDate('종료 날짜', TODAY);
    fireEvent.click(screen.getByRole('button', { name: '임시 저장하기' }));
    expect(await screen.findByText('임시 저장했어요')).toBeInTheDocument();
    expect(store.getSnapshot().tables.noticeDraft).toHaveLength(drafts + 1);
  }, 20_000);
});
