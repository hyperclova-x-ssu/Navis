/**
 * KIOSK-FRAME — the Npay 커넥트 device the kiosk "runs inside" (a presentation prop, drawn in CSS only): a portrait tablet with a black body and a thin
 * bezel, the two Facesign lenses on the top bezel, the 800 x 1280 kiosk canvas inset as its screen, and the card-reader module attached on the
 * right with two vertical slots. All numbers are in the device's own pixels; the whole device is scaled as one piece to fit the window.
 */
export const DEVICE = (() => {
  const screenW = 800;
  const screenH = 1280;
  const bezelX = 32;
  const bezelTop = 68; // room for the two lenses
  const bezelBottom = 44;
  const bodyW = screenW + 2 * bezelX; // the tablet itself (864)
  const readerW = 230; // 21 % of the whole device width
  const height = screenH + bezelTop + bezelBottom;
  return {
    screenW, screenH, bezelX, bezelTop, bezelBottom, bodyW, readerW, height,
    width: bodyW + readerW,
    /** Outer corner radius of the tablet body: ~6 % of its width. */
    corner: 52,
    /** The screen glass has its own, smaller rounded corners. */
    screenRadius: 24,
    /** The Facesign lenses: centred on the top bezel at 38 % and 62 % of the tablet body. */
    lensX: [bodyW * 0.38, bodyW * 0.62] as const,
    lensY: bezelTop / 2,
    lensSize: 16,
    /** The reader's two vertical slots (upper, lower), each about a third of the height. */
    slotW: 14,
    slotH: Math.round(height * 0.32),
    slotCenterY: [Math.round(height * 0.25), Math.round(height * 0.75)] as const,
  };
})();

export interface DeviceLayout {
  /** Window pixels per device pixel. */
  readonly scale: number;
  /** Breathing room kept around the device (window pixels). */
  readonly margin: number;
  /** Top-left of the whole device in window pixels (centred). */
  readonly x: number;
  readonly y: number;
  /** Where the 800 x 1280 kiosk canvas lands, in window pixels. */
  readonly screen: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

/** Fit the whole device (tablet + reader) into the window and centre it; the kiosk screen is the same scale, so touch targets stay exact. */
export function deviceLayout(viewportW: number, viewportH: number): DeviceLayout {
  const measured = viewportW > 0 && viewportH > 0;
  const margin = measured ? Math.min(32, Math.max(12, Math.round(Math.min(viewportW, viewportH) * 0.03))) : 0;
  const scale = measured ? Math.min((viewportW - 2 * margin) / DEVICE.width, (viewportH - 2 * margin) / DEVICE.height) : 1;
  const x = measured ? (viewportW - DEVICE.width * scale) / 2 : 0;
  const y = measured ? (viewportH - DEVICE.height * scale) / 2 : 0;
  return {
    scale, margin, x, y,
    screen: { left: x + DEVICE.bezelX * scale, top: y + DEVICE.bezelTop * scale, width: DEVICE.screenW * scale, height: DEVICE.screenH * scale },
  };
}
