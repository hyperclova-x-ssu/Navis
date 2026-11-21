import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectWidget, TODAY } from '../../../data/widget-data';
import type { WidgetHost } from '../../../contracts';
import { GrantsDetail } from './grants';
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const detail = <GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />;
const widgetStyles = readFileSync('src/features/widgets/mgmt-money/widget.css', 'utf8');

it.each([{ locale: 'ko', label: '마감' }, { locale: 'en', label: 'Deadline' }] as const)(
 'places the $label facts beside their labels in $locale', ({ locale, label }) => {
  const { container } = renderWithKit(<><style>{widgetStyles}</style>{detail}</>, { locale });
  const facts = container.querySelector('[data-slot="grants.item"] dl')!;
  const labels = Array.from(facts.querySelectorAll('dt'), term => term.textContent);
  expect(labels[2]).toBe(label);
  expect(getComputedStyle(facts).gap).toBe('var(--space-3)');
  for (const row of facts.children) {
   const style = getComputedStyle(row);
   expect(style.display).toBe('grid');
   expect(style.gridTemplateColumns).toBe('calc(var(--space-6) * 5) minmax(0, 1fr)');
   expect(getComputedStyle(row.querySelector('dd')!).textAlign).toBe('start');
  }
 },
);

it('has a visually hidden 지우기 heading above application row actions (the screen never says 삭제)', async () => {
 renderWithKit(<><style>{widgetStyles}</style>{detail}</>);
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = screen.getByRole('grid', { name: '지원 현황' });
 const heading = within(grid).getByRole('columnheader', { name: '지우기' });
 expect(getComputedStyle(within(heading).getByText('지우기')).clipPath).toBe('inset(50%)');
 expect(within(grid).queryByText('삭제')).toBeNull();
 expect(within(grid).getByRole('columnheader', { name: '선정 및 지원 결과' })).toBeInTheDocument();
});

