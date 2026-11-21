import { describe, expect, it } from 'vitest';
import { screenPresets } from '../layout/presets';
import { fitViewport, toCanvasPoint, toCanvasRect, toCanvasDelta, getPresetLayout } from './viewport';

describe('D-12 canvas geometry',()=>{
  it.each(['A','B'] as const)('%s keeps exact baseline geometry and identity transform',id=>{
    const preset=screenPresets[id];
    expect(fitViewport(preset,{width:preset.baselineWidth,height:preset.baselineHeight})).toEqual({scale:1,offsetX:0,offsetY:0,width:preset.baselineWidth,height:preset.baselineHeight,originX:0,originY:0});
    const layout=getPresetLayout(preset);
    expect(layout.grid).toEqual({x:24,y:112,width:id==='A'?1768:2408,height:id==='A'?880:1240});
    expect(layout.cell).toEqual(id==='A'?{width:281.3333333333333,height:208}:{width:287,height:235.2});
    expect(layout.pageBar).toEqual({y:id==='A'?1008:1368,height:48,centerX:id==='A'?908:1228});
    expect(layout.pageBar.y+layout.pageBar.height+24).toBe(preset.baselineHeight);
    expect(layout.drawer).toEqual({x:id==='A'?1436:2036,y:112,width:id==='A'?360:400,height:id==='A'?640:760});
    expect(layout.detail).toEqual({x:id==='A'?64:96,y:id==='A'?64:96,width:id==='A'?1792:2368,height:id==='A'?952:1248});
    expect(layout.textDetail).toEqual({width:id==='A'?960:1040,minHeight:560,largeTextMinHeight:640,maxHeight:id==='A'?952:1248});
    expect(layout.briefing).toMatchObject({width:id==='A'?720:800,height:id==='A'?560:600,maxHeight:id==='A'?880:1080});
    expect(layout.settings).toEqual({width:720,height:640,businessHeight:480,businessLargeTextHeight:560});
    expect(Object.isFrozen(layout.grid)).toBe(true);
  });
  it('D-326 Q15: the text detail window is never taller than the existing maximum or 90% of the screen height',()=>{
    for(const id of ['A','B'] as const){const preset=screenPresets[id];const {textDetail,detail}=getPresetLayout(preset);expect(textDetail.maxHeight).toBeLessThanOrEqual(detail.height);expect(textDetail.maxHeight).toBeLessThanOrEqual(Math.floor(preset.baselineHeight*0.9));}
    // A tall canvas where the 64 inset leaves more than 90%: the 90% limit is the one that binds.
    const tall={...screenPresets.A,baselineHeight:2000};
    expect(getPresetLayout(tall).detail.height).toBe(1872);
    expect(getPresetLayout(tall).textDetail.maxHeight).toBe(1800);
    expect(getPresetLayout(tall).textDetail.minHeight).toBe(560);
    expect(getPresetLayout(tall).textDetail.largeTextMinHeight).toBe(640);
  });
  it('centers in spare bands, permits enlargement, and includes available-area origins once',()=>{
    expect(fitViewport(screenPresets.A,{width:2400,height:1080})).toMatchObject({scale:1,offsetX:240,offsetY:0});
    expect(fitViewport(screenPresets.A,{width:3840,height:2160})).toMatchObject({scale:2,offsetX:0,offsetY:0});
    expect(fitViewport(screenPresets.B,{width:1280,height:720,originX:10,originY:60})).toMatchObject({scale:.5,offsetX:10,offsetY:60});
  });
  it('preserves the previous valid transform at zero sizes, without inventing a first transform',()=>{
    const previous=fitViewport(screenPresets.B,{width:2560,height:1260})!;
    for(const viewport of [{width:0,height:1000},{width:1000,height:0},{width:NaN,height:10},{width:10,height:Infinity}])expect(fitViewport(screenPresets.B,viewport,previous)).toBe(previous);
    expect(fitViewport(screenPresets.A,{width:0,height:0})).toBeNull();
  });
  it('converts client points/DOMRect and dnd deltas to logical units exactly once',()=>{
    const transform=fitViewport(screenPresets.B,{width:1280,height:720,originX:10,originY:60})!;
    expect(toCanvasPoint({x:22,y:116},transform)).toEqual({x:24,y:112});
    expect(toCanvasRect({x:22,y:116,width:295,height:124},transform)).toEqual({x:24,y:112,left:24,top:112,width:590,height:248,right:614,bottom:360});
    expect(toCanvasDelta({x:4,y:32},transform)).toEqual({x:8,y:64});
    expect(toCanvasPoint({x:0,y:0},transform).x).toBeLessThan(0);
  });
});
