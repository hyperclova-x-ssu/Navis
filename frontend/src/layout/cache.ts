import type { LayoutWorkerRequest, Panel } from '../contracts';
export class LayoutCache<T> {
  private readonly entries=new Map<string,T>();
  constructor(private readonly limit=256){if(!Number.isInteger(limit)||limit<1||limit>256)throw new RangeError('Cache capacity must be 1..256');}
  get size():number{return this.entries.size;}
  get(key:string):T|undefined {const value=this.entries.get(key);if(value!==undefined){this.entries.delete(key);this.entries.set(key,value);}return value;}
  set(key:string,value:T):void {this.entries.delete(key);this.entries.set(key,value);if(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);}
  clear():void {this.entries.clear();}
}
const normalize=(panels:readonly Panel[])=>[...panels].sort((a,b)=>a.featureId<b.featureId?-1:a.featureId>b.featureId?1:0).map(p=>[p.featureId,p.column,p.row,p.width,p.height,p.condition??{kind:'default'}]);
export function layoutCacheKey({presetId,beforePanels,intent}:Pick<LayoutWorkerRequest,'presetId'|'beforePanels'|'intent'>):string {
  const i=intent.type==='restore'?['restore',normalize(intent.panels)]:intent.type==='starter'?['starter',intent.featureIds]:intent.type==='add-tap'||intent.type==='remove'?[intent.type,intent.featureId]:intent.type==='add-candidate-tap'?[intent.type,intent.featureId,intent.width,intent.height,intent.condition]:intent.type==='add-ai'?[intent.type,intent.featureId,intent.column,intent.row,intent.width,intent.height,intent.condition]:intent.type==='resize'?['resize',intent.featureId,intent.width,intent.height]:[intent.type,intent.featureId,intent.column,intent.row];
  return JSON.stringify([presetId,normalize(beforePanels),i]);
}
