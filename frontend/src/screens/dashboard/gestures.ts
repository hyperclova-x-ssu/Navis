import type {GridSpec,Panel} from '../../contracts';
import {gestureTokens,layoutTokens} from '../../ui/motion';
export interface Point {readonly x:number;readonly y:number}
export interface Rect extends Point {readonly width:number;readonly height:number}
export type DrawerDirection='pending'|'list'|'drag';
export function drawerDirection(previous:DrawerDirection,dx:number,dy:number):DrawerDirection {if(previous!=='pending'||Math.max(Math.abs(dx),Math.abs(dy))<gestureTokens.drawerStart)return previous;return dx<=-gestureTokens.drawerStart&&-dx>=gestureTokens.drawerHorizontalRatio*Math.abs(dy)?'drag':'list';}
export function panelRect(grid:Rect,span:Pick<Panel,'width'|'height'>,spec:GridSpec):Rect {const gap=layoutTokens.gridGap,cw=(grid.width-gap*(spec.columns-1))/spec.columns,ch=(grid.height-gap*(spec.rows-1))/spec.rows;return {x:grid.x,y:grid.y,width:cw*span.width+gap*(span.width-1),height:ch*span.height+gap*(span.height-1)};}
export function placementRect(grid:Rect,panel:Pick<Panel,'column'|'row'|'width'|'height'>,spec:GridSpec):Rect {const cell=panelRect(grid,{width:1,height:1},spec),size=panelRect(grid,panel,spec);return {...size,x:grid.x+panel.column*(cell.width+layoutTokens.gridGap),y:grid.y+panel.row*(cell.height+layoutTokens.gridGap)};}
export function cellTarget(point:Point,grid:Rect,spec:GridSpec,span:Pick<Panel,'width'|'height'>,grab?:Point){const cell=panelRect(grid,{width:1,height:1},spec),inside=point.x>=grid.x&&point.y>=grid.y&&point.x<grid.x+grid.width&&point.y<grid.y+grid.height;let column=Math.floor((point.x-grid.x-(grab?.x??cell.width/2))/(cell.width+layoutTokens.gridGap)+.5),row=Math.floor((point.y-grid.y-(grab?.y??cell.height/2))/(cell.height+layoutTokens.gridGap)+.5);if(!grab&&inside){column=Math.max(0,Math.min(spec.columns-1,column));row=Math.max(0,Math.min(spec.rows-1,row));}return {column,row,inside:inside&&column>=0&&row>=0&&column+span.width<=spec.columns&&row+span.height<=spec.rows};}
/** One independent axis; return hysteresis always follows the displayed cell. */
export function resizeAxis(delta:number,current:number,start:number,pitch:number):number {let value=current;while(value<4&&delta>=(value-start+.5)*pitch+gestureTokens.resizeHysteresis)value++;while(value>1&&delta<=(value-start-.5)*pitch-gestureTokens.resizeHysteresis)value--;return value;}
/** API-13: the focus key of a panel opener is the id `panel:{featureId}` (DetailOverlay and BriefingOverlay resolve it by id). */
export const panelFocusKey=(id:Panel["featureId"])=>`panel:${id}`;

/** dnd-kit starts an overlay at the source row; additions track its center instead. */
export function drawerGhostOffset(origin:Point,source:Rect,ghost:Pick<Rect,'width'|'height'>):Point {return {x:origin.x-source.x-ghost.width/2,y:origin.y-source.y-ghost.height/2};}

/**
 * Category flyout top (canvas px): aligned with the clicked rail button, never above the header line (`min`) and
 * shifted up just enough to keep its bottom `margin` inside the canvas; a taller-than-canvas flyout sits at `min`.
 */
export function clampDrawerTop({anchorTop,height,min,canvasHeight,margin}:{readonly anchorTop:number;readonly height:number;readonly min:number;readonly canvasHeight:number;readonly margin:number}):number {return Math.max(min,Math.min(anchorTop,canvasHeight-margin-height));}

export type EdgeSide = 'left'|'right';
/**
 * SCR-25 edge band in logical canvas coordinates: 48px inside the grid edge over the grid height. The left band
 * also covers the margin left of the grid; the right band continues over the feature rail (a drop there is still
 * OUTSIDE_GRID, decided by the drop point, not by the band).
 */
export function edgeAt(point:Point,grid:Rect,zone=gestureTokens.edgeZone):EdgeSide|null {
 if(point.y<grid.y||point.y>=grid.y+grid.height)return null;
 if(point.x<grid.x+zone)return 'left';
 if(point.x>=grid.x+grid.width-zone)return 'right';
 return null;
}
export const insideRect=(point:Point,rect:Rect)=>point.x>=rect.x&&point.y>=rect.y&&point.x<rect.x+rect.width&&point.y<rect.y+rect.height;
