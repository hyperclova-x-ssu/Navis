/**
 * KIOSK-UI — the kiosk's marks and icons, redrawn as small vector shapes and text (no reference image is embedded):
 * `pay connect` / `N pay` as text-style marks, the two order-method pictograms, the payment-screen glyphs, the review icons.
 */
import type { CSSProperties, ReactNode } from 'react';

interface SvgProps { readonly size?: number; readonly className?: string; readonly style?: CSSProperties; readonly title?: string }
const svg = (props: SvgProps, viewBox: string, children: ReactNode, w?: number, h?: number) => (
  <svg className={props.className} style={props.style} viewBox={viewBox} width={w ?? props.size} height={h ?? props.size} role={props.title ? 'img' : undefined} aria-label={props.title} aria-hidden={props.title ? undefined : true} focusable="false">{children}</svg>
);

export const IconChevronLeft = (p: SvgProps) => svg(p, '0 0 24 24', <path d="M15 4.5 7.5 12 15 19.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>);
export const IconChevronRight = (p: SvgProps) => svg(p, '0 0 24 24', <path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>);
export const IconChevronDown = (p: SvgProps) => svg(p, '0 0 24 24', <path d="m5 9 7 7 7-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/>);
export const IconRefresh = (p: SvgProps) => svg(p, '0 0 24 24', <><path d="M20 12a8 8 0 1 1-2.6-5.9" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/><path d="M20.4 3.6v5h-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></>);
export const IconClose = (p: SvgProps) => svg(p, '0 0 24 24', <path d="m6.5 6.5 11 11m0-11-11 11" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"/>);
export const IconMinus = (p: SvgProps) => svg(p, '0 0 24 24', <path d="M5.5 12h13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/>);
export const IconPlus = (p: SvgProps) => svg(p, '0 0 24 24', <path d="M5.5 12h13M12 5.5v13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/>);
export const IconCheck = (p: SvgProps) => svg(p, '0 0 24 24', <path d="m5.5 12.8 4.4 4.4 8.6-9.4" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"/>);
export const IconBackspace = (p: SvgProps) => svg(p, '0 0 32 24', <><path d="M10 3h17a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H10L2.5 12 10 3Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"/><path d="m14.5 8.5 7 7m0-7-7 7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></>);
export const IconCup = (p: SvgProps) => svg(p, '0 0 48 48', <><path d="M10 17h24v10a10 10 0 0 1-10 10h-4a10 10 0 0 1-10-10V17Z" fill="currentColor"/><path d="M34 20h3a4 4 0 0 1 0 8h-3" fill="none" stroke="currentColor" strokeWidth="3"/><path d="M17 5c-2 2 2 4 0 7m7-7c-2 2 2 4 0 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"/></>);

/** The grey `N pay` mark at the foot of every screen. */
export function NpayFoot({ className }: { readonly className?: string }) {
  return <div className={`ck-npay-foot ${className ?? ''}`} aria-hidden="true"><span className="ck-npay-dot">N</span><span>pay</span></div>;
}
/** The green `N pay` pill on the payment tiles. */
export function NpayPill() {
  return <span className="ck-npay-pill" aria-hidden="true"><span className="ck-npay-pill__dot">N</span><span>pay</span></span>;
}
/** `pay connect`: a green disc holding "pay" and the word "connect". */
export function PayConnectLogo() {
  return <div className="ck-logo" role="img" aria-label="pay connect"><span className="ck-logo__disc" aria-hidden="true">pay</span><span aria-hidden="true">connect</span></div>;
}
/** Inline `N pay` word-mark used inside a sentence on the attract screen. */
export function NpayInline() {
  return <span className="ck-npay-inline" aria-label="Npay"><span className="ck-npay-inline__dot" aria-hidden="true">N</span><span aria-hidden="true">pay</span></span>;
}

export const ForkSpoon = (p: SvgProps) => svg(p, '0 0 64 64', <>
  <rect x="14" y="6" width="12" height="26" rx="6" fill="#dfe8f2"/><rect x="14" y="22" width="12" height="36" rx="5" fill="#3f6fe0"/>
  <rect x="38" y="6" width="3" height="16" rx="1.5" fill="#dfe8f2"/><rect x="43.5" y="6" width="3" height="16" rx="1.5" fill="#dfe8f2"/><rect x="49" y="6" width="3" height="16" rx="1.5" fill="#dfe8f2"/>
  <path d="M37 20h16v6a8 8 0 0 1-16 0v-6Z" fill="#dfe8f2"/><rect x="40" y="26" width="10" height="32" rx="5" fill="#3f6fe0"/>
</>);
export const PaperBag = (p: SvgProps) => svg(p, '0 0 64 64', <>
  <path d="M22 22v-4a10 10 0 0 1 20 0v4" fill="none" stroke="#a3601f" strokeWidth="4" strokeLinecap="round"/>
  <path d="M10 22h44l-2.5 34a3 3 0 0 1-3 2.8H15.5a3 3 0 0 1-3-2.8L10 22Z" fill="#e8963a"/>
  <rect x="24" y="30" width="16" height="14" rx="2" fill="#f7d9a6"/><path d="M27 35h10M27 39h7" stroke="#b9843b" strokeWidth="1.8" strokeLinecap="round"/>
</>);

/** `NO QR`-style glyph of the 간편 결제 tile. */
export const NoQrGlyph = (p: SvgProps) => svg(p, '0 0 48 48', <>
  <path d="M5 5h6l6 11V5h6v18h-6L11 12v11H5V5Z" fill="currentColor"/><rect x="27" y="5" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="4.5"/>
  <rect x="5" y="27" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth="4.5"/><rect x="27" y="27" width="6" height="6" fill="currentColor"/><rect x="37" y="27" width="6" height="6" fill="currentColor"/><rect x="27" y="37" width="6" height="6" fill="currentColor"/><rect x="37" y="37" width="6" height="6" fill="currentColor"/>
</>);
/** The contactless-hand outline at the head of the tap zone. */
export const ContactlessHand = (p: SvgProps) => svg(p, '0 0 96 60', <>
  <ellipse cx="34" cy="30" rx="27" ry="21" fill="none" stroke="currentColor" strokeWidth="2.6"/>
  <path d="M22 20c4 6 4 14 0 20M29 16c6 8 6 20 0 28M36 12c8 10 8 26 0 36" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"/>
  <path d="M58 30V13a3.2 3.2 0 0 1 6.4 0v16l8.4 2.4a5 5 0 0 1 3.6 4.8V46c0 6-4.8 10-10.8 10H64l-8.6-10.6a3.6 3.6 0 0 1 5.4-4.6l3.6 3.2" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/>
</>);
export const ApplePayMark = (p: SvgProps) => svg(p, '0 0 24 24', <path fill="currentColor" d="M17 12.1c0-2.6 2.1-3.9 2.2-4-1.2-1.8-3.1-2-3.8-2.1-1.6-.2-3.1.9-3.9.9s-2-.9-3.4-.9c-1.7 0-3.4 1-4.3 2.6-1.8 3.2-.5 7.9 1.3 10.5.9 1.3 1.9 2.7 3.3 2.6 1.300 0 1.800-.8 3.400-.8 1.600 0 2 .8 3.400.8 1.400 0 2.300-1.300 3.200-2.600 1-1.500 1.400-2.900 1.400-3-.1 0-2.800-1-2.800-4Zm-2.600-7.800c.7-.9 1.200-2.100 1.100-3.300-1 0-2.300.7-3 1.600-.7.800-1.300 2-1.100 3.200 1.100.1 2.300-.6 3-1.500Z"/>);
export const FaceBracket = ({ eye = '#00de5a', ...p }: SvgProps & { readonly eye?: string }) => svg(p, '0 0 64 64', <>
  <path d="M6 20V12a6 6 0 0 1 6-6h8M44 6h8a6 6 0 0 1 6 6v8M58 44v8a6 6 0 0 1-6 6h-8M20 58h-8a6 6 0 0 1-6-6v-8" fill="none" stroke="currentColor" strokeWidth="4.4" strokeLinecap="round"/>
  <circle cx="22.500" cy="26" r="3.400" fill={eye}/><path d="M39.500 22.600h7M43 22.600v7" fill="none" stroke={eye} strokeWidth="4.400" strokeLinecap="round"/>
  <path d="M21 38c3 6.500 8 9.500 14 9.500s11-3 14-9.500" fill="none" stroke="#fff" strokeWidth="4.400" strokeLinecap="round" transform="translate(-3 -2.500)"/>
</>);
export const FaceTileIcon = (p: SvgProps) => svg(p, '0 0 64 64', <>
  <rect width="64" height="64" rx="14" fill="#00de5a"/>
  <path d="M14 22v-5a3 3 0 0 1 3-3h5M42 14h5a3 3 0 0 1 3 3v5M50 42v5a3 3 0 0 1-3 3h-5M22 50h-5a3 3 0 0 1-3-3v-5" fill="none" stroke="#fff" strokeWidth="3.600" strokeLinecap="round"/>
  <circle cx="25" cy="28" r="2.800" fill="#fff"/><circle cx="39" cy="28" r="2.800" fill="#fff"/><path d="M24 38.500c2.500 3.500 5 4.800 8 4.800s5.500-1.300 8-4.800" fill="none" stroke="#fff" strokeWidth="3.600" strokeLinecap="round"/>
</>);
export const SamsungTileIcon = (p: SvgProps) => svg(p, '0 0 56 72', <>
  <rect width="56" height="72" rx="6" fill="#2a4fc4"/><text x="28" y="20" textAnchor="middle" fontSize="7.600" fontWeight="800" fill="#fff" fontFamily="sans-serif" letterSpacing=".4">SAMSUNG</text>
  <text x="14" y="30" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff" fontFamily="sans-serif">Pay</text>
  <path d="M38 36c4 5 4 12 0 17M44 33c6 8 6 18 0 26M32 39c2.500 3 2.500 8 0 11" fill="none" stroke="#fff" strokeWidth="2.600" strokeLinecap="round" transform="translate(0 4)"/>
</>);
export const CardArt = (p: SvgProps) => svg(p, '0 0 300 190', <>
  <defs><linearGradient id="ck-card-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#b9b9bc"/><stop offset=".55" stopColor="#9c9ca0"/><stop offset="1" stopColor="#8a8a8e"/></linearGradient></defs>
  <path d="M14 2h272a12 12 0 0 1 12 12v162a12 12 0 0 1-12 12H14a12 12 0 0 1-12-12v-52a12 12 0 0 0 0-24V14A12 12 0 0 1 14 2Z" fill="url(#ck-card-g)"/>
  <rect x="196" y="62" width="44" height="34" rx="7" fill="#f1f1f1"/><path d="M196 79h44M214 62v34M222 62v34" stroke="#bdbdbd" strokeWidth="2"/>
  <path d="M252 70c4 5 4 13 0 18M259 66c6 9 6 21 0 30M266 62c8 13 8 29 0 42" fill="none" stroke="#5f5f63" strokeWidth="3" strokeLinecap="round"/>
  <text x="26" y="160" fontSize="20" fill="#4f4f53" fontFamily="sans-serif" letterSpacing="2">****1234</text>
</>);
export const NCoin = (p: SvgProps) => svg(p, '0 0 32 32', <><circle cx="16" cy="16" r="15" fill="#00de5a"/><path d="M10.500 22V10h2.700l5.700 8.200V10h2.600v12h-2.700L13.100 13.800V22h-2.600Z" fill="#000"/></>);
export const TapHandIcon = (p: SvgProps) => svg(p, '0 0 48 48', <>
  <circle cx="17" cy="17" r="11" fill="none" stroke="#00de5a" strokeWidth="4.200"/>
  <path d="M23 19.500v-3a3 3 0 0 1 6 0v8l5 1.500a4 4 0 0 1 3 3.800V37c0 5-3.500 8.500-8.500 8.500h-3L20 37.500a3 3 0 0 1 4.500-3.800l1.500 1.300" fill="#fff" stroke="#fff" strokeWidth="1.600" strokeLinejoin="round"/>
</>);
export const PhoneN = (p: SvgProps) => svg(p, '0 0 40 56', <><rect x="2" y="2" width="36" height="52" rx="8" fill="#00de5a"/><path d="M12 38V18h4.200l8.800 12.800V18h4v20h-4.200L16 25.200V38h-4Z" fill="#fff"/></>);
export const BellIcon = (p: SvgProps) => svg(p, '0 0 48 48', <><path d="M24 6c-7 0-11 5-11 12 0 8-4 9-4 12h30c0-3-4-4-4-12 0-7-4-12-11-12Z" fill="#ffc933"/><circle cx="24" cy="38" r="4.200" fill="#f4a31b"/></>);

/** The camera-scan screen's four green corner brackets (a rounded square viewport). */
export function ScanBrackets() {
  return <div className="ck-scan__brackets" aria-hidden="true"><i/><i/><i/><i/></div>;
}
