import { beginDashboard } from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureId, PreviewSelection, WidgetModule } from '../../contracts';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { WidgetRegistryProvider } from '../../features/widgets/registry-context';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { UiProvider, timePolicy } from '../../ui';
import { DetailOverlay } from './index';

/** K-E 11: an empty or failed widget opens in the compact window (560 / 640 at 125%), a ready one keeps the large frame. */
afterEach(cleanup);
const stub = (id: FeatureId): WidgetModule => ({ id, Panel: () => null, useSummary: () => '', Detail: () => <div data-testid={`body-${id}`}>{`본문 ${id}`}</div> });
const modules = [stub('suppliers'), stub('inventory-booking')];

function setup(preview: PreviewSelection, textScale: 100 | 125 = 100) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run);
  for (const featureId of ['suppliers', 'inventory-booking'] as const) run.actions.applyLayoutIntent({ type: 'add-tap', featureId });
  if (textScale === 125) run.actions.setTextScale(125);
  const store = createWidgetDataStore();
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <I18nProvider locale="ko"><WidgetDataProvider store={store} preview={preview}><WidgetRegistryProvider modules={modules}>
      <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
        <main>{(['suppliers', 'inventory-booking'] as const).map(id => <button key={id} id={`panel:${id}`} onClick={() => run.actions.openDetailRef({ featureId: id }, `panel:${id}`)}>{`${id} 직접 열기`}</button>)}</main>
        <DetailOverlay run={run} />
      </UiProvider>
    </WidgetRegistryProvider></WidgetDataProvider></I18nProvider>;
  }
  render(<Harness />);
}
const frame = () => { const { width, height, minHeight } = screen.getByRole('dialog').style; return { width, height, minHeight }; };
const open = async (id: FeatureId) => { fireEvent.click(screen.getByRole('button', { name: `${id} 직접 열기` })); await waitFor(() => expect(screen.getByTestId(`body-${id}`)).toBeVisible()); };

describe.each([{ textScale: 100 as const, min: '560px' }, { textScale: 125 as const, min: '640px' }])('detail frame follows the state (text $textScale%)', ({ textScale, min }) => {
  it('an empty widget (no suppliers) opens in the compact window', async () => {
    setup({ family: 'normal', overrides: { suppliers: 'no-suppliers' } } as PreviewSelection, textScale);
    await open('suppliers');
    expect(frame()).toMatchObject({ width: '960px', minHeight: min });
  });
  it('a failed widget (sample error) opens in the compact window', async () => {
    setup({ family: 'normal', overrides: { suppliers: 'error' } } as PreviewSelection, textScale);
    await open('suppliers');
    expect(frame()).toMatchObject({ width: '960px', minHeight: min });
  });
  it('a ready widget keeps the large frame (no inline compact frame)', async () => {
    setup({ family: 'normal', overrides: {} } as PreviewSelection, textScale);
    await open('suppliers');
    expect(frame()).toEqual({ width: '', height: '', minHeight: '' });
  });
});
