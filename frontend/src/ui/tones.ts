import type { CSSProperties } from 'react';
import type { GroupId } from '../contracts';
export type CanonicalGroupId='recommend'|'news'|'money'|'customers'|'operations'|'local'|'products'|'stock'|'finance'|'members'|'store'|'misc'|'schedule';
export function canonicalGroupId(group:GroupId):CanonicalGroupId {return group==='recommended'?'recommend':group==='neighborhood'?'local':group;}
export function groupStyle(group:GroupId):CSSProperties {return {'--group-color':`var(--group-${canonicalGroupId(group)})`} as CSSProperties;}
export type ChartSeriesKey='current'|'revenue'|'margin'|'cost'|'secondary'|'third'|'morning'|'afternoon'|'evening'|'previous';
const seriesTones:Readonly<Record<ChartSeriesKey,number>>=Object.freeze({current:1,revenue:1,margin:1,cost:2,secondary:2,third:3,morning:4,afternoon:1,evening:5,previous:6});
export function chartToneFor(key:ChartSeriesKey):string {return `var(--chart-${seriesTones[key]})`;}
