/** KIOSK-UI — which page of the kiosk the address asks for. Kept apart from the kiosk code so the main bundle only pays for this check. */
export type ConnectMode = 'kiosk' | 'split';

export function connectMode(location: { readonly pathname: string; readonly search: string }): ConnectMode | null {
  const path = location.pathname.replace(/\/+$/, '');
  const params = new URLSearchParams(location.search);
  if (path === '/connect/split' || params.get('connect') === 'split') return 'split';
  if (path === '/connect' || params.has('connect')) return 'kiosk';
  return null;
}
/** The hidden presenter entry (`?setup`) that pairs the phone camera for 페이스사인. */
export const wantsSetup = (search: string): boolean => new URLSearchParams(search).has('setup');
