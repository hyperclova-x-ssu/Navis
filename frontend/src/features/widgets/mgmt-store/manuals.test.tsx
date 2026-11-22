import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore, koKey, koText, makeHost, manualsModel as model, renderDetail, renderPanel } from './test-helpers';
import { draft, draftId, insight, insightSession, manual, manualId, updatedAt } from '../../../data/reality/11/testing';
import { addDays, TODAY } from '../../../data/db/time';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
/** The first seed manual of a category (the cafe seed has one opening, one closing, three new-staff manuals). */
const firstOf = (store: ReturnType<typeof createWidgetDataStore>, category: string) => model(store).manuals.find((m) => m.category === category)!;

it('publishes an Insight draft only after confirmation and re-reads a checked step in a fresh session', async () => {
  const { backend, collections, newStore, setBusinessDay } = insightSession();
  backend.on('POST', `${insight}/manual-drafts`, () => {
    collections.set('manual-drafts', [draft]);
    return { resourceId: draftId, receiptId: 'draft-receipt', revision: 2, affectedSources: ['manuals'] };
  });
  backend.on('POST', `${insight}/manual-drafts/${draftId}/save`, () => {
    collections.set('manual-drafts', []);
    collections.set('manuals', [manual]);
    return { resourceId: manualId, receiptId: 'publish-receipt', revision: 1, affectedSources: ['manuals', 'briefing'] };
  });
  backend.on('POST', `${insight}/checklists`, () => {
    collections.set('checklists', [{ id: 'checklist-1', businessDay: updatedAt.slice(0, 10), manualId, manualRevision: 1, checkedSteps: [1], totalSteps: 1, revision: 1, updatedAt }]);
    return { resourceId: 'checklist-1', receiptId: 'check-receipt', revision: 1, affectedSources: ['checklists', 'briefing'] };
  });
  const user = userEvent.setup();
  const view = renderDetail('manuals', makeHost().host, { store: newStore() });
  await user.click(await screen.findByRole('button', { name: '메모로 만들기' }));
  await user.type(screen.getByRole('textbox', { name: '메모' }), '마감 점검');
  await user.click(screen.getByRole('button', { name: '초안 만들기' }));
  expect(backend.callsTo('POST', `${insight}/manual-drafts`)[0]?.body).toEqual({ memo: '마감 점검' });
  await user.click(await screen.findByRole('radio', { name: '마감' }));
  await user.click(await screen.findByRole('button', { name: '저장하기' }));
  expect(backend.callsTo('POST', `${insight}/manual-drafts/${draftId}/save`)).toHaveLength(0);
  await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '게시하기' }));
  await user.click(await screen.findByRole('checkbox', { name: '기기 전원을 꺼요' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: '기기 전원을 꺼요' })).toBeChecked());
  expect(backend.callsTo('POST', `${insight}/manual-drafts/${draftId}/save`)[0]?.body).toMatchObject({ expectedRevision: 2, category: 'closing' });
  expect(backend.callsTo('POST', `${insight}/checklists`)[0]?.body).toEqual({ manualId, stepNo: 1, checked: true, expectedRevision: 1, expectedChecklistRevision: 0, businessDay: updatedAt.slice(0, 10) });
  view.unmount();
  const fresh = renderDetail('manuals', makeHost().host, { store: newStore() });
  expect(await screen.findByRole('checkbox', { name: '기기 전원을 꺼요' })).toBeChecked();
  fresh.unmount();
  const nextDay = addDays(TODAY, 1);
  setBusinessDay(nextDay);
  renderDetail('manuals', makeHost().host, { store: newStore() });
  expect(await screen.findByRole('checkbox', { name: '기기 전원을 꺼요' })).not.toBeChecked();
  expect(backend.callsTo('GET', `${insight}/checklists`).at(-1)?.query).toEqual({ limit: '100', from: nextDay, to: nextDay });
});

describe('manuals panel (AC-262)', () => {
  it('1×1 shows the manual count', () => {
    const store = createWidgetDataStore();
    renderPanel('manuals', 1, 1, makeHost().host, { store });
    expect(screen.getByText('인수인계')).toBeInTheDocument();
    expect(screen.getByText(String(model(store).publishedCount))).toBeInTheDocument();
  });
  it('1×2 lists opening, closing and new staff first', () => {
    const store = createWidgetDataStore();
    renderPanel('manuals', 1, 2, makeHost().host, { store });
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows.slice(0, 3)).toEqual(['opening', 'closing', 'new-staff'].map((category) => koText(firstOf(store, category).title)));
  });
  it('2×1 shows the two most recent manuals', () => {
    renderPanel('manuals', 2, 1, makeHost().host);
    expect(screen.getByText('최근 고침')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
  it('empty state shows the sentence and a create button that opens the detail (AC-263)', async () => {
    const { host, openDetail } = makeHost();
    renderPanel('manuals', 1, 1, host, { preview: { family: 'empty', overrides: {} } });
    expect(screen.getByText('아직 만든 매뉴얼이 없어요')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /매뉴얼 만들기/ }));
    expect(openDetail).toHaveBeenCalledWith({ featureId: 'manuals', focus: 'action' });
  });
});

