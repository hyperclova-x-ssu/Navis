import { useLayoutEffect, useRef, type RefObject } from 'react';
import { managementTokens, motionTokens } from '../motion';
export function planGridFlip(before:ReadonlyMap<string,number>,after:ReadonlyMap<string,number>):{id:string;delta:number}[]{
  if(before.size>managementTokens.sortVisibleMax||after.size>managementTokens.sortVisibleMax)return [];
  return [...before].flatMap(([id,y])=>{const next=after.get(id);return next===undefined||next===y?[]:[{id,delta:y-next}];});
}
type Frame={positions:Map<string,number>;nodes:Map<string,HTMLElement>;scale:number;overLimit:boolean};
/** Flow offsets locate the visible slice; only that slice gets visual rect reads.
 * Active rows are also sampled, so an interrupted FLIP starts at its displayed position.
 * Every read finishes before animation cancellation or creation (one layout flush/pass).
 */
export function useGridReorder(root:RefObject<HTMLElement|null>,ids:readonly string[],reduced:boolean,filterKey:string){
  const animations=useRef<{node:HTMLElement;animation:Animation}[]>([]),before=useRef<Frame|null>(null),previous=useRef(ids.join('\0')),filter=useRef(filterKey);
  const cancel=()=>{animations.current.forEach(({animation})=>animation.cancel());animations.current=[];};
  const read=():Frame=>{
    const positions=new Map<string,number>(),nodes=new Map<string,HTMLElement>(),area=root.current;
    if(!area)return {positions,nodes,scale:1,overLimit:false};
    const clip=area.getBoundingClientRect(),scale=area.offsetWidth?clip.width/area.offsetWidth:1;
    if(clip.width<=0||clip.height<=0)return {positions,nodes,scale,overLimit:false};
    const rows=[...area.querySelectorAll<HTMLElement>('[data-grid-row]')];
    const table=area.querySelector('table'),origin=table?.getBoundingClientRect().top??clip.top-area.scrollTop*scale;
    // offsetTop is relative to the table and ignores FLIP transforms. Expanded rows and
    // variable-height names are accounted for without assuming a fixed row height.
    let lo=0,hi=rows.length;
    while(lo<hi){const mid=(lo+hi)>>>1,node=rows[mid];if(origin+(node.offsetTop+node.offsetHeight)*scale<=clip.top)lo=mid+1;else hi=mid;}
    const candidates=new Set<HTMLElement>();
    for(let i=lo;i<rows.length&&origin+rows[i].offsetTop*scale<clip.bottom;i++){
      candidates.add(rows[i]);if(candidates.size>managementTokens.sortVisibleMax)break;
    }
    const overLimit=candidates.size>managementTokens.sortVisibleMax;
    for(const {node,animation} of animations.current)if(animation.playState==='running'&&node.isConnected)candidates.add(node);
    for(const node of candidates){const rect=node.getBoundingClientRect();if(rect.bottom>clip.top&&rect.top<clip.bottom){positions.set(node.dataset.gridRow!,rect.top);nodes.set(node.dataset.gridRow!,node);}}
    return {positions,nodes,scale,overLimit:overLimit||positions.size>managementTokens.sortVisibleMax};
  };
  const capture=()=>{before.current=reduced?null:read();cancel();};
  useLayoutEffect(()=>{
    const order=ids.join('\0');
    if(order!==previous.current){
      const old=before.current;
      const next=!reduced&&filter.current===filterKey&&old?read():null;
      cancel();
      if(old&&next&&!old.overLimit&&!next.overLimit){
        const oldIds=new Set(previous.current.split('\0'));
        for(const {id,delta} of planGridFlip(old.positions,next.positions)){
          const node=next.nodes.get(id)!;
          if(node.animate)animations.current.push({node,animation:node.animate([{transform:`translateY(${delta/next.scale}px)`},{transform:'translateY(0px)'}],{duration:motionTokens.duration.sort,easing:`cubic-bezier(${motionTokens.ease.inOut.join(',')})`})});
        }
        for(const [id,node] of next.nodes)if(!oldIds.has(id)&&node.animate)animations.current.push({node,animation:node.animate([{opacity:0},{opacity:1}],{duration:motionTokens.duration.rowIn})});
      }
    }
    previous.current=order;filter.current=filterKey;before.current=null;
  });
  useLayoutEffect(()=>()=>cancel(),[]);
  return {capture,cancel};
}
