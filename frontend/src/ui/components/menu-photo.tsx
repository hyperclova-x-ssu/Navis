import type { PosMenuPhotoDataUrl, PosMenuPhotoKey } from '../../contracts/pos';
import './menu-photo.css';

/** R4 DESIGN_SYSTEM 15.12 A. Inline line art, no network or image files. */
export const menuPhotos: readonly { key: PosMenuPhotoKey; name: string; surface: string; ink: string; path: string }[] = [
  { key: 'menu-photo-01', name: '뜨거운 컵 그림', surface: 'warning-bg', ink: 'warning', path: 'M14 29h31v14a12 12 0 0 1-12 12h-7a12 12 0 0 1-12-12V29ZM45 32h4a7 7 0 0 1 0 14h-5M21 21c-6-5 6-8 0-14M31 21c-6-5 6-8 0-14M41 21c-6-5 6-8 0-14' },
  { key: 'menu-photo-02', name: '차가운 컵 그림', surface: 'selection', ink: 'selection-foreground', path: 'M18 25h28l-4 33H22l-4-33ZM16 20h32v5H16v-5ZM35 20l5-15h9M25 32h7v7h-7zM34 43h7v7h-7z' },
  { key: 'menu-photo-03', name: '라테 잔 그림', surface: 'secondary', ink: 'success', path: 'M12 26h36v12a15 15 0 0 1-15 15h-6a15 15 0 0 1-15-15V26ZM48 28h4a6 6 0 0 1 0 12h-4M6 55h50M30 23C14 15 21 5 30 13 39 5 46 15 30 23Z' },
  { key: 'menu-photo-04', name: '크루아상 그림', surface: 'warning-bg', ink: 'warning', path: 'M7 44C9 17 55 17 57 44l-13 4c-4-14-20-14-24 0L7 44ZM20 25l5 13M32 21v14M44 25l-5 13' },
  { key: 'menu-photo-05', name: '휘낭시에 그림', surface: 'secondary', ink: 'foreground', path: 'M12 19h40a5 5 0 0 1 5 5v22a5 5 0 0 1-5 5H12a5 5 0 0 1-5-5V24a5 5 0 0 1 5-5ZM17 29h30M8 42h48' },
  { key: 'menu-photo-06', name: '원두 봉투 그림', surface: 'secondary', ink: 'foreground', path: 'M19 9h26l-3 9 7 36a3 3 0 0 1-3 4H18a3 3 0 0 1-3-4l7-36-3-9ZM22 18h20M38 31c6 5-1 17-8 13s-1-18 8-13ZM37 32l-6 10' },
  { key: 'menu-photo-07', name: '드립백 그림', surface: 'secondary', ink: 'success', path: 'M21 29h22v24H21V29ZM21 32H11v12h10M43 32h10v12H43M32 5c-2 5-7 8-7 13a7 7 0 0 0 14 0c0-5-5-8-7-13Z' },
  { key: 'menu-photo-08', name: '빈 접시 그림', surface: 'selection', ink: 'selection-foreground', path: 'M5 32a27 17 0 1 0 54 0 27 17 0 1 0-54 0ZM15 32a17 10 0 1 0 34 0 17 10 0 1 0-34 0Z' },
];

export interface MenuPhotoProps {
  photoKey: PosMenuPhotoKey | null;
  customPhotoUrl?: PosMenuPhotoDataUrl | null;
  name: string;
  size?: 'card' | 'preview' | 'picker' | 'thumbnail';
}

export function MenuPhoto({ photoKey, customPhotoUrl, name, size = 'preview' }: MenuPhotoProps) {
  const photo = menuPhotos.find(p => p.key === photoKey);
  const className = `ui-menu-photo${size === 'preview' || size === 'picker' ? ' menu-pos-photo' : ''}`;
  if (!photo && customPhotoUrl) return <span aria-hidden="true" className={className} data-size={size}>
    <img src={customPhotoUrl} alt="" decoding="async" />
  </span>;
  return <span aria-hidden="true" className={className} data-size={size} style={{ background: `var(--${photo?.surface ?? 'secondary'})`, color: `var(--${photo?.ink ?? 'muted-foreground'})` }}>
    {photo ? <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d={photo.path}/></svg> : [...name][0] ?? ''}
  </span>;
}

