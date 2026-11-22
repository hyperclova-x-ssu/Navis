import type { ClosingViewTab, RunStore } from '../../contracts';
import { tablesEnabled, selectPosPreferences } from '../../pos/tables';
import { dataSourceFor } from '../../data/reality/00/registry';

export type SettingsStartView = 'preview' | 'tables';
const pending = new WeakMap<RunStore, SettingsStartView>();

/** The QA address opens the example picker from Settings in dev and fixture builds. */
export function previewStatesEnabled(): boolean {
  return (import.meta.env.DEV || dataSourceFor('account') === 'fixture')
    && new URLSearchParams(globalThis.location?.search).get('qa') === 'preview-states';
}

/** Opens settings directly on a sub-view (the example-state chip returns to its own screen, SCR-29). */
export function openSettingsAt(run: RunStore, view: SettingsStartView): void {
  pending.set(run, view);
  run.actions.openSettings();
  // If settings could not open (another overlay is up), nothing may linger for the next opening.
  if (run.getState().overlay.type !== 'settings') pending.delete(run);
}
export function peekSettingsStart(run: RunStore): SettingsStartView | undefined { return pending.get(run); }
export function clearSettingsStart(run: RunStore): void { pending.delete(run); }

/** Resolve an explicit request to visit a closing tab. The existing Navis route opens it read-only. */
export function closingStartTab(input: string): ClosingViewTab | undefined {
  const text = input.normalize('NFKC').trim();
  if (!/열(?:어|기)|보여|띄워/u.test(text)) return;
  if (/(?:정산|마감)\s*이력/u.test(text)) return 'history';
  if (/(?:^|\s)(?:현금\s*)?시재|마감\s*정산에서\s*시재/u.test(text)) return 'drawer';
  if (/(?:^|\s)(?:오늘\s*)?마감\s*(?:정산|화면|창)/u.test(text)) return 'sales';
}

/** Close the shared overlay before navigating; keep the existing dismissal boundary. */
export function openUnpaidOrders(run: RunStore): void {
  run.actions.closeOverlay('button');
  const token = run.getState().exitPendingToken;
  if (token) run.actions.finishOverlayExit(token);
  if (run.getState().layer !== 'orders-payment') run.actions.switchLayer('orders-payment');
  const state = run.getState(), preferences = selectPosPreferences(state.shopSettings);
  run.actions.setPosUi({ ...state.posUi, tab: tablesEnabled(state.shopSettings) && preferences.showTables ? 'tables' : 'order' }, state.runId);
}
