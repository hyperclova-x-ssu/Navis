/** KIOSK-UI — the page's root: the kiosk prop for `/connect`, otherwise the Navis app (the kiosk code is only loaded when asked for). */
import { lazy, Suspense } from 'react';
import { BrowserApp } from '../app/BrowserApp';
import { connectMode } from './mode';

const ConnectApp = lazy(() => import('./ConnectApp'));

export function RootApp() {
  return connectMode(window.location) ? <Suspense fallback={null}><ConnectApp/></Suspense> : <BrowserApp/>;
}
