import {selectCommonNotice} from '../state';
import {beginDashboard} from './test-session';
import '../ui/test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createRunStore } from '../state';
import { timePolicy } from '../ui';
import { getCatalog, getRegistry } from '../catalog';
import { screenPresets } from '../layout';
import { ALL_DATA_WIDGET_IDS, previewVariants } from '../data/widget-data';
import { App } from './App';
import { createBrowserRun } from './run';

const OriginalWorker = globalThis.Worker;
class ReadyWorker { onmessage: ((e: { data: { type: string } }) => void) | null = null; postMessage(message: { type: string }) { if (message.type === 'ready') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } })); } terminate() {} }
beforeEach(() => vi.stubGlobal('Worker', ReadyWorker));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.stubGlobal('Worker', OriginalWorker); document.documentElement.removeAttribute('lang'); });
const makeRun = () => createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
const started = () => { const run = makeRun(); beginDashboard(run,'cafe'); run.actions.startWithThree(); run.actions.dismissCoach(); return run; };

describe('v4 run (T-054 first step)', () => {
  it('browser runs and App resets use the 30-widget registry, not the iteration-3 catalog', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920); vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1080);
    const run = createBrowserRun({ theme: 'light', reducedMotion: true })!;
    expect(run.catalog).toHaveLength(30);
    expect(run.catalog.every(feature => 'layer' in feature)).toBe(true);
    // T-055: the iteration-3 22-item list is gone; the run catalog is the registry itself.
    expect(getCatalog('A')).toBe(getRegistry('A'));
  });
});

describe('layer menu reads state.layer (AC-174, AC-189)', () => {
  it('switches boards through the store, keeps both boards, and marketing is a dashboard board', async () => {
    const run = started(); const user = userEvent.setup(); const managementPanels = run.getState().boards.management.pages;
    render(<App run={run} />);
    const nav = screen.getByRole('navigation', { name: '화면' });
    expect(within(nav).getByRole('button', { name: '관리' })).toHaveAttribute('aria-current', 'page');
    await user.click(within(nav).getByRole('button', { name: '마케팅' }));
    expect(run.getState().layer).toBe('marketing');
    expect(within(nav).getByRole('button', { name: '마케팅' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('heading', { name: '마케팅은 준비 중이에요' })).not.toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: '주문/결제' }));
    expect(run.getState().layer).toBe('orders-payment');
    expect(screen.getByRole('heading', { name: '주문/결제', level: 1 })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '관리' }));
    expect(run.getState().layer).toBe('management');
    expect(run.getState().boards.management.pages).toBe(managementPanels);
    expect(run.getState().panels).toHaveLength(3);
  });
});

