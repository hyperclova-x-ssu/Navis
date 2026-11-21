import type { ScreenPreset } from '../../contracts';
import type { FrameRect } from '../../ui';

export interface TextDetailLimits { readonly width: number; readonly minHeight: number; readonly largeTextMinHeight: number; readonly maxHeight: number }
export function textDetailFrame(preset: ScreenPreset, limits: TextDetailLimits, textScale: 100 | 125, naturalHeight: number): FrameRect {
  const minimum = textScale === 125 ? limits.largeTextMinHeight : limits.minHeight;
  const height = Math.min(limits.maxHeight, Math.max(minimum, naturalHeight));
  return { x: (preset.baselineWidth - limits.width) / 2, y: (preset.baselineHeight - height) / 2, width: limits.width, height };
}
/** The inline frame of the open dialog. Only a compact (text) detail in the windowed state carries one; large and fullscreen
 *  details return nothing, so the stylesheet frame (.ui-dialog / .ui-dialog--fullscreen) is the only thing that sizes them.
 *  Every value is a plain number: React owns the style key and removes it when the next widget has no compact frame. */
export interface DetailFrameStyle { readonly width?: number; readonly height?: number; readonly minHeight?: number; readonly maxHeight?: number }
export function detailFrameStyle(compact: boolean, fullscreen: boolean, limits: TextDetailLimits, textScale: 100 | 125, height: number): DetailFrameStyle {
  if (!compact || fullscreen) return {};
  return { width: limits.width, height, minHeight: textScale === 125 ? limits.largeTextMinHeight : limits.minHeight, maxHeight: limits.maxHeight };
}
/** A compact height measured for one widget/preset/text size; it is never reused for another (the next compact detail starts from its minimum). */
export interface MeasuredFrameHeight { readonly key: string; readonly height: number }
export function compactFrameHeight(measured: MeasuredFrameHeight | null, key: string, limits: TextDetailLimits, textScale: 100 | 125): number {
  return measured?.key === key ? measured.height : textScale === 125 ? limits.largeTextMinHeight : limits.minHeight;
}
