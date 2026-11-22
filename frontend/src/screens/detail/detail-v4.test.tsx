import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DetailRef, FeatureId, Locale, WidgetDetailProps, WidgetModule } from '../../contracts';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { WidgetRegistryProvider } from '../../features/widgets/registry-context';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { DetailOverlay, detailFrameClass } from './index';

afterEach(cleanup);

/** Stub bodies registered through the provider; the real widget folders are other tasks'. */
function stub(id: FeatureId, extra?: (props: WidgetDetailProps) => React.ReactNode): WidgetModule {
  return {
    id,
    Panel: () => null,
    useSummary: () => '',
    Detail: props => <div data-testid={`body-${id}`} data-view={props.detailRef.view ?? ''} data-focus={props.detailRef.focus ?? ''}>{`본문 ${id}`}{extra?.(props)}</div>,
  };
}
const linkButton = (target: DetailRef, label: string) => (props: WidgetDetailProps) => <ActionButton onClick={() => props.host.openLinked(target)}>{label}</ActionButton>;
const modules: WidgetModule[] = [
  stub('calendar', linkButton({ featureId: 'inventory-booking' }, '출처 열기')),
  stub('inventory-booking', props => <div data-grid-scroll>{linkButton({ featureId: 'slot-coupon', view: 'send' }, '쿠폰 보기')(props)}</div>),
  stub('ai-response', linkButton({ featureId: 'inventory-booking' }, '출처 열기')),
  stub('community', linkButton({ featureId: 'inventory-booking' }, '출처 열기')),
  stub('slot-coupon'),
  stub('briefing'),
  stub('suppliers'),
  { ...stub('marketing-today'), Detail: null },
];

function setup(locale: Locale = 'ko', reducedMotion = true, root: FeatureId = 'calendar') {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion });
  beginDashboard(run);
  for (const featureId of ['calendar', 'briefing'] as const) run.actions.applyLayoutIntent({ type: 'add-tap', featureId });
  const store = createWidgetDataStore();
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <I18nProvider locale={locale}><WidgetDataProvider store={store}><WidgetRegistryProvider modules={modules}>
      <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
        <main><button id="panel:calendar" onClick={() => run.actions.openDetailRef({ featureId: root, ...(root === 'calendar' ? { view: 'week' } : {}), focus: 'action' }, 'panel:calendar')}>캘린더 열기</button></main>
        <DetailOverlay run={run} />
      </UiProvider>
    </WidgetRegistryProvider></WidgetDataProvider></I18nProvider>;
  }
  render(<Harness />);
  return run;
}
const openRoot = async () => {
  const opener = screen.getByRole('button', { name: '캘린더 열기' });
  opener.focus(); fireEvent.click(opener);
  await waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
};
const esc = () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' }); fireEvent.keyUp(document.activeElement!, { key: 'Escape', code: 'Escape' }); };

