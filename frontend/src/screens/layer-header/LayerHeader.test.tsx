import { beginDashboard } from '../../app/test-session';
import '../../ui/test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout';
import { App } from '../../app/App';

/** D-366: 주문/결제 uses the very header component of 관리 and 마케팅 (store name + date + right-side buttons). */
const OriginalWorker = globalThis.Worker;
class ReadyWorker { onmessage: ((e: { data: { type: string } }) => void) | null = null; postMessage(message: { type: string }) { if (message.type === 'ready') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready' } })); } terminate() {} }
beforeEach(() => vi.stubGlobal('Worker', ReadyWorker));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.stubGlobal('Worker', OriginalWorker); document.documentElement.removeAttribute('lang'); });
const started = () => {
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
  beginDashboard(run, 'cafe'); run.actions.startWithThree(); run.actions.dismissCoach();
  return run;
};
/** The exiting layer stays mounted (inert) during a switch, so only the live header counts. */
const live = () => Array.from(document.querySelectorAll<HTMLElement>('.dashboard-header')).filter(node => !node.closest('[inert],[data-exiting="true"],[aria-hidden="true"]'));
const header = () => live()[0]!;
const shape = (node: HTMLElement) => ({
  tag: node.tagName,
  title: node.querySelector('h1')?.tagName,
  date: node.querySelector(':scope > div:first-child > p')?.tagName,
  actions: node.querySelector(':scope > .dashboard-header-actions')?.tagName,
});

describe('one header for every layer (D-366)', () => {
  it('shows the store name, the date and the settings button on 주문/결제 as on 관리 and 마케팅', async () => {
    const run = started(); const user = userEvent.setup();
    render(<App run={run} />);
    const nav = screen.getByRole('navigation', { name: '화면' });
    const seen: Record<string, ReturnType<typeof shape>> = {};
    const titles: string[] = [];
    const dates: string[] = [];
    for (const [label, layer] of [['관리', 'management'], ['마케팅', 'marketing'], ['주문/결제', 'orders-payment']] as const) {
      await user.click(within(nav).getByRole('button', { name: label }));
      await waitFor(() => expect(run.getState().layer).toBe(layer));
      await waitFor(() => expect(live()).toHaveLength(1));
      await waitFor(() => expect(header().querySelector('h1')).toBeVisible());
      titles.push(header().querySelector('h1')!.textContent!);
      expect(header().querySelector(':scope > div:first-child > p')!.textContent).toMatch(/\d+월\s*\d+일/);
      dates.push(header().querySelector(':scope > div:first-child > p')!.textContent!);
      expect(within(header()).getByRole('button', { name: '설정' })).toBeVisible();
      seen[layer] = shape(header());
    }
    expect(titles).toEqual(['안숭잘부 카페', '안숭잘부 카페', '안숭잘부 카페']);
    // The owner's report: 관리 showed one day and 주문/결제 another. Every layer reads the one app business date.
    expect(new Set(dates).size).toBe(1);
    expect(seen['orders-payment']).toEqual(seen.management);
    expect(seen.marketing).toEqual(seen.management);
    expect(screen.getByRole('heading', { name: '안숭잘부 카페', level: 1 })).toBeVisible();
  });

  it('keeps the store name on 주문/결제 in every language and falls back to the layer name only without a store name', async () => {
    const run = started(); const user = userEvent.setup();
    render(<App run={run} />);
    await user.click(screen.getByRole('button', { name: '주문/결제' }));
    await waitFor(() => expect(run.getState().layer).toBe('orders-payment'));
    for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ko'] as const) {
      act(() => { run.actions.setLocale(locale); });
      await waitFor(() => expect(header().querySelector('h1')).toHaveTextContent('안숭잘부 카페'));
      expect(header().querySelector('h1')).toHaveAttribute('lang', 'ko');
      expect(header().querySelector('p')!.textContent).not.toBe('');
    }
  });

  it('keeps the 마감 정산 button of the shell beside the header on 주문/결제 and shows it at large text', async () => {
    const run = started(); const user = userEvent.setup();
    run.actions.setTextScale(125);
    render(<App run={run} />);
    await user.click(screen.getByRole('button', { name: '주문/결제' }));
    await waitFor(() => expect(run.getState().layer).toBe('orders-payment'));
    expect(document.querySelector('.app-closing-header')).not.toBeNull();
    expect(screen.getByRole('button', { name: /마감 정산/ })).toBeVisible();
    expect(header().querySelector('h1')).toHaveTextContent('안숭잘부 카페');
  });
});

