import { useKitT } from '../kit-i18n';
import { Icon, type IconName } from '../icons';

/** DS 11.4 IntegrationBadge: height 32, static state label (no focus), icon plus words. The text is its accessible name. */
export function IntegrationBadge({label,state='connected'}:{readonly label:string;readonly state?:'connected'|'needed'}){
  return <span className="ui-integration-badge" data-state={state}><Icon name={state==='connected'?'link':'warning'} aria-hidden/> <span>{label}</span></span>;
}
export type StatusKind='confirmed'|'needsReview'|'suggested'|'endingSoon'|'reviewed'|'checked'|'recommended'|'paused'|'active';
/**
 * DS 6.1 G-22 icon meanings, typed so a chip cannot pick an icon by hand:
 * done ✓ (선택·완료·확정·정상·납부 완료·답변 완료) · info ⓘ (도움말·설명·유형 안내 only) · waiting ◷ (대기 only) · paused ‖ (일시 중지 only)
 * warning ⚠ (경고·기한 지남·확인 필요·보충 필요) · recommend ★ (추천·어울려요) · rating ★ (평점) · positive thumb (긍정, never ✓).
 * `none` is a text-only kind/type chip (방문 예약, 픽업, 횟수권): it still is 28 high, it just carries no state icon.
 */
export type StatusSemantic='done'|'info'|'waiting'|'paused'|'warning'|'recommend'|'rating'|'positive';
export type StatusSemanticProp=StatusSemantic|'none';
export type StatusTone='success'|'warning'|'neutral';
export const statusSemantics:Readonly<Record<StatusSemantic,{readonly icon:IconName;readonly tone:StatusTone}>>={
  done:{icon:'check',tone:'success'},info:{icon:'info',tone:'neutral'},waiting:{icon:'clock',tone:'neutral'},paused:{icon:'pause',tone:'neutral'},
  warning:{icon:'warning',tone:'warning'},recommend:{icon:'star',tone:'success'},rating:{icon:'star',tone:'neutral'},positive:{icon:'thumb-up',tone:'success'},
};
const statusTone:Readonly<Record<StatusKind,StatusTone>>={confirmed:'success',needsReview:'warning',suggested:'neutral',endingSoon:'warning',reviewed:'neutral',checked:'success',recommended:'success',paused:'neutral',active:'success'};
const statusIcon:Readonly<Record<StatusKind,IconName>>={confirmed:'status-ok',needsReview:'warning',suggested:'info',endingSoon:'clock',reviewed:'check',checked:'check',recommended:'star',paused:'pause',active:'status-ok'};
/** The one place a chip or badge turns a semantic into its icon (null = no icon). */
export function statusSemanticIcon(semantic:StatusSemanticProp):IconName|null{return semantic==='none'?null:statusSemantics[semantic].icon;}
/**
 * DS 11.4 StatusBadge = DS 12 StatusChip shape: height 28 (125% text: 30, from the 24 line plus the rem scale), radius.sm, icon 16 + caption 700, padding 0/8.
 * Colour never carries the meaning alone (icon plus words). `semantic` picks the icon by meaning; `kind` keeps the fixed words.
 */
export function StatusBadge({kind,label,tone,semantic}:{readonly kind?:StatusKind;/** Overrides the default words (e.g. 추천, 긍정). */readonly label?:string;readonly tone?:StatusTone;/** G-22: icon by meaning. Wins over the icon implied by `kind`. */readonly semantic?:StatusSemanticProp}){
  const {t}=useKitT();
  const words:Readonly<Record<StatusKind,string>>={confirmed:t('common.badge.confirmed'),needsReview:t('common.badge.needsReview'),suggested:t('common.badge.suggested'),endingSoon:t('common.badge.endingSoon'),reviewed:t('common.badge.reviewed'),checked:t('common.badge.checked'),recommended:t('ui.benefit.recommended'),paused:t('common.state.normal'),active:t('common.state.normal')};
  const text=label??(kind?words[kind]:'');
  const icon:IconName|null=semantic!==undefined?statusSemanticIcon(semantic):kind?statusIcon[kind]:null;
  const resolvedTone=tone??(semantic&&semantic!=='none'?statusSemantics[semantic].tone:kind?statusTone[kind]:'neutral');
  return <span className="ui-status-badge" data-tone={resolvedTone} data-kind={kind} data-semantic={semantic}>{icon?<><Icon name={icon} aria-hidden/> </>:null}<span>{text}</span></span>;
}
export interface SplitSegment { readonly label:string;readonly value:number;/** Direct label text next to the number, e.g. '22명'. */readonly display:string }
/** DS 11.4 SplitBar: height 8, two segments (chart-1, chart-2), direct labels under, an accessible summary sentence. */
export function SplitBar({a,b,label}:{readonly a:SplitSegment;readonly b:SplitSegment;readonly label?:string}){
  const {t}=useKitT();const total=a.value+b.value;const share=total>0?a.value/total*100:50;
  const summary=label??t('ui.splitbar.summary',{a:a.label,aValue:a.display,b:b.label,bValue:b.display});
  return <div className="ui-split-bar"><div className="ui-split-bar__track" role="img" aria-label={summary}><span className="ui-split-bar__a" style={{width:`${share}%`}}/><span className="ui-split-bar__b" style={{width:`${100-share}%`}}/></div><div className="ui-split-bar__labels" aria-hidden="true"><span><i data-series="a"/>{a.label} {a.display}</span><span><i data-series="b"/>{b.label} {b.display}</span></div></div>;
}
