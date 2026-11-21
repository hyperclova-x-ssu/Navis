/** T-074: the server QR is an SVG string; it is only ever shown as `<img src="data:…">` (API-15, never innerHTML). */
export function svgDataUrl(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** Phone opened the page but no video yet for this long → add the "allow the camera" hint (SCREENS 9.4). */
export const ALLOW_HINT_MS = 15000;
/** "Camera connected" check mark stays this long before the next step (SCREENS 9.5). */
export const VERIFY_MS = 1200;
