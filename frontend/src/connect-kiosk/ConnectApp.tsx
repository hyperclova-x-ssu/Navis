/**
 * KIOSK-UI — the page behind `/connect`: the kiosk alone, the hidden presenter setup (`?setup`, KIOSK-FACE's phone pairing), or
 * `/connect/split`, the presentation screen with the kiosk on the left half and Navis on the right half.
 * KIOSK-FRAME: the kiosk (and the setup page) sits inside the drawn Npay 커넥트 device, scaled to the window; the split view loads /connect, so it gets it too.
 */
import { useEffect, useState } from 'react';
import { Kiosk, KioskStage } from './Kiosk';
import { DeviceFrame } from './device-frame';
import { FacesignSetup } from './facesign';
import { connectMode, wantsSetup } from './mode';
import { kioskCategoryLocale } from './menu';
import './kiosk.css';

function KioskPage() {
  const [setup, setSetup] = useState(() => wantsSetup(window.location.search));
  useEffect(() => { document.title = 'Npay 커넥트'; }, []);
  if (setup) {
    // Close inside the same page so what the presenter allowed (the paired camera) stays in memory for the talk.
    const close = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('setup');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
      setSetup(false);
    };
    return <DeviceFrame><KioskStage screen="setup"><div className="ck-screen-host"><FacesignSetup onClose={close}/></div></KioskStage></DeviceFrame>;
  }
  return <DeviceFrame><Kiosk categoryLocale={kioskCategoryLocale(navigator.language)}/></DeviceFrame>;
}

function SplitPage() {
  useEffect(() => { document.title = 'Npay 커넥트 · Navis'; }, []);
  return <div className="ck-split">
    <iframe title="Npay 커넥트 키오스크" src="/connect"/>
    <div className="ck-split__navis"><iframe title="Navis" src="/"/></div>
  </div>;
}

export default function ConnectApp() {
  return connectMode(window.location) === 'split' ? <SplitPage/> : <KioskPage/>;
}
