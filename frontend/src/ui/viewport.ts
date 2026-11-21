import type { ScreenPreset, ViewportSnapshot, ViewportTransform } from '../contracts';
import { layoutTokens } from './motion';

export interface CanvasPoint { readonly x:number; readonly y:number }
export interface CanvasRect extends CanvasPoint { readonly width:number; readonly height:number; readonly left:number; readonly top:number; readonly right:number; readonly bottom:number }
export interface AvailableViewport extends ViewportSnapshot { readonly originX?:number; readonly originY?:number }

/** offsetX/Y are absolute client offsets, including the visualViewport origin. */
export function fitViewport(preset:ScreenPreset,viewport:AvailableViewport,previous:ViewportTransform|null=null):ViewportTransform|null {
  const {width,height,originX=0,originY=0}=viewport;
  if(![width,height,originX,originY].every(Number.isFinite)||width<=0||height<=0)return previous;
  const scale=Math.min(width/preset.baselineWidth,height/preset.baselineHeight);
  return Object.freeze({scale,offsetX:originX+(width-scale*preset.baselineWidth)/2,offsetY:originY+(height-scale*preset.baselineHeight)/2,width,height,originX,originY});
}
export function toCanvasPoint(point:CanvasPoint,transform:ViewportTransform):CanvasPoint {
  return {x:(point.x-transform.offsetX)/transform.scale,y:(point.y-transform.offsetY)/transform.scale};
}
export function toCanvasDelta(delta:CanvasPoint,transform:ViewportTransform):CanvasPoint {
  return {x:delta.x/transform.scale,y:delta.y/transform.scale};
}
export function toCanvasRect(rect:CanvasPoint&{readonly width:number;readonly height:number},transform:ViewportTransform):CanvasRect {
  const {x,y}=toCanvasPoint(rect,transform);const {x:width,y:height}=toCanvasDelta({x:rect.width,y:rect.height},transform);
  return {x,y,left:x,top:y,width,height,right:x+width,bottom:y+height};
}
const rect=(x:number,y:number,width:number,height:number)=>Object.freeze({x,y,width,height});
/** R4 DESIGN_SYSTEM 4.2 pixels; cell spans are read from the supplied core preset. */
export function getPresetLayout(preset:ScreenPreset){
  const b=preset.id==='B';const {margin,header,headerGap,railWidth,railGap,gridGap,drawerRailGap,pageBar,pageBarGap}=layoutTokens;
  const grid=rect(margin,margin+header+headerGap,preset.baselineWidth-margin*2-railWidth-railGap,preset.baselineHeight-margin*2-header-headerGap-pageBar-pageBarGap);
  const inset=b?96:64;const drawerWidth=b?400:360;
  return Object.freeze({
    grid,header:rect(margin,margin,grid.width,header),
    /** DS 11.1: below the grid, 16px gap, horizontally centred on the grid (A x908 / B x1228). */
    pageBar:Object.freeze({y:grid.y+grid.height+pageBarGap,height:pageBar,centerX:grid.x+grid.width/2}),
    rail:rect(preset.baselineWidth-margin-railWidth,margin,railWidth,preset.baselineHeight-margin*2),
    drawer:rect(preset.baselineWidth-margin-railWidth-drawerRailGap-drawerWidth,grid.y,drawerWidth,b?760:640),
    detail:rect(inset,inset,preset.baselineWidth-inset*2,preset.baselineHeight-inset*2),detailInset:inset,
    // D-326 Q15: the text detail window grows with its content from 560 (640 large text) to the detail frame height, and never past 90% of the screen height.
    textDetail:Object.freeze({width:b?1040:960,minHeight:560,largeTextMinHeight:640,maxHeight:Math.min(preset.baselineHeight-inset*2,Math.floor(preset.baselineHeight*0.9))}),
    cell:Object.freeze({width:(grid.width-gridGap*(preset.grid.columns-1))/preset.grid.columns,height:(grid.height-gridGap*(preset.grid.rows-1))/preset.grid.rows}),
    briefing:Object.freeze({width:b?800:720,height:b?600:560,maxHeight:b?1080:880}),
    settings:Object.freeze({width:720,height:640,businessHeight:480,businessLargeTextHeight:560}),
    question:Object.freeze({width:976,height:560}),
    coach:Object.freeze({width:400,maxHeight:280}),
  });
}
export type PresetLayout=ReturnType<typeof getPresetLayout>;