describe('manuals detail', () => {
  it('checks a step, shows the progress and records it', async () => {
    const store = createWidgetDataStore();
    const {host, notify} = makeHost();
    renderDetail('manuals', host, { store });
    const opening = firstOf(store, 'opening');
    const total = opening.steps.length;
    const done = () => model(store).todayChecklist.find((c) => c.manualId === opening.manualId)?.done;
    const start = done()!;
    const stepName = koText(opening.steps.find((s) => !s.checkedToday)!.body);
    await userEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(koText(opening.title)) }));
    expect(screen.getAllByText(`${start}/${total}`).length).toBeGreaterThan(0);
    expect(screen.getAllByText(`${total}단계 중 ${start}단계 완료`).length).toBeGreaterThan(0);
    expect(screen.queryByRole('img', { name: /단계 예시 그림/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/가상 교육용 매뉴얼/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: stepName }));
    expect(screen.getAllByText(`${start + 1}/${total}`).length).toBeGreaterThan(0);
    expect(done()).toBe(start + 1);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({messageKey:'data.management.notice.stepCompleted', params:{name:stepName}, undoToken:expect.any(String)}));
    await userEvent.click(screen.getByRole('checkbox', { name: stepName }));
    expect(done()).toBe(start);
  });

  it('filters by category tab', async () => {
    const store = createWidgetDataStore();
    renderDetail('manuals', makeHost().host, { store });
    const group = model(store).byCategory.find((c) => c.category === 'new-staff')!;
    await userEvent.click(screen.getByRole('tab', { name: `${koKey(group.categoryKey)} ${group.count}` }));
    const list = screen.getByRole('list', { name: '매뉴얼 목록' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(group.count);
  });

  it('a note makes a draft that stays out of the count until saved (n → n + 1)', async () => {
    const store = createWidgetDataStore();
    renderDetail('manuals', makeHost().host, { store });
    const before = model(store).publishedCount;
    expect(before).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '메모로 만들기' }));
    await userEvent.type(screen.getByRole('textbox', { name: '메모' }), '우유는 먼저 받은 것부터 써요');
    await userEvent.click(screen.getByRole('button', { name: '초안 만들기' }));
    expect(screen.getByText('저장하기 전에는 매뉴얼 수에 들어가지 않아요')).toBeInTheDocument();
    expect(model(store).publishedCount).toBe(before);
    expect(model(store).drafts).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(model(store).publishedCount).toBe(before + 1);
    expect(screen.getByRole('tab', {name:`인수인계 ${before + 1}개`})).toBeInTheDocument();
  });

  it('asks for a memo before making a draft', async () => {
    renderDetail('manuals', makeHost().host);
    await userEvent.click(screen.getByRole('button', { name: '메모로 만들기' }));
    await userEvent.click(screen.getByRole('button', { name: '초안 만들기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('메모를 적어 주세요');
  });
});

describe('manual document layout', () => {
  const css = ['src/ui/tokens.css', 'src/ui/mastermanage.css', 'src/features/widgets/mgmt-store/widget.css']
    .map(path => readFileSync(path, 'utf8')).join('\n');
  let styles: HTMLStyleElement;
  beforeEach(() => {
    styles = document.createElement('style');
    styles.textContent = css;
    document.head.append(styles);
  });
  afterEach(() => styles.remove());

  it('keeps edit and destructive delete together in a row of 48 px controls (the kit sets the height; the widget adds no override)', async () => {
    renderDetail('manuals', makeHost().host, { textScale: 125 });
    await userEvent.click(screen.getByRole('tab', { name: /매장 정보/ }));
    const edit = screen.getByRole('button', { name: '문서 고치기' });
    const remove = screen.getByRole('button', { name: '문서 지우기' });
    expect(remove).toHaveClass('ui-button--destructive');
    expect(remove.parentElement).toBe(edit.parentElement);
    const row = getComputedStyle(edit.parentElement!);
    expect(row.display).toBe('flex');
    expect(row.justifyContent).toBe('flex-end');
    for (const button of [edit, remove]) {
      expect(getComputedStyle(button).minHeight).toBe('var(--target-default)');
      expect(getComputedStyle(button).height).toBe('');
      expect(getComputedStyle(button.firstElementChild!).paddingBlock).not.toBe('var(--space-0)');
    }
  });

  it.each([{ textScale: 100, rowHeight: '56px' }, { textScale: 125, rowHeight: '64px' }] as const)(
    'gives checklist progress rows a $rowHeight minimum at $textScale% text size', async ({ textScale, rowHeight }) => {
      renderDetail('manuals', makeHost().host, { textScale });
      await userEvent.click(screen.getByRole('tab', { name: /매장 정보/ }));
      const list = screen.getByRole('list', { name: '오늘 체크리스트' });
      expect(getComputedStyle(document.documentElement).getPropertyValue('--table-row-min')).toBe(rowHeight);
      const rows = within(list).getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const style = getComputedStyle(row);
        expect(style.minHeight).toBe('var(--table-row-min)');
        expect(style.alignItems).toBe('center');
        expect(style.paddingBlock).toBe('var(--space-2)');
      }
    },
  );

  it('uses equal card tracks and reserves the badge line on every list card', () => {
    renderDetail('manuals', makeHost().host, { textScale: 125 });
    const list = screen.getByRole('list', { name: '매뉴얼 목록' });
    const cards = within(list).getAllByRole('button');
    expect(cards.filter(card => card.textContent?.includes('체크리스트'))).toHaveLength(2);
    expect(getComputedStyle(list).gridAutoRows).toBe('1fr');
    for (const card of cards) {
      expect(getComputedStyle(card.parentElement!).display).toBe('grid');
      expect(getComputedStyle(card.querySelector('.mgmt-manual-item__meta')!).minHeight).toBe('var(--space-8)');
    }
  });

  it('groups the title and category and sets consistent spacing around each procedure step', () => {
    const store = createWidgetDataStore();
    const { container } = renderDetail('manuals', makeHost().host, { store });
    const doc = container.querySelector<HTMLElement>('.mgmt-manual')!;
    const first = model(store).manuals[0]!;
    const title = within(doc).getByRole('heading', { name: koText(first.title) });
    const heading = title.parentElement!;
    expect(heading).toContainElement(within(doc).getByText(koKey(first.categoryKey)));
    expect(getComputedStyle(heading).gap).toBe('var(--space-2)');
    expect(getComputedStyle(doc).gap).toBe('var(--space-6)');
    const procedure = within(doc).getByRole('heading', { name: '하는 방법' }).parentElement!;
    expect(getComputedStyle(procedure).gap).toBe('var(--space-4)');
    const steps = within(procedure).getByRole('group', { name: /오늘 체크리스트/ });
    expect(getComputedStyle(steps).gap).toBe('var(--space-4)');
    for (const step of steps.children) {
      expect(getComputedStyle(step).gap).toBe('var(--space-2)');
      expect(step.querySelector('figure > figcaption')).toBeNull();
    }
  });
});

