import {describe,expect,it} from 'vitest';
import {screenPresets} from '../../layout';
import {getPresetLayout} from '../../ui';
import {cellTarget,clampDrawerTop,drawerGhostOffset,drawerDirection,panelRect,placementRect,resizeAxis} from './gestures';
for(const preset of Object.values(screenPresets))describe(preset.id+' coordinate input',()=>{
 const grid=getPresetLayout(preset).grid,spec=preset.grid,cell=panelRect(grid,{width:1,height:1},spec),px=cell.width+16,py=cell.height+16;
 it('uses the public pitch and every cell, including the last B cell',()=>{
  for(let row=0;row<spec.rows;row++)for(let column=0;column<spec.columns;column++){
   const rect=placementRect(grid,{column,row,width:1,height:1},spec);expect(cellTarget({x:rect.x+rect.width/2,y:rect.y+rect.height/2},grid,spec,{width:1,height:1})).toMatchObject({column,row,inside:true});
  }
 });
 it('preserves grab offset, rounds half ties down/right and rejects a full rectangle outside',()=>{
  expect(cellTarget({x:grid.x+px*.5+10,y:grid.y+py*.5+20},grid,spec,{width:2,height:2},{x:10,y:20})).toMatchObject({column:1,row:1,inside:true});
  expect(cellTarget({x:grid.x+grid.width-1,y:grid.y+10},grid,spec,{width:2,height:2},{x:0,y:0}).inside).toBe(false);
  expect(cellTarget({x:grid.x-1,y:grid.y},grid,spec,{width:1,height:1}).inside).toBe(false);
 });
 it('resizes each axis through half pitch plus 12px hysteresis and keeps 1..4 bounds',()=>{
  const edge=px*.5+12;expect(resizeAxis(edge-1,2,2,px)).toBe(2);expect(resizeAxis(edge+1,2,2,px)).toBe(3);
  expect(resizeAxis(px*.5-11,3,2,px)).toBe(3);expect(resizeAxis(px*.5-13,3,2,px)).toBe(2);
  expect(resizeAxis(py*.5+13,2,2,py)).toBe(3);expect(resizeAxis(99999,1,1,px)).toBe(4);expect(resizeAxis(-99999,4,4,px)).toBe(1);
 });
});
it('locks a drawer contact to list movement unless its first threshold is left dominant',()=>{
 expect(drawerDirection('pending',-8,2)).toBe('drag');expect(drawerDirection('pending',-8,7)).toBe('list');expect(drawerDirection('list',-200,0)).toBe('list');expect(drawerDirection('pending',-7,0)).toBe('pending');
});

it('centers a new 1x1 ghost on the pointer independently of the drawer row width',()=>{
 expect(drawerGhostOffset({x:1700,y:230},{x:1452,y:200,width:326,height:72},{width:281.3333333333333,height:224})).toEqual({x:107.33333333333334,y:-82});
});

it('starts the category flyout at the clicked button and keeps it inside the canvas',()=>{
 const bounds={min:112,canvasHeight:1080,margin:24};
 expect(clampDrawerTop({...bounds,anchorTop:281,height:313})).toBe(281);
 expect(clampDrawerTop({...bounds,anchorTop:30,height:313})).toBe(112);
 expect(clampDrawerTop({...bounds,anchorTop:760,height:400})).toBe(656);
 expect(clampDrawerTop({...bounds,anchorTop:600,height:2000})).toBe(112);
 expect(clampDrawerTop({...bounds,anchorTop:600,height:0})).toBe(600);
});