describe('language (AC-207~209, AC-216)', () => {
  it('translates the whole shell at once for each language, sets document lang, and a new run starts in Korean', async () => {
    const run = started(); render(<App run={run} />);
    const expected = { en: ['Management', 'en'], 'zh-Hans': ['管理', 'zh-Hans'], 'zh-Hant': ['管理', 'zh-Hant'], ko: ['관리', 'ko'] } as const;
    for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ko'] as const) {
      act(() => { run.actions.setLocale(locale); });
      expect(within(document.querySelector<HTMLElement>('.app-layer-navigation nav')!).getByRole('button', { name: expected[locale][0] })).toHaveAttribute('aria-current', 'page');
      expect(document.documentElement).toHaveAttribute('lang', expected[locale][1]);
    }
    act(() => { run.actions.setLocale('en'); });
    act(() => run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light', reducedMotion: true }));
    expect(run.getState().locale).toBe('ko');
    expect(document.documentElement).toHaveAttribute('lang', 'ko');
    expect(screen.getByRole('heading', { name: '어떤 가게를 하세요?' })).toBeVisible();
  });
  it('the business question follows the language', () => {
    const run = makeRun(); run.actions.setLocale('en'); render(<App run={run} />);
    expect(screen.getByRole('heading', { name: 'What kind of shop do you run?' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cafe' })).toBeVisible();
    expect(screen.getByRole('button', { name: "I'll choose later" })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Dark mode' })).toBeNull();
  });
  it('settings → language applies at once, keeps the dialog and panels, and announces in the new language', async () => {
    const run = started(); const user = userEvent.setup(); render(<App run={run} />);
    const panels = run.getState().panels; const id = run.getState().runId;
    await user.click(screen.getByRole('button', { name: '설정' }));
    await user.click(await screen.findByRole('button', { name: /^언어, 한국어/ }));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(run.getState().locale).toBe('en');
    const dialog = screen.getByRole('dialog', { name: 'Language' });
    expect(within(dialog).getByRole('radio', { name: 'English' })).toBeChecked();
    expect(screen.getAllByRole('status').some(node => node.textContent === 'Language changed')).toBe(true);
    expect(document.documentElement).toHaveAttribute('lang', 'en');
    await user.click(screen.getByRole('radio', { name: '简体中文' }));
    expect(screen.getByRole('dialog', { name: '语言' })).toBeVisible();
    expect(document.documentElement).toHaveAttribute('lang', 'zh-Hans');
    expect(run.getState()).toMatchObject({ runId: id, panels });
  });
});

describe('example-state view (AC-229)', () => {
  it('family choice shows the header chip on the order screen; normal hides it; by-widget picks replace it and a family change clears them', async () => {
    const run = started(); const user = userEvent.setup(); render(<App run={run} />);
    await user.click(screen.getByRole('button', { name: '주문/결제' }));
    expect(screen.queryByRole('button', { name: /예시 상태:/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '설정' }));
    await user.click(await screen.findByRole('button', { name: /^예시 상태 보기, 정상/ }));
    await user.click(screen.getByRole('radio', { name: '비어 있음' }));
    expect(run.getState().preview.family).toBe('empty');
    await user.click(screen.getByRole('button', { name: /^패널별로 고르기/ }));
    const listed = ALL_DATA_WIDGET_IDS.filter(widget => previewVariants(widget).length >= 2);
    expect(listed.length).toBe(30);
    const rows = screen.getAllByRole('button').filter(button => button.classList.contains('ui-list-select-row'));
    expect(rows).toHaveLength(listed.length+2);
    expect(screen.getByRole('button',{name:/마감 정산 결제 내역/})).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^손익, / }));
    await user.click(screen.getByRole('radio', { name: '불러오기 실패' }));
    expect(run.getState().preview).toEqual({ family: 'empty', overrides: { ledger: 'error' } });
    // The kit sub-view header repeats back and close; CSS hides it, jsdom does not, so use the dialog header's own buttons (first in the DOM).
    await user.click(screen.getAllByRole('button', { name: '설정으로' })[0]);
    await user.click(screen.getAllByRole('button', { name: '설정으로' })[0]);
    await user.click(screen.getAllByRole('button', { name: '닫기' })[0]);
    expect(await screen.findByRole('button', { name: '예시 상태: 패널별 1개. 설정에서 예시 상태 바꾸기' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: /예시 상태: 패널별 1개/ }));
    expect(await screen.findByRole('dialog', { name: '예시 상태 보기' })).toBeVisible();
    await user.click(screen.getByRole('radio', { name: '불러오기 실패' }));
    expect(run.getState().preview).toEqual({ family: 'error', overrides: {} });
    await user.click(screen.getByRole('radio', { name: '정상' }));
    expect(run.getState().preview).toEqual({ family: 'normal', overrides: {} });
  });
  it('a new run is normal again', () => {
    const run = started(); run.actions.setPreviewFamily('error');
    act(() => run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light', reducedMotion: true }));
    expect(run.getState().preview).toEqual({ family: 'normal', overrides: {} });
  });
});

describe('data notices', () => {
  it('a data notice with an undo token keeps target data (executed by the data store, API-03 v4.2)', () => {
    const run = started();
    run.actions.showNotice({ kind: 'success', messageKey: 'data.notice.expenseRecorded', undo: { target: 'data', token: 'u1' } });
    expect(selectCommonNotice(run.getState())).toMatchObject({ messageKey: 'data.notice.expenseRecorded', undo: { target: 'data', token: 'u1' } });
  });
});
