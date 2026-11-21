import { beginDashboard } from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useState, useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureId, WidgetModule } from '../../contracts';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { WidgetRegistryProvider } from '../../features/widgets/registry-context';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { InlineForm, UiProvider, timePolicy } from '../../ui';
import { DetailSidePanel } from '../../ui/components/detail-side-panel';
import { DetailOverlay } from './index';

afterEach(cleanup);

// K-B: one Esc = one step (SCR-210/211, DS 12.2, ARCH 13.8): help popover -> side panel -> detail window.
// Esc must reach the dialog even when focus sits on the (?) button that opened the help.
function PanelBody() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(false);
  const [note, setNote] = useState(false);
  return <>
    <button id="note-opener" type="button" onClick={() => setNote(true)}>안내 열기</button>
    {note ? <section aria-label="공고 안내" data-esc-layer>공고 본문<button type="button" data-esc-close onClick={() => { setNote(false); document.getElementById('note-opener')?.focus(); }}>닫기</button></section> : null}
    <button id="form-opener" type="button" onClick={() => setForm(true)}>폼 열기</button>
    {form ? <InlineForm title="항목 추가" onSave={() => setForm(false)} onClose={() => setForm(false)}><input aria-label="이름" /></InlineForm> : null}
    <button id="row-r1" type="button" onClick={() => setOpen(true)}>행 열기</button>
    <DetailSidePanel open={open} selectedRowId="r1" title="행 패널" onClose={() => setOpen(false)} returnFocusKey="row-r1" onRestoreFocus={key => document.getElementById(key)?.focus()}>
      패널 본문
      <InlineForm title="견적·승인" onSave={() => undefined} onClose={() => undefined}><input aria-label="견적 금액" /></InlineForm>
    </DetailSidePanel>
  </>;
}
const calendar: WidgetModule = { id: 'calendar' as FeatureId, Panel: () => null, useSummary: () => '', Detail: () => <div data-testid="body-calendar"><PanelBody /></div> };

function setup() {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run);
  run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'calendar' });
  const store = createWidgetDataStore();
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <I18nProvider locale="ko"><WidgetDataProvider store={store}><WidgetRegistryProvider modules={[calendar]}>
      <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
        <main><button id="panel:calendar" onClick={() => run.actions.openDetailRef({ featureId: 'calendar' }, 'panel:calendar')}>캘린더 열기</button></main>
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
const bodyForm = () => Array.from(document.querySelectorAll('form.ui-inline-form')).find(form => form.querySelector('.ui-inline-form__title')?.textContent === '항목 추가') ?? null;
const esc = () => { fireEvent.keyDown(document.activeElement!, { key: 'Escape', code: 'Escape' }); fireEvent.keyUp(document.activeElement!, { key: 'Escape', code: 'Escape' }); };
const helpButton = () => within(screen.getByRole('dialog')).getByRole('button', { name: /설명 보기/ });
const openHelp = async (run: ReturnType<typeof setup>) => {
  const button = helpButton(); button.focus(); fireEvent.click(button);
  await waitFor(() => expect(run.getState().widgetHelp).toMatchObject({ origin: 'detail', featureId: 'calendar' }));
  await waitFor(() => expect(document.querySelector('.ui-popover--coach:not([inert])')).not.toBeNull());
};

