import {describe,expect,it} from 'vitest';
import {getCatalog} from '../catalog';
import {preview} from './index';
import {layoutCacheKey} from './cache';
import type {LayoutIntent,Panel} from '../contracts';
const grid={columns:4,rows:4},catalog=getCatalog('A');
const condition={kind:'dateRange',start:'2026-10-20',end:'2026-10-26'} as const;
const make=(width:number,height:number)=>({type:'add-candidate-tap',featureId:'ledger',width,height,condition} as unknown as LayoutIntent);
describe('candidate tap',()=>{
 it.each([[2,1],[1,2],[4,4]])('uses the first free %sx%s rectangle and condition', (width,height)=>{const result=preview([],make(width,height),grid,catalog);expect(result.panels[0]).toMatchObject({column:0,row:0,width,height,condition});});
 it('skips occupied cells without displacing them',()=>{const before:Panel[]=[{featureId:'margin',column:1,row:0,width:1,height:1}];const result=preview(before,make(2,1),grid,catalog);expect(result.panels).toContainEqual(before[0]);expect(result.panels[1]).toMatchObject({column:2,row:0,width:2,height:1});});
 it('defaults invalid sizes to 1x1',()=>{expect(preview([],make(9,0),grid,catalog).panels[0]).toMatchObject({width:1,height:1});});
 it('rejects when no rectangle fits and preserves duplicate',()=>{const before:Panel[]=[{featureId:'margin',column:1,row:0,width:1,height:4},{featureId:'tax',column:3,row:0,width:1,height:4}];expect(preview(before,make(2,1),grid,catalog).code).toBe('NO_CAPACITY');const duplicate:Panel[]=[{featureId:'ledger',column:0,row:0,width:1,height:1}];expect(preview(duplicate,make(2,1),grid,catalog)).toMatchObject({code:'DUPLICATE',panels:duplicate});});
 it('keeps size and condition in cache keys',()=>{const intent={type:'add-ai',featureId:'ledger',column:0,row:0,width:2,height:1,condition} as const;const base={presetId:'A' as const,beforePanels:[],intent};expect(layoutCacheKey(base)).not.toBe(layoutCacheKey({...base,intent:{...intent,width:1}}));expect(layoutCacheKey(base)).not.toBe(layoutCacheKey({...base,intent:{...intent,condition:{kind:'default'}}}));});
});
