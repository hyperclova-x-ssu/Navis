/** T-083 React side of the promo session: the run's session for the current store, and the first-surface catalog sync. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useWidgetDataStore } from '../../../data/react';
import { promoSession, type PromoSession, type PromoSessionState } from './promo-session';

/** The session and its current state; mounting any mkt-promo surface syncs the catalog once per run (API-20, AC-324). */
export function usePromoSession(): readonly [PromoSession, PromoSessionState] {
  const session = promoSession(useWidgetDataStore());
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => { void session.syncCatalog(); }, [session]);
  return [session, state] as const;
}

/** Only the catalog sync (for surfaces that do not read the session state, e.g. 오늘 할 홍보). */
export function usePromoCatalogSync(): void {
  const session = promoSession(useWidgetDataStore());
  useEffect(() => { void session.syncCatalog(); }, [session]);
}

/** A ticking “now” in ms for elapsed time; ticks once a second only while `on`. */
export function useNow(on: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [on, everyMs]);
  return now;
}