describe('detail Esc stack (K-B)', () => {
  it('the first Esc closes the help popover only and keeps focus on the (?) button; the second Esc closes the window', async () => {
    const run = setup(); await openRoot(); await openHelp(run);
    expect(helpButton()).toHaveFocus();
    esc();
    await waitFor(() => expect(run.getState().widgetHelp).toBeNull());
    expect(run.getState().overlay.type).toBe('detail');
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(helpButton()).toHaveFocus();
    esc();
    await waitFor(() => expect(run.getState().overlay.type).not.toBe('detail'));
    await waitFor(() => expect(document.getElementById('panel:calendar')).toHaveFocus());
  });
  it('help opened by keyboard (Enter on the focused button) closes with one Esc as well', async () => {
    const run = setup(); await openRoot();
    helpButton().focus();
    fireEvent.keyDown(helpButton(), { key: 'Enter', code: 'Enter' }); fireEvent.click(helpButton()); fireEvent.keyUp(helpButton(), { key: 'Enter', code: 'Enter' });
    await waitFor(() => expect(run.getState().widgetHelp).not.toBeNull());
    esc();
    await waitFor(() => expect(run.getState().widgetHelp).toBeNull());
    expect(run.getState().overlay.type).toBe('detail');
  });
  it('with a side panel open: Esc 1 closes the help, Esc 2 the side panel (focus back on its row), Esc 3 the window', async () => {
    const run = setup(); await openRoot();
    const row = within(screen.getByRole('dialog')).getByRole('button', { name: '행 열기' });
    row.focus(); fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole('region', { name: '행 패널' })).toBeVisible());
    await openHelp(run);
    esc();
    await waitFor(() => expect(run.getState().widgetHelp).toBeNull());
    expect(screen.getByRole('region', { name: '행 패널' })).toBeVisible();
    expect(run.getState().overlay.type).toBe('detail');
    esc();
    await waitFor(() => expect(screen.queryByRole('region', { name: '행 패널' })).toBeNull());
    expect(run.getState().overlay.type).toBe('detail');
    await waitFor(() => expect(row).toHaveFocus());
    esc();
    await waitFor(() => expect(run.getState().overlay.type).not.toBe('detail'));
  });
  it('with an inline form open: Esc 1 closes the help (focus on (?)), Esc 2 the form although focus is outside it (focus back on its button), Esc 3 the window', async () => {
    const run = setup(); await openRoot();
    const opener = within(screen.getByRole('dialog')).getByRole('button', { name: '폼 열기' });
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(bodyForm()).not.toBeNull());
    await openHelp(run);
    esc();
    await waitFor(() => expect(run.getState().widgetHelp).toBeNull());
    expect(bodyForm()).not.toBeNull();
    expect(helpButton()).toHaveFocus();
    esc();
    await waitFor(() => expect(bodyForm()).toBeNull());
    expect(run.getState().overlay.type).toBe('detail');
    await waitFor(() => expect(opener).toHaveFocus());
    esc();
    await waitFor(() => expect(run.getState().overlay.type).not.toBe('detail'));
  });
  it('Esc inside an open inline form closes only the form (also with a side panel open below it)', async () => {
    const run = setup(); await openRoot();
    const row = within(screen.getByRole('dialog')).getByRole('button', { name: '행 열기' });
    row.focus(); fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole('region', { name: '행 패널' })).toBeVisible());
    const opener = within(screen.getByRole('dialog')).getByRole('button', { name: '폼 열기' });
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(bodyForm()).not.toBeNull());
    await waitFor(() => expect(document.activeElement?.closest('form')).toBe(bodyForm()));
    esc();
    await waitFor(() => expect(bodyForm()).toBeNull());
    expect(screen.getByRole('region', { name: '행 패널' })).toBeVisible();
    expect(run.getState().overlay.type).toBe('detail');
  });
  it('a form that is a section of the side panel (its close only resets values) does not swallow Esc: the panel closes, then the window', async () => {
    const run = setup(); await openRoot();
    const row = within(screen.getByRole('dialog')).getByRole('button', { name: '행 열기' });
    row.focus(); fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole('region', { name: '행 패널' })).toBeVisible());
    await waitFor(() => expect(document.activeElement?.closest('.ui-detail-side-panel')).not.toBeNull());
    esc();
    await waitFor(() => expect(screen.queryByRole('region', { name: '행 패널' })).toBeNull());
    expect(run.getState().overlay.type).toBe('detail');
    esc();
    await waitFor(() => expect(run.getState().overlay.type).not.toBe('detail'));
  });
  it('a widget-local inline layer (data-esc-layer + data-esc-close) closes with one Esc before the window, and focus goes back to its opener', async () => {
    const run = setup(); await openRoot();
    const opener = within(screen.getByRole('dialog')).getByRole('button', { name: '안내 열기' });
    opener.focus(); fireEvent.click(opener);
    await waitFor(() => expect(screen.getByLabelText('공고 안내')).toBeVisible());
    esc();
    await waitFor(() => expect(screen.queryByLabelText('공고 안내')).toBeNull());
    expect(run.getState().overlay.type).toBe('detail');
    expect(opener).toHaveFocus();
    esc();
    await waitFor(() => expect(run.getState().overlay.type).not.toBe('detail'));
  });
  it('Esc with no help and no inner layer still closes the window in one step', async () => {
    const run = setup(); await openRoot();
    esc();
    await waitFor(() => expect(run.getState().overlay.type).not.toBe('detail'));
  });
});
