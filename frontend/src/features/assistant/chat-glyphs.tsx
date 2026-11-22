import type { SVGProps } from 'react';

/**
 * Four chat-only line icons that the app icon set does not have (CHAT-UI M-27): stop, arrow-down,
 * open (arrow up-right) and the launcher's bubble with a small spark. 24-grid, 2 px stroke, round caps,
 * drawn here — no external asset. Decorative: the button always carries its own visible text or `aria-label`.
 */
const paths = {
  stop: 'M7 7h10v10H7Z',
  'arrow-down': 'M12 4v15M6 13l6 6 6-6',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  spark: 'M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7l-5 4v-4H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3ZM12 7.5l1.2 2.3 2.3 1.2-2.3 1.2L12 14.5l-1.2-2.3-2.3-1.2 2.3-1.2Z',
} as const;

export type ChatGlyphName = keyof typeof paths;

export function ChatGlyph({ name, className = '', ...props }: Omit<SVGProps<SVGSVGElement>, 'name'> & { readonly name: ChatGlyphName }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
    strokeLinejoin="round" className={`ui-icon ai-glyph ${className}`} aria-hidden="true" focusable="false" {...props}><path d={paths[name]} /></svg>;
}
