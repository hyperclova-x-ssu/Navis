import { useContext, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { UiContext } from '../context';
import { useKitT } from '../kit-i18n';
import { PanelAction } from './marketing';
import { usePanelChrome } from '../panel-chrome';
import { Icon, type IconName } from '../icons';
import { panelShape } from '../panel-layout';

export type MetricFitStage=0|1|2;
export type TextMeasure=(text:string,fontPx:number,weight:number)=>number;
/** DS 11.3.4 sizes in logical px at 100% text: type.metric 44, type.heading 32, unit caption 16. 125% scales all by 1.25. */
export const metricFitSizes=Object.freeze({metric:44,heading:32,caption:16,gap:4,/** edit state: the 48px resize handle plus 8 inset keeps the number clear of the corner */handle:56});
let canvas:CanvasRenderingContext2D|null|undefined;
/** Canvas based measure; where canvas is missing (tests) it falls back to 0.62 em per character, digits being the widest. */
export const measureWithCanvas:TextMeasure=(text,fontPx,weight)=>{
  if(canvas===undefined){try{canvas=typeof document!=='undefined'?document.createElement('canvas').getContext('2d'):null;}catch{canvas=null;}}
  const family=typeof document!=='undefined'?getComputedStyle(document.body).fontFamily:'sans-serif';
  if(canvas){canvas.font=`${weight} ${fontPx}px ${family}`;const width=canvas.measureText(text).width;if(width>0)return width;}
  return Array.from(text).length*fontPx*0.62;
};
/** DS 19.2: one-row sizes are height budgets, including at 125% text. */
export function heroMetricSize({preset='A',textScale=100,height=2}:{readonly preset?:string;readonly textScale?:100|125;readonly height?:number}) {
  if(height!==1)return textScale===125?{size:98.75,leading:106.65}:{size:79,leading:85.32};
  if(preset==='B')return textScale===125?{size:65,leading:70}:{size:77,leading:83};
  return textScale===125?{size:55,leading:59}:{size:52,leading:56};
}
/** Default kit thresholds stay compatible; DS 19 surfaces supply their actual number budget. */
export function chooseMetricStage({width,text,unit,textScale=100,measure=measureWithCanvas,management=false,heroSize,payment=false}:{readonly width:number;readonly text:string;readonly unit?:string;readonly textScale?:100|125;readonly measure?:TextMeasure;readonly management?:boolean;readonly heroSize?:number;readonly payment?:boolean}):MetricFitStage{
  const k=textScale===125?1.25:1;const s=metricFitSizes;
  const unitWidth=unit?measure(unit,(payment?24:s.caption)*k,payment?700:500)+s.gap:0;
  const hero=heroSize??(management?79*k:undefined);
  if(measure(text,hero??s.metric*k,800)+unitWidth<=width)return 0;
  if(payment||measure(text,(hero!==undefined?s.metric:s.heading)*k,hero!==undefined?800:700)+unitWidth<=width)return 1;
  return 2;
}
/** MetricFit measures only presentation; it never formats, rounds or truncates the supplied value. */
export function MetricFit({value,unit,unitPlacement='after',longest,measure,stacked,minStage=0,className='',presentation}:{readonly value:string;readonly unit?:string;readonly unitPlacement?:'after'|'before';readonly longest?:string;readonly measure?:TextMeasure;readonly stacked?:boolean;readonly minStage?:MetricFitStage;readonly className?:string;readonly presentation?:'hero'|'payment'}){
  const ui=useContext(UiContext);const ref=useRef<HTMLSpanElement>(null);
  const [fit,setFit]=useState<{stage:MetricFitStage;hero:boolean;height:number;strip:boolean}>({stage:0,hero:!!presentation,height:2,strip:false});
  const textScale=ui?.textScale??100;const chrome=usePanelChrome(),editing=chrome.editing;
  const preset=ui?.screenPreset.id??'A';
  const size=heroMetricSize({preset,textScale,height:fit.height});
  useLayoutEffect(()=>{
    const node=ref.current;if(!node)return;
    const run=()=>{
      const panel=node.closest('.ui-feature-panel');
      const height=Number(panel?.getAttribute('data-height')??chrome.span?.height??2);
      const strip=!!node.closest('.mp-strip');
      const hero=!!presentation||!!node.closest('.dashboard-screen');
      const width=node.parentElement?.clientWidth||node.clientWidth;
      if(width<=0)return;
      const base=strip?44*(textScale===125?1.25:1):heroMetricSize({preset,textScale,height}).size;
      const compact=height===1&&Number(panel?.getAttribute('data-width')??0)<=2;
      const inQ=panel?.getAttribute('data-shape')==='Q';
      const chosen=chooseMetricStage({width:editing&&inQ?width-metricFitSizes.handle:width,text:longest??value,unit,textScale,measure,heroSize:hero?base:undefined,payment:presentation==='payment'});
      setFit({stage:hero?chosen:Math.max(minStage,compact?Math.min(chosen,1):chosen) as MetricFitStage,hero,height,strip});
    };
    run();const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(run);if(node.parentElement)observer?.observe(node.parentElement);
    return ()=>observer?.disconnect();
  },[longest,value,unit,textScale,measure,stacked,editing,minStage,presentation,preset,chrome.span?.height]);
  const k=textScale===125?1.25:1;
  const style=fit.hero?{'--metric-fit-size':`${(fit.strip?44:size.size/k)/16}rem`,'--metric-fit-leading':`${(fit.strip?54:size.leading/k)/16}rem`} as CSSProperties:undefined;
  const unitElement=unit?<span className="ui-metric-fit__unit">{unit}</span>:null;
  const prefix=unitPlacement==='before'&&unit;
  return <span ref={ref} style={style} className={`ui-metric-fit ${className}`} data-stage={fit.stage} data-presentation={fit.hero?(presentation??'hero'):undefined} data-stacked={stacked===undefined?undefined:String(stacked)} data-unit-placement={unitPlacement} role={prefix?'img':undefined} aria-label={prefix?`${unit}${value}`:undefined}>{unitPlacement==='before'?unitElement:null}<span className="ui-metric-fit__value">{value}</span>{unitPlacement==='after'?unitElement:null}</span>;
}
export type PanelStateTone='error'|'warning'|'info';
const stateIcon:Readonly<Record<PanelStateTone,IconName>>={error:'error',warning:'warning',info:'info'};
export interface PanelStateProps {
  readonly tone?:PanelStateTone;
  /** Full message in the UI language. Also describes the panel when shortMessage is visible. */
  readonly message:string;
  /** Optional Korean-only copy (LOCALES 11.13). The kit uses it only for 1x1/2x1, independently of measurement, locale, text scale and editing. */
  readonly shortMessage?:ReactNode;
  readonly action?:{readonly label:string;readonly widgetName:string;readonly onPress:()=>void};
  readonly shape?:'Q'|'W'|'T'|'S'|'L';
  readonly children?:ReactNode;
}
/** DS 11.5 / 12.14.1: icon 20, naturally wrapping caption, at most one action 44 high. Line counts are copy budgets, never clipping limits. */
export function PanelState({tone='info',message,shortMessage,action,shape,children}:PanelStateProps){
  const {t,locale}=useKitT();
  const {span}=usePanelChrome();
  const ref=useRef<HTMLDivElement>(null);
  const id=useId();
  // FeaturePanel supplies the actual span. Standalone Q is unambiguous; standalone W retains the full message.
  const compact=span?span.height===1&&(span.width===1||span.width===2):shape==='Q';
  const showShort=shortMessage!=null&&compact;
  const descriptionId=`${id}-message`;
  useLayoutEffect(()=>{
    if(!showShort)return;
    // Keep the existing panel help and any other descriptions. No geometry is read to choose the copy.
    const panel=ref.current?.closest('.ui-feature-panel')?.querySelector('.ui-panel-hit');
    if(!panel)return;
    const ids=new Set((panel.getAttribute('aria-describedby')??'').split(' ').filter(Boolean));
    ids.add(descriptionId);
    panel.setAttribute('aria-describedby',[...ids].join(' '));
    return ()=>{
      const remaining=(panel.getAttribute('aria-describedby')??'').split(' ').filter(value=>value&&value!==descriptionId);
      if(remaining.length)panel.setAttribute('aria-describedby',remaining.join(' '));
      else panel.removeAttribute('aria-describedby');
    };
  },[showShort,descriptionId]);
  return <div ref={ref} className="ui-panel-state" data-tone={tone} data-shape={span?panelShape(span.width,span.height):shape}>
    <div className="ui-panel-state__text">
      <Icon name={stateIcon[tone]} className="ui-panel-state__icon"/>
      <p className="ui-panel-state__message" lang={showShort&&locale!=='ko'?'ko':undefined} role={tone==='error'?'alert':undefined} aria-describedby={showShort?descriptionId:undefined}>
        <span className="ui-sr-only" lang={locale}>{tone==='error'?`${t('common.state.failed')}: `:''}</span>{showShort?shortMessage:message}
      </p>
    </div>
    {showShort?<span id={descriptionId} className="ui-sr-only ui-panel-state__description" lang={locale}>{message}</span>:null}
    {children}{action?<PanelAction {...action}/>:null}
  </div>;
}
