import { describe,expect,it } from 'vitest';
import type { Panel,GridSpec } from '../contracts';
import { getCatalog } from '../catalog';
import { evaluate,preview,readingOrder,commit } from './index';
const catalog=getCatalog('A');
const p=(featureId:Panel['featureId'],column:number,row:number,width=1,height=1):Panel=>({featureId,column,row,width,height});
describe('ordered exact push-aside',()=>{
  it('tries completely empty rectangles before nearer occupied anchors',()=>{
    const before=[p('ledger',1,1),p('tax',1,0),p('calendar',0,1),p('margin',2,1),p('menu',1,2)];
    const result=preview(before,{type:'add-drop',featureId:'grants',column:1,row:1},{columns:6,rows:4},catalog);
    expect(result.panels.find(p=>p.featureId==='ledger')).toEqual(p('ledger',0,0));
    expect(result.displacements.map(d=>d.featureId)).toEqual(['ledger']);
  });
  it('uses a vacated move source and chains only stationary neighbours, without moving fixed panels again',()=>{
    const before=[p('ledger',0,0,1,2),p('tax',1,0),p('calendar',2,0),p('margin',1,1,2,1)];
    const result=preview(before,{type:'move',featureId:'margin',column:0,row:0},{columns:3,rows:2},catalog);
    expect(result.panels).toEqual([p('ledger',2,0,1,2),p('tax',1,1),p('calendar',0,1),p('margin',0,0,2,1)]);
    expect(result.displacements).toContainEqual({featureId:'calendar',from:{column:2,row:0},to:{column:0,row:1},causeFeatureId:'ledger'});
    expect(evaluate(result.panels,{columns:3,rows:2},catalog).valid).toBe(true);
  });
  it('swap is legal, while no-motion and repeated starter retain their snapshots',()=>{
    const before=[p('ledger',0,0),p('calendar',1,0)];const grid={columns:2,rows:1};
    expect(preview(before,{type:'move',featureId:'ledger',column:1,row:0},grid,catalog).panels).toEqual([p('ledger',1,0),p('calendar',0,0)]);
    expect(preview(before,{type:'move',featureId:'ledger',column:0,row:0},grid,catalog).status).toBe('unchanged');
    expect(preview(before,{type:'starter',featureIds:['ledger','margin','calendar']},grid,catalog)).toMatchObject({status:'unchanged',panels:before});
  });
  it('validates malformed snapshots and sizes before resolving collisions',()=>{
    const grid:GridSpec={columns:6,rows:4};
    expect(evaluate([p('ledger',0,0),p('ledger',1,0)],grid,catalog).code).toBe('DUPLICATE');
    expect(evaluate([p('ledger',-1,0)],grid,catalog).code).toBe('INVALID_POSITION');
    expect(evaluate([p('ledger',0,0,1.5)],grid,catalog).code).toBe('INVALID_SIZE');
    expect(preview([p('ledger',0,0)],{type:'resize',featureId:'ledger',width:5,height:1},grid,catalog).code).toBe('INVALID_SIZE');
    expect(preview([p('ledger',0,0)],{type:'restore',panels:[p('ledger',0,0),p('calendar',0,0)]},grid,catalog)).toMatchObject({code:'INVALID_POSITION',panels:[p('ledger',0,0)]});
  });
  it('derives reading order independently of source array order, and rejects stale commits',()=>{
    const before=[p('ledger',4,2),p('calendar',2,0),p('margin',1,0)];
    expect(readingOrder(before).map(p=>p.featureId)).toEqual(['margin','calendar','ledger']);
    expect(commit(evaluate(before,{columns:6,rows:4},catalog),1,2).code).toBe('STALE_REVISION');
  });
});
