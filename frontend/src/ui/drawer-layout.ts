export function drawerRowHeight({titleLines,placed,textScale}:{readonly titleLines:number;readonly placed:boolean;readonly textScale:100|125}):number {
  const large=textScale===125;return Math.max(large?88:72,16+(large?35:28)*Math.max(1,titleLines)+(placed?(large?30:24):0));
}
export function drawerContentHeight({maxHeight,bodyHeight,hintHeight,headerHeight=48}:{readonly maxHeight:number;readonly bodyHeight:number;readonly hintHeight:number;readonly headerHeight?:number}):number {
  return Math.min(maxHeight,34+Math.max(48,headerHeight)+12+Math.max(0,bodyHeight)+12+hintHeight);
}