const generated = () => Response.json({
  kind: 'manual', draftId: 'manual-draft', sourceLabels: ['예시 메모'],
  content: { title: '오픈 준비', steps: ['조명과 음악을 켜요', '재고를 확인해요'], cautions: '별도 주의사항 확인 필요' },
});

function openNaverManual() {
  const store = createWidgetDataStore();
  renderDetail('manuals', makeHost().host, { store, textScale: 125 });
  fireEvent.click(screen.getByRole('button', { name: '문서 만들기' }));
  const form = screen.getByRole('form', { name: '문서 만들기' });
  fireEvent.click(within(form).getByRole('radio', { name: '인수인계' }));
  fireEvent.click(within(form).getByRole('radio', { name: '오픈 전 조명·장비·재고 점검' }));
  return { store, form };
}

it('edits a generated title, ordered steps and cautions, then publishes using the existing store', async () => {
  let respond!: (response: Response) => void;
  const transport = vi.fn(() => new Promise<Response>(resolve => { respond = resolve; }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
  const { store, form } = openNaverManual();
  const generate = within(form).getByRole('button', { name: '문서 초안 만들기' });
  const save = within(form).getByRole('button', { name: '저장하기' });
  fireEvent.click(generate);
  fireEvent.click(generate);
  expect(within(form).getByText('초안을 만들고 있어요')).toHaveAttribute('role', 'status');
  expect(save).toBeDisabled();
  const before = model(store).publishedCount;
  expect(transport).toHaveBeenCalledExactlyOnceWith('/api/navis/widget-drafts', expect.objectContaining({
    body: '{"widget":"manuals","sampleId":"mn-open"}',
  }));
  respond(generated());
  await waitFor(() => expect(within(form).getByRole('textbox', { name: '제목' })).toHaveValue('오픈 준비'));
  expect(model(store).publishedCount).toBe(before);
  expect(within(form).getByRole('textbox', { name: '주의할 점(선택)' })).toHaveValue('별도 주의사항 확인 필요');
  fireEvent.change(within(form).getByRole('textbox', { name: '제목' }), { target: { value: '' } });
  fireEvent.click(save);
  expect(within(form).getByRole('alert')).toHaveTextContent('제목을 넣어 주세요');
  fireEvent.change(within(form).getByRole('textbox', { name: '제목' }), { target: { value: '아침 점검 문서' } });
  fireEvent.change(within(form).getByRole('textbox', { name: '1단계' }), { target: { value: '입구 조명을 먼저 켜요' } });
  fireEvent.change(within(form).getByRole('textbox', { name: '주의할 점(선택)' }), { target: { value: '입구 매트를 확인해요' } });
  fireEvent.click(save);
  expect(model(store).publishedCount).toBe(before + 1);
  expect(screen.getByRole('button', { name: /아침 점검 문서/ })).toBeVisible();
  expect(await screen.findByText('입구 조명을 먼저 켜요')).toBeVisible();
  expect(screen.getByText(/입구 매트를 확인해요/)).toBeVisible();
});

it('keeps edits on failure and leaves the published count alone when abandoned', async () => {
  const transport = vi.fn().mockResolvedValueOnce(generated())
    .mockResolvedValueOnce(Response.json({ code: 'INVALID_OUTPUT' }, { status: 502 }))
    .mockResolvedValueOnce(generated());
  vi.spyOn(globalThis, 'fetch').mockImplementation(transport);
  const { store, form } = openNaverManual();
  const before = model(store).publishedCount;
  const generate = within(form).getByRole('button', { name: '문서 초안 만들기' });
  fireEvent.click(generate);
  const title = within(form).getByRole('textbox', { name: '제목' });
  await waitFor(() => expect(title).toHaveValue('오픈 준비'));
  fireEvent.change(title, { target: { value: '고친 제목' } });
  fireEvent.click(generate);
  const alert = await within(form).findByRole('alert');
  expect(title).toHaveValue('고친 제목');
  fireEvent.click(within(alert).getByRole('button', { name: '다시 시도하기' }));
  await waitFor(() => expect(title).toHaveValue('오픈 준비'));
  fireEvent.click(within(form).getByRole('radio', { name: '자료가 없는 예시' }));
  fireEvent.click(within(form).getByRole('button', { name: '문서 초안 만들기' }));
  expect(within(form).getByText('초안을 만들 예시 자료가 없어요')).toBeVisible();
  expect(title).toHaveValue('');
  fireEvent.click(within(form).getByRole('button', { name: '닫기' }));
  expect(model(store).publishedCount).toBe(before);
  expect(model(store).drafts).toHaveLength(0);
});

describe('recheck 12: labels, chip and guards', () => {
  it('names both tabs with the unit the panel uses: 인수인계 {n}개 / 매장 정보 {n}개 (LOCALES W-A10)', () => {
    const store = createWidgetDataStore();
    renderDetail('manuals', makeHost().host, { store });
    const { publishedCount, storeInfoCount } = model(store);
    expect(screen.getByRole('tab', { name: `인수인계 ${publishedCount}개` })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: `매장 정보 ${storeInfoCount}개` })).toBeInTheDocument();
  });

  it('shows the 체크리스트 kind chip without the green ✓ (a kind, not a done state)', () => {
    const store = createWidgetDataStore();
    renderDetail('manuals', makeHost().host, { store });
    const list = screen.getByRole('list', { name: '매뉴얼 목록' });
    const chips = [...list.querySelectorAll<HTMLElement>('.ui-status-badge')];
    expect(chips).toHaveLength(model(store).manuals.filter((m) => m.checklist).length);
    for (const chip of chips) {
      expect(chip).toHaveTextContent('체크리스트');
      expect(chip).toHaveAttribute('data-semantic', 'none');
      expect(chip.querySelector('svg, .ui-icon')).toBeNull();
    }
  });

  const openForm = async (store: ReturnType<typeof createWidgetDataStore>) => {
    renderDetail('manuals', makeHost().host, { store });
    await userEvent.click(screen.getByRole('button', { name: '문서 만들기' }));
    return screen.getByRole('form', { name: '문서 만들기' });
  };

  it('the create form needs only a title: no step is sent when none is written (SCR-222: 제목·분류 필수)', async () => {
    const store = createWidgetDataStore();
    const dispatch = vi.spyOn(store, 'dispatch').mockImplementation((command) => command.type === 'manuals.create'
      ? { ok: true, value: { manualId: 'mn-new' }, noticeKey: 'data.management.notice.saved' } as never : { ok: true } as never);
    const form = await openForm(store);
    await userEvent.type(within(form).getByRole('textbox', { name: '제목' }), '배달 포장 규칙');
    await userEvent.click(within(form).getByRole('button', { name: '저장하기' }));
    expect(within(form).queryByText('내용을 넣어 주세요')).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'manuals.create', title: '배달 포장 규칙', steps: [] }));
  });

  it('MANUAL_TITLE_EXISTS: asks at the title with 그래도 저장하기 / 그대로 두기; leaving it keeps one document', async () => {
    const store = createWidgetDataStore();
    const existing = koText(firstOf(store, 'opening').title);
    const before = model(store).publishedCount;
    const form = await openForm(store);
    await userEvent.type(within(form).getByRole('textbox', { name: '제목' }), existing);
    await userEvent.type(within(form).getByRole('textbox', { name: '1단계' }), '문을 열어요');
    await userEvent.click(within(form).getByRole('button', { name: '저장하기' }));
    expect(within(form).getByText('같은 제목의 매뉴얼이 있어요. 그래도 새로 만들까요?')).toBeVisible();
    expect(model(store).publishedCount).toBe(before);
    await userEvent.click(within(form).getByRole('button', { name: '그대로 두기' }));
    expect(screen.queryByRole('form', { name: '문서 만들기' })).toBeNull();
    expect(model(store).publishedCount).toBe(before);
  });

  it('MANUAL_TITLE_EXISTS: 그래도 저장하기 saves the second document once; typing another title drops the question', async () => {
    const store = createWidgetDataStore();
    const existing = koText(firstOf(store, 'closing').title);
    const before = model(store).publishedCount;
    const form = await openForm(store);
    const title = within(form).getByRole('textbox', { name: '제목' });
    await userEvent.type(title, existing);
    await userEvent.type(within(form).getByRole('textbox', { name: '1단계' }), '불을 꺼요');
    await userEvent.click(within(form).getByRole('button', { name: '저장하기' }));
    await userEvent.type(title, ' 2');
    expect(within(form).queryByRole('button', { name: '그래도 저장하기' })).toBeNull();
    await userEvent.clear(title);
    await userEvent.type(title, existing);
    await userEvent.click(within(form).getByRole('button', { name: '저장하기' }));
    await userEvent.click(within(form).getByRole('button', { name: '그래도 저장하기' }));
    expect(model(store).publishedCount).toBe(before + 1);
    expect(model(store).manuals.filter((m) => koText(m.title) === existing)).toHaveLength(2);
    expect(screen.queryByRole('form', { name: '문서 만들기' })).toBeNull();
  });

  it('NOT_CHECKLIST: a refused check says so under that step and does not look saved', async () => {
    const store = createWidgetDataStore();
    const { host, notify } = makeHost();
    renderDetail('manuals', host, { store });
    const opening = firstOf(store, 'opening');
    await userEvent.click(screen.getByRole('button', { name: (name) => name.startsWith(koText(opening.title)) }));
    vi.spyOn(store, 'dispatch').mockReturnValue({ ok: false, code: 'CONFLICT', reason: 'NOT_CHECKLIST', messageKey: 'data.management.error.NOT_CHECKLIST', field: 'manualId' } as never);
    const box = screen.getByRole('checkbox', { name: koText(opening.steps[0]!.body) });
    await userEvent.click(box);
    expect(screen.getByRole('alert')).toHaveTextContent('이 문서는 체크리스트가 아니에요');
    expect(screen.getByRole('alert').closest('.mgmt-manual-step')).toContainElement(box);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a load failure inside the window carries the same warning icon as the panel state (매장 환경)', () => {
    const { container } = renderDetail('manuals', makeHost().host, { preview: { family: 'error', overrides: {} } });
    expect(screen.getByRole('alert')).toHaveTextContent('매뉴얼을 불러오지 못했어요');
    expect(container.querySelector('.ui-panel-state[data-tone="error"] .ui-panel-state__icon')).not.toBeNull();
    expect(screen.getByRole('button', { name: /다시 시도하기/ })).toBeInTheDocument();
  });
});