describe('the same business date on every layer in both clock modes (D-366)', () => {
  const dateOf = (layer: Element) => layer.querySelector(':scope > div:first-child > p')!.textContent!;
  /**
   * Loads a fresh copy of the app under the given build flags and system time, walks 관리 → 마케팅 → 주문/결제 and returns each
   * header's date plus the business date of the POS "today" (its seed) and the app's TODAY. Modules are reset so the clock constants
   * are read again from the stubbed environment, exactly as a bundle built with those flags reads them at load.
   */
  async function walk(env: Readonly<Record<string, string>>, systemTime: string) {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(systemTime));
    try {
      await import('../../ui/test-setup');
      const [{ render, screen, waitFor, within, cleanup: cleanupFresh }, { default: userEventFresh }, state, catalog, layout, ui, session, appModule, widgetData, posSeed] = await Promise.all([
        import('@testing-library/react'), import('@testing-library/user-event'), import('../../state'), import('../../catalog'), import('../../layout'),
        import('../../ui'), import('../../app/test-session'), import('../../app/App'), import('../../data/widget-data'), import('../../pos/seed'),
      ]);
      const run = state.createRunStore({ screenPreset: layout.screenPresets.A, catalog: catalog.getRegistry('A'), time: ui.timePolicy, clock: () => 0, theme: 'light', reducedMotion: true });
      session.beginDashboard(run, 'cafe'); run.actions.startWithThree(); run.actions.dismissCoach();
      const user = userEventFresh.setup();
      render(<appModule.App run={run} />);
      const nav = screen.getByRole('navigation', { name: '화면' });
      const dates: string[] = [];
      for (const [label, layerId] of [['관리', 'management'], ['마케팅', 'marketing'], ['주문/결제', 'orders-payment']] as const) {
        await user.click(within(nav).getByRole('button', { name: label }));
        await waitFor(() => expect(run.getState().layer).toBe(layerId));
        await waitFor(() => expect(live()).toHaveLength(1));
        dates.push(dateOf(live()[0]));
      }
      const pos = posSeed.createPosSeed();
      cleanupFresh();
      return { dates, today: widgetData.TODAY as string, posDate: pos.businessDate as string, posOrders: pos.orders.length };
    } finally {
      vi.useRealTimers(); vi.unstubAllEnvs(); vi.resetModules();
    }
  }
  const monthDay = (iso: string) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;

  it('keeps one date across 관리, 마케팅 and 주문/결제 on the real clock, not the fixture date', async () => {
    const { dates, today } = await walk({ VITE_NAVIS_CLOCK: 'real' }, '2026-11-22T12:00:00+09:00');
    expect(dates).toEqual(Array(3).fill(dates[0]));
    expect(dates[0]).toContain('22일');
    expect(today).toBe('2026-11-22');
  });

  it('the live demo build (VITE_NAVIS_DATA_SOURCE=fixture, VITE_NAVIS_FIXTURE_END_DATE=2026-11-22, fixed clock) shows one date on all three headers and on the POS day', async () => {
    // The fixed clock ignores the end date by design (fixture-dates.ts), so the whole demo, POS included, stays on the sample day.
    const { dates, today, posDate, posOrders } = await walk({ VITE_NAVIS_DATA_SOURCE: 'fixture', VITE_NAVIS_FIXTURE_END_DATE: '2026-11-22' }, '2026-11-22T12:00:00+09:00');
    expect(dates).toEqual(Array(3).fill(dates[0]));
    expect(dates[0]).toContain(monthDay(today));
    expect(today).toBe('2026-11-17');
    expect(posDate).toBe(today);
    expect(posOrders).toBeGreaterThan(0);
  });

  it('with the real clock and the end date, the headers and the POS day (its seeded orders) are all on that end date', async () => {
    const { dates, today, posDate, posOrders } = await walk(
      { VITE_NAVIS_DATA_SOURCE: 'fixture', VITE_NAVIS_CLOCK: 'real', VITE_NAVIS_FIXTURE_END_DATE: '2026-11-22' }, '2026-11-22T12:00:00+09:00');
    expect(dates).toEqual(Array(3).fill(dates[0]));
    expect(dates[0]).toContain('22일');
    expect(today).toBe('2026-11-22');
    expect(posDate).toBe('2026-11-22');
    expect(posOrders).toBeGreaterThan(0);
  });
});