it('applies, deletes and restores a grant application', async () => {
 const store = createWidgetDataStore();
 renderWithKit(<GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />, { store, textScale: 125, reducedMotion: true });
 const before = store.getSnapshot().tables.grantApplication.length;
 const programName = document.querySelector('[data-slot="grants.item"] h3')!.textContent!;
 await userEvent.click(screen.getByRole('button', { name: '신청 완료로 표시하기' }));
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before + 1);
 // the toast names the program (SCR-223)
 expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({ messageKey: 'data.management.notice.grantApplied', params: { name: programName } }));
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const row = screen.getByText(programName).closest('tr') as HTMLElement;
 // today's application: a status chip, and the applied date as 11/17(화), never ISO
 const [, month, day] = TODAY.split('-');
 expect(within(row).getByText(new RegExp(`^${Number(month)}/${Number(day)}\\(`))).toBeInTheDocument();
 expect(row.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
 expect(within(row).getByText('신청함').closest('.ui-status-chip')).toHaveAttribute('data-semantic', 'info');
 await userEvent.click(screen.getAllByRole('button', { name: '신청 기록 지우기' })[0]!);
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before);
 const notice = vi.mocked(host.notify).mock.calls.at(-1)?.[0];
 expect(notice?.undoToken).toBeTruthy();
 expect(store.undo(notice!.undoToken!).ok).toBe(true);
 expect(store.getSnapshot().tables.grantApplication).toHaveLength(before + 1);
});
it('offers application status in a keyboard-navigable grid', async () => {
 renderWithKit(<GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />, { reducedMotion: true, textScale: 125 });
 await userEvent.click(screen.getByRole('button', { name: '신청 완료로 표시하기' }));
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = screen.getByRole('grid', { name: '지원 현황' });
 const tabStops = Array.from(grid.querySelectorAll<HTMLElement>('[tabindex="0"]'));
 expect(tabStops).toHaveLength(1);
 tabStops[0]!.focus();
 await userEvent.keyboard('{ArrowRight}');
 expect(document.activeElement).not.toBe(tabStops[0]);
});
it('keeps all three tabs usable in the empty example, each with a sentence and its next action', async () => {
 renderWithKit(<GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />, { preview: { family: 'empty', overrides: {} } });
 expect(screen.getByText('확인할 지원사업이 없어요')).toBeInTheDocument();
 expect(screen.getByText('새 공고가 올라오면 이 목록에 보여 드려요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '지원 현황 보기' }));
 expect(screen.getByRole('tab', { name: '지원 현황' })).toHaveAttribute('aria-selected', 'true');
 expect(screen.getByText('아직 신청한 사업이 없어요')).toBeInTheDocument();
 expect(screen.getByText('사업 목록에서 신청 완료로 표시하면 여기에 쌓여요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('tab', { name: '신청서 초안' }));
 expect(screen.getByText('초안을 만들 예시 자료가 없어요')).toBeInTheDocument();
 await userEvent.click(screen.getByRole('button', { name: '사업 목록 보기' }));
 expect(screen.getByRole('tab', { name: '사업 목록' })).toHaveAttribute('aria-selected', 'true');
});
it('offers the program list from the empty application table without adding a tab stop to the grid', async () => {
 renderWithKit(detail, { reducedMotion: true });
 await userEvent.click(screen.getByRole('tab', { name: '지원 현황' }));
 const grid = screen.getByRole('grid', { name: '지원 현황' });
 expect(within(grid).getByText('아직 신청한 사업이 없어요')).toBeInTheDocument();
 expect(grid.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
 await userEvent.click(screen.getByRole('button', { name: '사업 목록 보기' }));
 expect(screen.getByRole('tab', { name: '사업 목록' })).toHaveAttribute('aria-selected', 'true');
});
const draftBody = '신청 목적\n예시 카페의 운영 자금에 활용하려고 해요.\n지원 금액: 확인 필요';
const draftResponse = () => Response.json({
 draftId: 'draft-1', kind: 'application', content: { body: draftBody }, sourceLabels: ['예시 지원 공고'],
});

// The cafe seed's programs, from the selector the widget reads (the draft list shows them in this order).
const programs = () => {
 const view = selectWidget(createWidgetDataStore().getSnapshot(), 'grants', { kind: 'default' }, 'normal');
 if (view.status !== 'ready') throw new Error('Grants fixture must be available');
 return view.model.notices;
};

function openDraft() {
 renderWithKit(detail, { textScale: 125 });
 fireEvent.click(screen.getByRole('tab', { name: '신청서 초안' }));
}

it('loads once per action, shows sources and checks, and copies the exact edit', async () => {
 const user = userEvent.setup();
 const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
 let resolve!: (response: Response) => void;
 const transport = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
 vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
 openDraft();
 fireEvent.click(document.querySelectorAll<HTMLElement>('.mm-grant-draft-list .mm-select-row')[1]!);
 const generate = screen.getByRole('button', { name: '신청서 초안 만들기' });
 const copy = screen.getByRole('button', { name: '초안 복사하기' });
 expect(copy).toBeDisabled();
 fireEvent.click(generate);
 fireEvent.click(generate);
 expect(screen.getByText('초안을 만들고 있어요')).toHaveAttribute('role', 'status');
 expect(generate).toBeDisabled();
 expect(copy).toBeDisabled();
 expect(transport).toHaveBeenCalledTimes(1);
 expect(transport).toHaveBeenCalledWith('/api/navis/widget-drafts', expect.objectContaining({ body: JSON.stringify({ widget: 'grants', sampleId: programs()[1]!.noticeId }) }));
 resolve(draftResponse());
 const editor = await screen.findByRole('textbox', { name: '신청서 초안' });
 expect(editor).toHaveValue(draftBody);
 expect(screen.getByText('예시 지원 공고')).toBeVisible();
 expect(screen.getByText('확인 필요')).toBeVisible();
 fireEvent.change(editor, { target: { value: '고친 신청서\n지원 금액: 확인 필요' } });
 await user.click(copy);
 expect(writeText).toHaveBeenCalledWith('고친 신청서\n지원 금액: 확인 필요');
 expect(screen.getByText('복사했어요')).toBeVisible();
});

it('keeps edits on failure, retries explicitly, and clears the editor for an empty example', async () => {
 const transport = vi.fn().mockResolvedValueOnce(draftResponse())
  .mockResolvedValueOnce(Response.json({ code: 'RATE_LIMITED' }, { status: 429, headers: { 'Retry-After': '12' } }))
  .mockResolvedValueOnce(draftResponse());
 vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
 openDraft();
 const generate = screen.getByRole('button', { name: '신청서 초안 만들기' });
 fireEvent.click(generate);
 const editor = await screen.findByRole('textbox', { name: '신청서 초안' });
 fireEvent.change(editor, { target: { value: '고친 글' } });
 fireEvent.click(generate);
 const alert = await screen.findByRole('alert');
 expect(alert).toHaveTextContent('12초 뒤에 다시 시도해 주세요');
 expect(editor).toHaveValue('고친 글');
 fireEvent.click(within(alert).getByRole('button', { name: '다시 시도하기' }));
 await waitFor(() => expect(editor).toHaveValue(draftBody));
 fireEvent.click(screen.getByRole('button', { name: '자료가 없는 예시' }));
 fireEvent.click(screen.getByRole('button', { name: '신청서 초안 만들기' }));
 expect(screen.getByText('초안을 만들 예시 자료가 없어요')).toBeVisible();
 expect(screen.getByRole('textbox', { name: '신청서 초안' })).toHaveValue('');
 expect(screen.getByRole('button', { name: '초안 복사하기' })).toBeDisabled();
});

it('focuses and selects the editable text if clipboard access fails', async () => {
 const user = userEvent.setup();
 vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
 vi.spyOn(globalThis, 'fetch').mockResolvedValue(draftResponse());
 openDraft();
 fireEvent.click(screen.getByRole('button', { name: '신청서 초안 만들기' }));
 const editor = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: '신청서 초안' });
 await user.click(screen.getByRole('button', { name: '초안 복사하기' }));
 expect(await screen.findByRole('alert')).toHaveTextContent('복사하지 못했어요. 직접 복사해 주세요');
 expect(editor).toHaveFocus();
 expect(editor.selectionStart).toBe(0);
 expect(editor.selectionEnd).toBe(draftBody.length);
});

it('marks the official-notice block as an Esc layer of the detail window and gives focus back to its opener when it closes (K-B)', async () => {
 renderWithKit(detail, { reducedMotion: true });
 const opener = screen.getByRole('button', { name: '공식 공고 보기' });
 await userEvent.click(opener);
 const notice = document.querySelector<HTMLElement>('[data-slot="grants.official"]')!;
 // The detail window presses data-esc-close on the first Esc (DetailOverlay layer), so the notice closes before the window does.
 expect(notice).toHaveAttribute('data-esc-layer');
 const close = notice.querySelector<HTMLButtonElement>('[data-esc-close]')!;
 expect(close).toHaveTextContent('닫기');
 close.click();
 await waitFor(() => expect(document.querySelector('[data-slot="grants.official"]')).toBeNull());
 expect(opener).toHaveFocus();
});
