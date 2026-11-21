export type ChartKind='line'|'bar';
/** Numbers only: the axis sentence is the translated `ui.chart.axis` in MiniChart (T-055 removed the Korean axisLabel). */
export interface ChartDomain {readonly min:number;readonly max:number;readonly hasValues:boolean;readonly invalidCount:number;readonly zeroY:number}
/** Shared by panel and detail. Invalid values are gaps, never invented zeroes. */
export function getChartDomain(values:readonly number[],kind:ChartKind='line'):ChartDomain {
  const finite=values.filter(Number.isFinite),invalidCount=values.length-finite.length;
  if(!finite.length)return {min:0,max:1,hasValues:false,invalidCount,zeroY:100};
  const low=Math.min(...finite),high=Math.max(...finite);
  const padding=high>low?(high-low)/5:Math.max(Math.abs(high)/20,1);
  const min=kind==='bar'?Math.min(0,low):low-padding,max=kind==='bar'?Math.max(0,high):high+padding;
  const upper=max===min?max+1:max;
  return {min,max:upper,hasValues:true,invalidCount,zeroY:Math.max(0,Math.min(100,upper/(upper-min)*100))};
}
export function chartPointY(value:number,domain:ChartDomain):number {return (domain.max-value)/(domain.max-domain.min)*100;}
