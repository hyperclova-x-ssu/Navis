import { describe, expect, it } from 'vitest';
import { getCatalog } from '../catalog';
import { evaluate, preview, screenPresets } from './index';
import type { Panel } from '../contracts';

const panel=(featureId:Panel['featureId'],column:number,row:number,width=1,height=1):Panel=>({featureId,column,row,width,height});
describe.each(['A','B'] as const)('%s explicit coordinates',presetId=>{
  const grid=screenPresets[presetId].grid,catalog=getCatalog(presetId);
  it('validates and preserves a gap rather than packing to the top left',()=>{
    const before=[panel('ledger',3,2)];
    expect(evaluate(before,grid,catalog)).toMatchObject({valid:true,panels:before,usedCells:1});
    expect(preview(before,{type:'add-tap',featureId:'calendar'},grid,catalog).panels).toContainEqual(panel('calendar',0,0));
  });
  it('keeps the requested cell and pushes the neighbour to the nearest empty rectangle',()=>{
    const before=[panel('ledger',1,1),panel('calendar',5,3)];
    const result=preview(before,{type:'add-drop',featureId:'margin',column:1,row:1},grid,catalog);
    expect(result).toMatchObject({status:'accepted',displacements:[{featureId:'ledger',from:{column:1,row:1},to:{column:1,row:0},causeFeatureId:'margin'}]});
    expect(result.panels).toContainEqual(panel('calendar',5,3));
    expect(result.panels).toContainEqual(panel('margin',1,1));
    expect(before[0]).toEqual(panel('ledger',1,1));
  });
  it('supports all 16 sizes for every feature without implicit preset or size policy',()=>{
    for(const feature of catalog)for(let width=1;width<=4;width++)for(let height=1;height<=4;height++){
      const result=preview([panel(feature.id,0,0)],{type:'resize',featureId:feature.id,width,height},grid,catalog);
      expect(result.valid).toBe(true);expect(result.panels).toEqual([panel(feature.id,0,0,width,height)]);
    }
  });
  it('can add or move every feature to every cell, including each high bit on B',()=>{
    for(const feature of catalog)for(let row=0;row<grid.rows;row++)for(let column=0;column<grid.columns;column++){
      const expected=panel(feature.id,column,row);
      expect(preview([],{type:'add-drop',featureId:feature.id,column,row},grid,catalog).panels).toEqual([expected]);
      expect(preview([panel(feature.id,0,0)],{type:'move',featureId:feature.id,column,row},grid,catalog).panels).toEqual([expected]);
    }
  });
  it('does not silently move an out of bounds request inwards',()=>{
    const before=[panel('ledger',0,0,2,2)];
    expect(preview(before,{type:'move',featureId:'ledger',column:grid.columns-1,row:0},grid,catalog)).toMatchObject({code:'OUTSIDE_GRID',panels:before});
  });
  it('remove and shrink preserve unrelated coordinates and starter uses three adjacent single cells',()=>{
    const before=[panel('ledger',1,1,2,2),panel('calendar',5,3)];
    expect(preview(before,{type:'remove',featureId:'ledger'},grid,catalog).panels).toEqual([before[1]]);
    expect(preview(before,{type:'resize',featureId:'ledger',width:1,height:1},grid,catalog).panels).toEqual([panel('ledger',1,1),before[1]]);
    expect(preview([],{type:'starter',featureIds:['ledger','margin','calendar']},grid,catalog).panels).toEqual([panel('ledger',0,0),panel('margin',1,0),panel('calendar',2,0)]);
  });
});
it('proves the legal B 25-to-40-cell geometric counterexample impossible and restores the snapshot',()=>{
  const before=[panel('ledger',0,0,4,4),panel('margin',4,0),panel('calendar',5,0,1,4),panel('members',6,0,1,4)];
  expect(evaluate(before,screenPresets.B.grid,getCatalog('B')).usedCells).toBe(25);
  expect(preview(before,{type:'resize',featureId:'margin',width:4,height:4},screenPresets.B.grid,getCatalog('B'))).toMatchObject({status:'rejected',code:'NO_CAPACITY',panels:before});
});