describe('module detail body (API-13 v4.1)', () => {
  it('draws the registry module Detail with detailRef (view, focus action) under the translated title', async () => {
    setup(); await openRoot();
    const dialog = screen.getByRole('dialog', { name: '캘린더' });
    const body = within(dialog).getByTestId('body-calendar');
    expect(body).toHaveAttribute('data-view', 'week'); expect(body).toHaveAttribute('data-focus', 'action');
    expect(within(dialog).getByRole('button', { name: /설명 보기/ })).toBeVisible();
    expect(within(dialog).queryByTestId('detail-back')).toBeNull();
  });
  it('follows the language: English title, help and close names', async () => {
    setup('en'); await openRoot();
    const dialog = screen.getByRole('dialog', { name: '캘린더' });
    expect(within(dialog).getByRole('button', { name: 'About 캘린더' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeVisible();
    expect(within(dialog).queryByText('This screen uses sample data')).not.toBeInTheDocument();
  });
  it('classifies frames 16 / 3 / 2', () => {
    expect(detailFrameClass('briefing')).toBe('compact'); expect(detailFrameClass('local-changes')).toBe('compact'); expect(detailFrameClass('local-trends')).toBe('compact');
    expect(detailFrameClass('inventory-booking')).toBe('large'); expect(detailFrameClass('suppliers')).toBe('large');
    for (const id of ['ledger', 'margin', 'calendar', 'tax', 'slot-coupon', 'marketing-performance'] as const) expect(detailFrameClass(id)).toBe('large');
  });
});

describe('one-level detail stack', () => {
  it.each(['calendar', 'ai-response', 'community'] as const)('restores the %s dialog body when returning from a linked grid', async root => {
    setup('ko', true, root);
    await openRoot();
    const outer = screen.getByTestId(`body-${root}`).closest<HTMLElement>('.ui-overlay-body')!;
    outer.scrollTop = 780;
    fireEvent.scroll(outer);

    fireEvent.click(screen.getByRole('button', { name: '출처 열기' }));
    const linked = await screen.findByTestId('body-inventory-booking');
    const linkedOuter = linked.closest<HTMLElement>('.ui-overlay-body')!;
    linkedOuter.scrollTop = 0;
    fireEvent.scroll(linkedOuter);
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));

    await waitFor(() => expect(screen.getByTestId(`body-${root}`).closest<HTMLElement>('.ui-overlay-body')!.scrollTop).toBe(780));
  });

  it('restores a linked source that scrolls both the containing dialog and its grid', async () => {
    setup('ko', true, 'inventory-booking');
    await openRoot();
    const root = screen.getByTestId('body-inventory-booking');
    const outer = root.closest<HTMLElement>('.ui-overlay-body')!;
    const table = root.querySelector<HTMLElement>('[data-grid-scroll]')!;
    outer.scrollTop = 40;
    table.scrollTop = 150;
    table.scrollLeft = 65;
    fireEvent.scroll(table);

    fireEvent.click(screen.getByRole('button', { name: '쿠폰 보기' }));
    const linked = await screen.findByTestId('body-slot-coupon');
    linked.closest<HTMLElement>('.ui-overlay-body')!.scrollTop = 0;
    table.scrollTop = 0;
    table.scrollLeft = 0;
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));

    await waitFor(() => expect([outer.scrollTop, table.scrollTop, table.scrollLeft]).toEqual([40, 150, 65]));
  });

  it('opens a source detail without changing the layer and goes back with 돌아가기', async () => {
    const run = setup(); await openRoot();
    const layer = run.getState().layer;
    fireEvent.click(screen.getByRole('button', { name: '출처 열기' }));
    const dialog = await screen.findByRole('dialog', { name: /재고/ });
    // A linked detail grows from the centre with opacity 0 → 1 (M-06 variant): wait for its first frame.
    await waitFor(() => expect(within(dialog).getByTestId('body-inventory-booking')).toBeVisible());
    expect(run.getState().layer).toBe(layer);
    const back = within(dialog).getByRole('button', { name: '돌아가기' });
    await waitFor(() => expect(back).toHaveFocus());
    fireEvent.click(back);
    expect(await screen.findByTestId('body-calendar')).toBeInTheDocument();
    expect(screen.queryByTestId('detail-back')).toBeNull();
    expect(run.getState().overlay).toMatchObject({ type: 'detail', featureId: 'calendar' });
  });
  it('opens a widget of another layer (AC-233) and returns focus to the first opener on close', async () => {
    const run = setup(); await openRoot();
    fireEvent.click(screen.getByRole('button', { name: '출처 열기' }));
    await screen.findByTestId('body-inventory-booking');
    fireEvent.click(screen.getByRole('button', { name: '쿠폰 보기' }));
    const body = await screen.findByTestId('body-slot-coupon');
    expect(body).toHaveAttribute('data-view', 'send');
    expect(run.getState().layer).toBe('management');
    expect(screen.queryByRole('button', { name: '쿠폰 보기' })).toBeNull();
    // the stack never grows past two entries: back leads to the first detail, not the middle one
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    expect(await screen.findByTestId('body-calendar')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(run.getState().overlay.type).toBe('none');
    await waitFor(() => expect(screen.getByRole('button', { name: '캘린더 열기' })).toHaveFocus());
  });
  it('closing from the linked detail closes both and focuses the original opener', async () => {
    const run = setup(); await openRoot();
    fireEvent.click(screen.getByRole('button', { name: '출처 열기' }));
    await screen.findByTestId('body-inventory-booking');
    esc();
    expect(run.getState().overlay.type).toBe('none');
    await waitFor(() => expect(screen.getByRole('button', { name: '캘린더 열기' })).toHaveFocus());
  });
});

