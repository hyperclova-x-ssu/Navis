export function panelShape(width:number,height:number){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||width>4||height<1||height>4)throw new RangeError('Panel dimensions must be integers in 1..4');
  return width===1&&height===1?'Q':height===1?'W':width===1?'T':width===2&&height===2?'S':'L';
}

/** All values are logical canvas pixels supplied/measured by the consumer. */
export function panelContentBudget({width,height,textScale,bodyWidth,bodyHeight,primaryHeight}:{readonly width:number;readonly height:number;readonly textScale:100|125;readonly bodyWidth:number;readonly bodyHeight:number;readonly primaryHeight:number}){
 const shape=panelShape(width,height),large=textScale===125;
 const plotWidth=shape==='W'?(bodyWidth-16)*.58:shape==='L'?(bodyWidth-24)*.58:bodyWidth;
 const remaining=shape==='W'?bodyHeight:Math.max(0,bodyHeight-primaryHeight-(shape==='L'?24:12));
 const minimumPlot=shape==='W'?96:shape==='S'?(large?96:144):(large?144:160);
 return {shape,showChart:shape!=='Q'&&shape!=='T'&&!(large&&shape==='W')&&plotWidth>=240&&remaining>=minimumPlot+(large?30:24),showWorkspace:shape!=='Q'&&plotWidth>=(shape==='T'?208:240)&&remaining>=(shape==='W'?96:160)};
}
type PlacementRect = {readonly x:number;readonly y:number;readonly width:number;readonly height:number};
const intersects=(a:PlacementRect,b:PlacementRect)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
export function panelToolPosition(anchor:PlacementRect,popup:{width:number;height:number},canvas:{width:number;height:number},blocked:readonly PlacementRect[]=[]){
 const gap=12,margin=24,w=popup.width,h=popup.height;
 // Slide along the panel edge when a corner touches the header or page bar.
 const xs=[anchor.x,margin,canvas.width-margin-w,...blocked.flatMap(r=>[r.x-w-gap,r.x+r.width+gap])].sort((a,b)=>Math.abs(a-anchor.x)-Math.abs(b-anchor.x));
 const ys=[anchor.y,margin,canvas.height-margin-h,...blocked.flatMap(r=>[r.y-h-gap,r.y+r.height+gap])].sort((a,b)=>Math.abs(a-anchor.y)-Math.abs(b-anchor.y));
 const candidates=[...xs.map(x=>({x,y:anchor.y-gap-h,side:'top' as const})),...xs.map(x=>({x,y:anchor.y+anchor.height+gap,side:'bottom' as const})),...ys.map(y=>({x:anchor.x-gap-w,y,side:'left' as const})),...ys.map(y=>({x:anchor.x+anchor.width+gap,y,side:'right' as const}))];
 const fit=candidates.find(p=>p.x>=margin&&p.y>=margin&&p.x+w<=canvas.width-margin&&p.y+h<=canvas.height-margin&&(p.side==='top'||p.side==='bottom'?p.x<anchor.x+anchor.width&&p.x+w>anchor.x:p.y<anchor.y+anchor.height&&p.y+h>anchor.y)&&!blocked.some(rect=>intersects({...p,width:w,height:h},rect)));
 if(fit)return fit;
 // Four-by-four panels cannot leave an adjacent gap. The documented y96 fallback
 // may cover the panel, but still avoids measured header and page controls.
 const x=Math.max(margin,Math.min(anchor.x,canvas.width-margin-w));
 const minY=Math.max(96,...blocked.filter(r=>r.y<96).map(r=>r.y+r.height+8));
 const fallback={x,y:minY,side:'header' as const};
 const possible=[fallback,...blocked.map(r=>({x,y:r.y+r.height+gap,side:'header' as const}))];
 return possible.find(p=>p.y+h<=canvas.height-margin&&!blocked.some(r=>intersects({...p,width:w,height:h},r)))??fallback;
}
