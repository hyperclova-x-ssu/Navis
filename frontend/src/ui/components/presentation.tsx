import type { HTMLAttributes, ReactNode, TableHTMLAttributes } from 'react';
import type { ListItem, Metric as MetricData, Panel, Series } from '../../contracts';
import { Icon } from '../icons';
import { useKitT } from '../kit-i18n';
import { getChartDomain,chartPointY } from '../chart-domain';
import { chartToneFor,type ChartSeriesKey } from '../tones';
import { ActionButton } from './controls';
import { useUi } from '../context';

export function Badge({tone='neutral',className='',...props}:HTMLAttributes<HTMLSpanElement> & {readonly tone?:'neutral'|'up'|'down'}){return <span {...props} className={`ui-badge ui-badge--${tone} ${className}`}/>;}
export function DeltaBadge({direction='flat',label,compact=false}:{readonly direction?:'up'|'down'|'flat';readonly label?:string;readonly compact?:boolean}){
  const {t}=useKitT();const text=label??t('ui.delta.unchanged');const arrow=direction==='up'?'▲':direction==='down'?'▼':'—';
  return <Badge tone={direction==='flat'?'neutral':direction} className={compact?'ui-badge--compact':''}>{/[▲▼—]/u.test(text)?text:`${arrow} ${text}`}</Badge>;
}
export function Metric({data,display=false,compact=false}:{readonly data:MetricData;readonly display?:boolean;readonly compact?:boolean}){
  const {format}=useKitT();const value=typeof data.value==='number'?(Number.isFinite(data.value)?format.number(data.value,{maximumFractionDigits:2}):'—'):data.value;
  const comparison=data.deltaDirection?<DeltaBadge compact={compact} direction={data.deltaDirection} label={data.deltaLabel}/>:null;
  return <div><dl className={`ui-metric${compact?' ui-metric--compact':''}`}><dt className="ui-metric-label">{data.label}</dt><dd className={`ui-metric-value ${typeof data.value==='string'?'ui-metric-value--text':''} ${display&&!compact?'ui-metric-value--display':''}`}>{value}<span className="ui-metric-unit">{data.unit}</span></dd>{compact&&comparison?<dd className="ui-metric-delta ui-panel-comparison">{comparison}</dd>:null}</dl>{!compact&&comparison?<div className="ui-metric-delta ui-panel-comparison">{comparison}</div>:null}</div>;
}
export function DataList({items,label,secondary=false,compact=false}:{readonly items:readonly ListItem[];readonly label?:string;readonly secondary?:boolean;readonly compact?:boolean}){
  return <ul className={`ui-data-list${compact?' ui-data-list--compact':''}`} aria-label={label}>{items.map((item,i)=><li key={item.id} className={secondary&&i>=2?'ui-panel-tertiary-item':undefined}><div className="ui-data-list__text"><div className="ui-data-list__title">{item.title}</div>{item.subtitle?<div className="ui-data-list__subtitle">{item.subtitle}</div>:null}</div>{item.badge?<Badge>{item.badge}</Badge>:null}</li>)}</ul>;
}
export function MiniChart({data,kind='bar',secondary=false,compact=false,seriesKeys,itemKeys}:{readonly data:Series;readonly kind?:'bar'|'line';readonly secondary?:boolean;readonly compact?:boolean;readonly seriesKeys?:readonly ChartSeriesKey[];readonly itemKeys?:readonly ChartSeriesKey[]}){
  const {t,format}=useKitT();const domain=getChartDomain(data.series.flatMap(s=>s.values),kind);
  if(!domain.hasValues)return <p className="ui-chart-caption">{t('ui.chart.empty')}</p>;
  const summaries=data.series.map(s=>`${s.name}: ${s.values.map((v,i)=>`${data.axisLabels[i]??i+1} ${Number.isFinite(v)?format.number(v,{maximumFractionDigits:2})+s.unit:t('ui.chart.unavailable')}`).join(', ')}`);
  const unit0=data.series[0]?.unit??'';const axisLabel=t('ui.chart.axis',{min:format.number(domain.min,{maximumFractionDigits:2}),max:format.number(domain.max,{maximumFractionDigits:2}),unit:unit0})+(domain.min!==0?t('ui.chart.axisNonZero'):'');
  const summary=`${summaries.join('; ')} · ${axisLabel}`;
  return <figure className={`ui-mini-chart ${compact?'ui-mini-chart--compact':''} ${secondary?'ui-panel-secondary-chart':''}`}><div role="img" aria-label={summary}><div className="ui-chart-plot" aria-hidden="true"><span className="ui-chart-zero" style={{top:`${domain.zeroY}%`}}/>{kind==='bar'?<div className="ui-chart-bars">{Array.from({length:Math.max(...data.series.map(series=>series.values.length))},(_,i)=><div className="ui-chart-bar-group" key={i}>{data.series.map((series,seriesIndex)=>{const value=series.values[i];return Number.isFinite(value)?<span className="ui-chart-bar-slot" key={series.name}><span className="ui-chart-bar" data-sign={value<0?'negative':'positive'} style={{top:`${Math.min(domain.zeroY,chartPointY(value,domain))}%`,height:`${Math.abs(chartPointY(value,domain)-domain.zeroY)}%`,background:chartToneFor(itemKeys?.[i]??seriesKeys?.[seriesIndex]??'current')}}/></span>:<span className="ui-chart-unavailable" key={series.name}>—</span>;})}</div>)}</div>:data.series.map((series,seriesIndex)=><svg key={series.name} className="ui-line-plot" viewBox="0 0 100 100" preserveAspectRatio="none" style={{color:chartToneFor(seriesKeys?.[seriesIndex]??'current')}}>{series.values.map((value,i)=>{
    if(!Number.isFinite(value))return null;const x=series.values.length===1?50:i/(series.values.length-1)*100,y=chartPointY(value,domain),previous=series.values[i-1];
    return <g key={i}>{i>0&&Number.isFinite(previous)?<line x1={(i-1)/(series.values.length-1)*100} y1={chartPointY(previous,domain)} x2={x} y2={y} stroke="currentColor" strokeWidth="2" strokeDasharray={seriesIndex?'5 3':undefined} vectorEffect="non-scaling-stroke"/>:null}{seriesIndex?<polygon points={`${x},${y-2} ${x+2},${y} ${x},${y+2} ${x-2},${y}`} fill="currentColor"/>:<circle cx={x} cy={y} r="2" fill="currentColor"/>}</g>;
  })}</svg>)}</div>{compact?<div className="ui-chart-endpoints" aria-hidden="true"><span>{data.axisLabels[0]}</span><span>{data.axisLabels.at(-1)}</span></div>:<div className="ui-chart-labels" aria-hidden="true">{data.axisLabels.map((label,i)=><span key={i}>{label}</span>)}</div>}</div></figure>;
}
export function DashboardGrid({children,editing=false,empty=false,className='',...props}:HTMLAttributes<HTMLDivElement> & {readonly editing?:boolean;readonly empty?:boolean}){
  const {screenPreset}=useUi();const grid=screenPreset.grid;
  return <div {...props} className={`ui-dashboard-grid ${className}`} data-editing={String(editing)} data-empty={String(empty)}>{Array.from({length:grid.columns*grid.rows},(_,i)=><div key={`cell-${i}`} aria-hidden="true" className="ui-grid-cell" style={{gridRow:Math.floor(i/grid.columns)+1,gridColumn:i%grid.columns+1}}/>)}{children}</div>;
}
export function DropPreview({panel,status,reason,pendingLong=false,displacedCount=0}:{readonly panel:Panel;readonly status:'pending'|'accepted'|'unchanged'|'rejected';readonly reason?:string;readonly pendingLong?:boolean;readonly displacedCount?:number}){
  const {t,locale}=useKitT();const size=t('ui.panel.size',{w:panel.width,h:panel.height});
  return <div className="ui-drop-preview" data-status={status} style={{gridRow:`${panel.row+1} / span ${panel.height}`,gridColumn:`${panel.column+1} / span ${panel.width}`}}><span>{status==='rejected'?<Icon name="error"/>:null}{status==='pending'?(pendingLong?t('ui.drop.checking'):size):status==='rejected'?reason??t('ui.drop.cannot'):`${t('ui.drop.here')}${locale==='ko'?'\u00a0·\u00a0':' · '}${size}${displacedCount?`${locale==='ko'?'\u00a0·\u00a0':' · '}${t('ui.drop.displaced',{n:displacedCount})}`:""}`}</span></div>;
}
export function ScrollArea({className='',...props}:HTMLAttributes<HTMLDivElement>){return <div {...props} className={`ui-scroll-area ${className}`} tabIndex={props.tabIndex??0}/>;}
export function Separator(props:HTMLAttributes<HTMLHRElement>){return <hr {...props} className={`ui-separator ${props.className??''}`}/>;}
export function Table({className='',...props}:TableHTMLAttributes<HTMLTableElement>){return <table {...props} className={`ui-table ${className}`}/>;}
/** DS 11.5: an empty state is an icon 20 plus the sentence, never colour alone (K-E 19). The ⓘ mark is decorative; the title carries the words. */
export function InlineEmpty({title,description,action}:{readonly title:string;readonly description?:string;readonly action?:ReactNode}){return <div className="ui-inline-state ui-inline-state--empty"><span className="ui-inline-state__mark" aria-hidden="true"><Icon name="info" className="ui-inline-state__icon"/></span><h2 className="ui-inline-state__title">{title}</h2>{description?<p className="ui-inline-state__description">{description}</p>:null}{action}</div>;}
export function Loading(){const {t}=useKitT();return <div className="ui-inline-state" role="status" aria-live="polite"><div className="ui-skeleton" aria-hidden="true"/><p className="ui-inline-state__description">{t('ui.loading')}</p></div>;}
export function InlineError({onRetry,message}:{readonly onRetry:()=>void;readonly message?:string}){const {t}=useKitT();return <div className="ui-inline-state ui-inline-state--error" role="alert"><Icon name="error"/><p className="ui-inline-state__description">{message??t('ui.notice.displayError')}</p><div><ActionButton variant="outline" onClick={onRetry}>{t('common.retry')}</ActionButton></div></div>;}
export function SkipLink({targetId='dashboard'}:{readonly targetId?:string}){const {t}=useKitT();return <a href={`#${targetId}`} className="ui-skip-link">{t('ui.skip.dashboard')}</a>;}