describe('D-228 bounded detail body', () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement('style');
    const kitCss = readFileSync(resolve(__dirname, '../../ui/tokens.css'), 'utf8');
    style.textContent = readFileSync(resolve(__dirname, 'detail-v4.css'), 'utf8') + '\n'
      + kitCss.match(/\.ui-overlay-body\s*\{[^}]*\}/)![0];
    document.head.append(style);
  });
  afterEach(() => style.remove());

  const expectBoundedColumn = (element: Element) => {
    const computed = getComputedStyle(element);
    expect(computed.height).toBe('100%');
    expect(computed.minHeight).toBe('0');
    expect(computed.display).toBe('flex');
    expect(computed.flexDirection).toBe('column');
  };

  it('passes the body height through the portal host and visible retained view to the widget', async () => {
    setup(); await openRoot();
    const slot = screen.getByRole('dialog').querySelector('.detail-body-slot')!;
    expect(getComputedStyle(slot.parentElement!).overflowY).toBe('auto');
    const host = slot.firstElementChild!;
    const view = host.querySelector(':scope > div:not([hidden])')!;
    for (const element of [slot, host, view]) expectBoundedColumn(element);
    const module = view.querySelector('.detail-module-body')!;
    expect(getComputedStyle(module).minHeight).toBe('0');
    expect(getComputedStyle(module).flexGrow).toBe('1');
  });

  it('keeps retained sources hidden and inert while the linked view receives the height, then restores it on back', async () => {
    setup(); await openRoot();
    const source = screen.getByTestId('body-calendar').closest('.detail-module-body')!.parentElement!;
    fireEvent.click(screen.getByRole('button', { name: '출처 열기' }));
    const linked = await screen.findByTestId('body-inventory-booking');
    expect(source).toHaveAttribute('hidden');
    expect(source).toHaveAttribute('inert');
    expect(getComputedStyle(source).display).toBe('none');
    expectBoundedColumn(linked.closest('.detail-module-body')!.parentElement!);
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    expect(source).not.toHaveAttribute('hidden');
    expect(source).not.toHaveAttribute('inert');
    expectBoundedColumn(source);
  });

  it('leaves overflow visible through non-grid views so the existing dialog body can scroll tall content', async () => {
    setup(); await openRoot();
    const body = screen.getByTestId('body-calendar');
    const slot = screen.getByRole('dialog').querySelector('.detail-body-slot')!;
    for (let element: Element | null = body; element && element !== slot.parentElement; element = element.parentElement) {
      const computed = getComputedStyle(element);
      expect(['hidden', 'clip']).not.toContain(computed.overflow);
      expect(['hidden', 'clip']).not.toContain(computed.overflowY);
    }
    expect(body).toBeVisible();
  });
});

describe('detail help (?)', () => {
  it('opens the widget coach inside the detail; Esc closes the help first, then the detail', async () => {
    const run = setup(); await openRoot();
    fireEvent.click(screen.getByRole('button', { name: /설명 보기/ }));
    expect(run.getState().widgetHelp).toMatchObject({ featureId: 'calendar', origin: 'detail' });
    const coachBody = await waitFor(() => { const node = document.querySelector('.ui-widget-coach__body'); expect(node).not.toBeNull(); return node!; });
    expect(coachBody.textContent).toBe('매장 운영과 발주 납기, 세금 일정을 한곳에서 봐요. 월·주·일로 바꿔 보고 일정을 직접 더해요.');
    esc();
    expect(run.getState().widgetHelp).toBeNull();
    expect(run.getState().overlay.type).toBe('detail');
    esc();
    expect(run.getState().overlay.type).toBe('none');
  });
  it('closes the detail help when the detail goes back', async () => {
    const run = setup(); await openRoot();
    fireEvent.click(screen.getByRole('button', { name: '출처 열기' }));
    await screen.findByTestId('body-inventory-booking');
    act(() => { run.actions.openWidgetHelp('inventory-booking', 'detail', 'x'); });
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    expect(run.getState().widgetHelp).toBeNull();
  });
});

describe('modules without Detail', () => {
  it('does not draw a module body for marketing-today (the host resolves its tap)', async () => {
    const run = setup();
    act(() => { run.actions.openDetailRef({ featureId: 'marketing-today' }, 'panel:calendar'); });
    expect(screen.queryByTestId('body-marketing-today')).toBeNull();
  });
});
