import { beginDashboard } from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DetailRef, FeatureId, WidgetDetailProps, WidgetModule } from '../../contracts';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { WidgetRegistryProvider } from '../../features/widgets/registry-context';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { DetailOverlay } from './index';

afterEach(cleanup);

const link = (target: DetailRef, label: string) => (props: WidgetDetailProps) => <ActionButton onClick={() => props.host.openLinked(target)}>{label}</ActionButton>;
function stub(id: FeatureId, extra?: (props: WidgetDetailProps) => React.ReactNode): WidgetModule {
  return { id, Panel: () => null, useSummary: () => '', Detail: props => <div data-testid={`body-${id}`}>{`본문 ${id}`}{extra?.(props)}</div> };
}
const ids = ['briefing', 'suppliers', 'inventory-booking', 'local-trends', 'calendar'] as const;
const modules: WidgetModule[] = [
  stub('briefing', link({ featureId: 'inventory-booking' }, '재고 열기')),
  stub('suppliers', link({ featureId: 'local-trends' }, '동네 흐름 열기')),
  stub('calendar', link({ featureId: 'suppliers', view: 'order' }, '발주 열기')),
  stub('inventory-booking'), stub('local-trends'),
];
function setup(textScale: 100 | 125 = 100) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run);
  for (const featureId of ['briefing', 'suppliers', 'inventory-booking', 'calendar'] as const) run.actions.applyLayoutIntent({ type: 'add-tap', featureId });
  if (textScale === 125) run.actions.setTextScale(125);
  const store = createWidgetDataStore();
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <I18nProvider locale="ko"><WidgetDataProvider store={store}><WidgetRegistryProvider modules={modules}>
      <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
        <main>{ids.map(id => <button key={id} id={`panel:${id}`} onClick={() => run.actions.openDetailRef({ featureId: id }, `panel:${id}`)}>{`${id} 직접 열기`}</button>)}</main>
        <DetailOverlay run={run} />
      </UiProvider>
    </WidgetRegistryProvider></WidgetDataProvider></I18nProvider>;
  }
  render(<Harness />);
  return run;
}
/** The inline frame the dialog carries (an empty string means the stylesheet frame applies). */
const frame = () => { const { width, height, minHeight, maxHeight } = screen.getByRole('dialog').style; return { width, height, minHeight, maxHeight }; };
const openDirect = async (id: FeatureId) => { fireEvent.click(screen.getByRole('button', { name: `${id} 직접 열기` })); await waitFor(() => expect(screen.getByTestId(`body-${id}`)).toBeVisible()); };
const openLinked = async (label: string, target: FeatureId) => { fireEvent.click(screen.getByRole('button', { name: label })); await waitFor(() => expect(screen.getByTestId(`body-${target}`)).toBeVisible()); await waitFor(() => expect(screen.getByRole('button', { name: '돌아가기' })).toBeVisible()); };
const closeAll = async (run: ReturnType<typeof setup>) => { fireEvent.click(screen.getByRole('button', { name: '닫기' })); await waitFor(() => expect(run.getState().exitPendingToken).toBe(null)); };
const none = { width: '', height: '', minHeight: '', maxHeight: '' };

describe.each([{ textScale: 100 as const }, { textScale: 125 as const }])('U-D linked detail uses its own frame (text $textScale%)', ({ textScale }) => {
  it('a large target opened from the compact 브리핑 has no leftover compact height, exactly like opening it directly', async () => {
    const run = setup(textScale);
    await openDirect('briefing');
    expect(frame().height).toBe('720px'); expect(frame().width).toBe('960px');
    await openLinked('재고 열기', 'inventory-booking');
    const linked = frame();
    expect(linked).toEqual(none);
    await closeAll(run);
    await openDirect('inventory-booking');
    expect(frame()).toEqual(linked);
  });
  it('going back from a compact link to a large source restores the large frame (no stale compact height)', async () => {
    setup(textScale);
    await openDirect('suppliers');
    expect(frame()).toEqual(none);
    await openLinked('동네 흐름 열기', 'local-trends');
    expect(frame().width).toBe('960px'); expect(frame().height).not.toBe('');
    fireEvent.click(screen.getByRole('button', { name: '돌아가기' }));
    await waitFor(() => expect(screen.getByTestId('body-suppliers')).toBeVisible());
    expect(frame()).toEqual(none);
  });
  it('a compact link has the same frame as opening that widget directly, whatever compact detail was open before', async () => {
    const run = setup(textScale);
    await openDirect('suppliers');
    await openLinked('동네 흐름 열기', 'local-trends');
    const linked = frame();
    await closeAll(run);
    await openDirect('briefing'); // a taller compact frame must not leak into the next compact detail
    await closeAll(run);
    await openDirect('local-trends');
    expect(frame()).toEqual(linked);
  });
  it('a large target reached through a large source keeps the stylesheet frame (calendar -> 발주)', async () => {
    const run = setup(textScale);
    await openDirect('calendar');
    await openLinked('발주 열기', 'suppliers');
    const linked = frame();
    expect(linked).toEqual(none);
    await closeAll(run);
    await openDirect('suppliers');
    expect(frame()).toEqual(linked);
  });
});
