import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FeatureId, WidgetModule } from '../../contracts';
import { getRegistry } from '../../catalog';
import { createWidgetDataStore } from '../../data/widget-data';
import { WidgetDataProvider } from '../../data/react';
import { WidgetRegistryProvider } from '../../features/widgets/registry-context';
import { setCctvMode } from '../../features/cctv';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore } from '../../state';
import { UiProvider, timePolicy } from '../../ui';
import { DetailOverlay } from './index';
import { beginDashboard } from '../../app/test-session';

const stub = (id: FeatureId): WidgetModule => ({ id, Panel: () => null, useSummary: () => '', Detail: () => <div>{`본문 ${id}`}</div> });
const modules = [stub('customer-analysis'), stub('calendar')];
const LIVE = '영상은 저장하지 않아요';
const OLD_NOTICE = '가짜 데이터로 만든 화면이에요';

function open(id: FeatureId) {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => performance.now(), theme: 'light', reducedMotion: true });
  beginDashboard(run);
  run.actions.applyLayoutIntent({ type: 'add-tap', featureId: id });
  const store = createWidgetDataStore();
  function Harness() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <I18nProvider locale="ko"><WidgetDataProvider store={store}><WidgetRegistryProvider modules={modules}>
      <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>
        <main><button id={`panel:${id}`} onClick={() => run.actions.openDetailRef({ featureId: id }, `panel:${id}`)}>열기</button></main>
        <DetailOverlay run={run} />
      </UiProvider>
    </WidgetRegistryProvider></WidgetDataProvider></I18nProvider>;
  }
  render(<Harness />);
  const opener = screen.getByRole('button', { name: '열기' });
  opener.focus(); fireEvent.click(opener);
  return waitFor(() => expect(screen.getByRole('dialog')).toBeVisible());
}
afterEach(() => { cleanup(); act(() => setCctvMode('mock')); });

describe('detail footer note', () => {
  it('leaves the shared footer empty in CCTV demo mode (the playback owns the source credit)', async () => {
    act(() => setCctvMode('mock'));
    await open('customer-analysis');
    expect(screen.getByRole('dialog').querySelector('.ui-overlay-note')).not.toHaveTextContent(/\S/u);
  });
  it('keeps only the privacy line in the CCTV live footer', async () => {
    act(() => setCctvMode('live'));
    await open('customer-analysis');
    expect(screen.getByText(LIVE, { exact: true })).toBeVisible();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(OLD_NOTICE);
  });
  it('leaves other widget footers empty while CCTV is live', async () => {
    act(() => setCctvMode('live'));
    await open('calendar');
    expect(screen.getByRole('dialog').querySelector('.ui-overlay-note')).not.toHaveTextContent(/\S/u);
  });
  it('T-079: only the CCTV detail has the empty header slot for the widget toggle; other widgets have none', async () => {
    await open('customer-analysis');
    expect(document.querySelector('.ui-overlay-header [data-detail-header-slot="customer-analysis"]')).not.toBeNull();
    cleanup();
    await open('calendar');
    expect(document.querySelector('[data-detail-header-slot]')).toBeNull();
  });
});
