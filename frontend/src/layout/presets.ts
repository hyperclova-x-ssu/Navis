import type { GridSpec, ScreenPreset, ScreenPresetId, ViewportSnapshot } from '../contracts';

function preset(id:ScreenPresetId, baselineWidth:number, baselineHeight:number, columns:number, rows:number):ScreenPreset {
  const grid:GridSpec=Object.freeze({columns,rows});
  return Object.freeze({id,baselineWidth,baselineHeight,grid});
}

/** R4 DESIGN_SYSTEM 4.1–4.2. Pixel layout tokens remain in src/ui. */
export const screenPresets:Readonly<Record<ScreenPresetId,ScreenPreset>>=Object.freeze({
  A:preset('A',1920,1080,6,4),
  B:preset('B',2560,1440,8,5),
});

/** null means the shell must wait for the first finite, positive CSS viewport. */
export function selectScreenPreset({width,height}:ViewportSnapshot):ScreenPreset|null {
  if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)return null;
  return screenPresets[width>=2400&&height>=1200?'B':'A'];
}
