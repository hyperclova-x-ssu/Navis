import { managementTokens } from '../motion';
import type { SpotlightRect } from './tour';
/** Canvas padding/radius retain the DS geometry. Stroke widths are unscaled CSS px,
 * rounded to complete device pixels; both sides of every straight edge are snapped.
 * Desktop page zoom is included in devicePixelRatio, independently of the board fit.
 */
export function projectSpotlight(rect:SpotlightRect,fit:{scale:number;offsetX:number;offsetY:number},devicePixelRatio:number){
  const dpr=devicePixelRatio>0?devicePixelRatio:1,snap=(n:number)=>Math.round(n*dpr)/dpr;
  const p=managementTokens.spotlightPadding,k=fit.scale;
  const x=snap(fit.offsetX+(rect.x-p)*k),y=snap(fit.offsetY+(rect.y-p)*k);
  return {x,y,width:snap(fit.offsetX+(rect.x+rect.width+p)*k)-x,height:snap(fit.offsetY+(rect.y+rect.height+p)*k)-y,
    radius:managementTokens.spotlightRadius*k,lineWidth:Math.max(1,Math.round(managementTokens.spotlightRing*dpr))/dpr};
}
