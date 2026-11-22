/**
 * KIOSK-FRAME — wraps the kiosk page in the Npay 커넥트 device so it looks like it runs inside the real hardware and the presenter taps the screen
 * inside it. Two layers, so the kiosk itself needs no change: (1) the device drawn in its own pixels and scaled as one piece — decoration only,
 * aria-hidden, never takes the pointer; (2) the screen slot, placed in window pixels exactly over the device's glass at the same scale, which
 * hosts the kiosk. The kiosk's own fit then measures that slot and scales its 800 x 1280 canvas to exactly 1:1 with the device screen, so a tap lands
 * where it is drawn at any window size.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { DEVICE, deviceLayout } from './device-geometry';
import './device-frame.css';

function useViewport(root: RefObject<HTMLDivElement | null>): { readonly w: number; readonly h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => {
      const r = node.getBoundingClientRect();
      setSize(prev => (prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver !== 'function') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure); }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  return size;
}

const at = (left: number, top: number, width: number, height: number): CSSProperties => ({ left, top, width, height });

/** The device: tablet body + bezel + glass ring + two lenses, and the reader module with its two slots. */
function DeviceChrome({ x, y, scale }: { readonly x: number; readonly y: number; readonly scale: number }) {
  const { bodyW, readerW, width, height, bezelX, bezelTop, screenW, screenH, lensSize, lensY, lensX, slotW, slotH, slotCenterY } = DEVICE;
  return <div
    className="ck-device" aria-hidden="true"
    style={{ width, height, borderRadius: `${DEVICE.corner}px ${DEVICE.corner * 0.7}px ${DEVICE.corner * 0.7}px ${DEVICE.corner}px`, transform: `translate(${x}px, ${y}px) scale(${scale})` }}
  >
    <div className="ck-device__body" style={at(0, 0, bodyW, height)}>
      <i className="ck-device__glass" style={{ ...at(bezelX - 3, bezelTop - 3, screenW + 6, screenH + 6), borderRadius: DEVICE.screenRadius + 3 }}/>
      {lensX.map(cx => <i key={cx} data-part="lens" style={at(cx - lensSize / 2, lensY - lensSize / 2, lensSize, lensSize)}/>)}
    </div>
    <div data-part="reader" className="ck-device__reader" style={at(bodyW, 0, readerW, height)}>
      {slotCenterY.map(cy => <i key={cy} data-part="slot" style={at((readerW - slotW) / 2, cy - slotH / 2, slotW, slotH)}/>)}
    </div>
    <i className="ck-device__seam" style={{ left: bodyW - 1, height }}/>
  </div>;
}

export function DeviceFrame({ children }: { readonly children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const { w, h } = useViewport(root);
  const layout = deviceLayout(w, h);
  const { screen } = layout;
  return <div ref={root} className="ck-device-stage">
    <DeviceChrome x={layout.x} y={layout.y} scale={layout.scale}/>
    <div
      className="ck-device__screen" lang="ko"
      style={{ left: screen.left, top: screen.top, width: screen.width, height: screen.height, borderRadius: DEVICE.screenRadius * layout.scale }}
    >{children}</div>
  </div>;
}
