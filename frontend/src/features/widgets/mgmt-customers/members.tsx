import { memberDetailEntry } from '../../assistant/domains/members';
import { useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import { useBundle, type MessageBundle } from '../../../i18n';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { useDataDispatch, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { selectMembers } from '../../../data/derive/members';
import { selectMemberDeleteBlockers, type MemberDeleteBlockers } from '../../../data/commands/member-guard';
import { ActionButton, Icon, DataGrid, DetailSidePanel, DetailTabs, TextField, Textarea, ChipChoice, GradeBar, InlineForm, StatusChip, type GridColumn, type GridFocus, type GridSort, type DataGridHandle, formatPosMoney } from '../../../ui';
import { Body, DetailState, Kpi, ListBlock, PanelFrame, Row, StatePanel, reportResult, useT } from './shared';

import { restoreGrid, useSideGrid } from './workspace';
import { MemberMoneySection } from '../i7-credit/member-money';

const id='members' as const;
const bundle:MessageBundle<string>={id:'widget.members.screen',en:{
  'widget.members.blocked.charge':'prepaid balance {amount}','widget.members.blocked.receivable':'open receivable {amount}','widget.members.blocked.pass':'active passes {n}','widget.members.blocked.sep':', ',
  'widget.members.blocked.reason':'This member cannot be deleted yet. Still open: {items}. {action}','widget.members.blocked.act.money':'Please settle first.','widget.members.blocked.act.pass':'Please use up or refund the passes first.','widget.members.blocked.act.both':'Please settle first, then use up or refund the passes.',
  'widget.members.duplicate.row':'Member with this number: {name} · {phone}','widget.members.duplicate.open':'View that member',
  'widget.members.member':'Member','widget.members.unitPass':'passes','widget.members.unitUses':'uses','widget.members.endingSoon':'Ending soon','widget.members.editShort':'Edit','widget.members.removeShort':'Delete',
  'widget.members.error.name':'Please enter a name','widget.members.error.phone':'Please enter a phone number with 10–11 digits',
},'zh-Hans':{
  'widget.members.blocked.charge':'充值余额 {amount}','widget.members.blocked.receivable':'应收款 {amount}','widget.members.blocked.pass':'使用中的会员券 {n}张','widget.members.blocked.sep':'、',
  'widget.members.blocked.reason':'{items}尚未处理，暂时无法删除。{action}','widget.members.blocked.act.money':'请先结算。','widget.members.blocked.act.pass':'请先用完或退还会员券。','widget.members.blocked.act.both':'请先结算，并用完或退还会员券。',
  'widget.members.duplicate.row':'该号码的会员：{name} · {phone}','widget.members.duplicate.open':'查看该会员',
  'widget.members.member':'会员','widget.members.unitPass':'张','widget.members.unitUses':'次','widget.members.endingSoon':'即将到期','widget.members.editShort':'修改','widget.members.removeShort':'删除',
  'widget.members.error.name':'请输入姓名','widget.members.error.phone':'请输入10~11位数字的手机号',
},'zh-Hant':{
  'widget.members.blocked.charge':'儲值餘額 {amount}','widget.members.blocked.receivable':'應收款 {amount}','widget.members.blocked.pass':'使用中的會員券 {n}張','widget.members.blocked.sep':'、',
  'widget.members.blocked.reason':'{items}尚未處理，暫時無法刪除。{action}','widget.members.blocked.act.money':'請先結算。','widget.members.blocked.act.pass':'請先用完或退還會員券。','widget.members.blocked.act.both':'請先結算，並用完或退還會員券。',
  'widget.members.duplicate.row':'該號碼的會員：{name} · {phone}','widget.members.duplicate.open':'查看該會員',
  'widget.members.member':'會員','widget.members.unitPass':'張','widget.members.unitUses':'次','widget.members.endingSoon':'即將到期','widget.members.editShort':'修改','widget.members.removeShort':'刪除',
  'widget.members.error.name':'請輸入姓名','widget.members.error.phone':'請輸入10~11位數字的手機號碼',
},ko:{
  'widget.members.blocked.charge':'충전금 {amount}','widget.members.blocked.receivable':'외상 {amount}','widget.members.blocked.pass':'이용 중인 회원권 {n}개','widget.members.blocked.sep':', ',
  'widget.members.blocked.reason':'{items, particle, 이/가} 남아 있어서 지울 수 없어요. {action}','widget.members.blocked.act.money':'먼저 정산해 주세요','widget.members.blocked.act.pass':'회원권을 모두 쓰거나 환불해 주세요','widget.members.blocked.act.both':'먼저 정산하고 회원권을 모두 쓰거나 환불해 주세요',
  'widget.members.duplicate.row':'같은 번호의 회원: {name} · {phone}','widget.members.duplicate.open':'그 회원 보기',
  'widget.members.member':'회원','widget.members.unitPass':'개','widget.members.unitUses':'회','widget.members.endingSoon':'곧 끝나요','widget.members.editShort':'고치기','widget.members.removeShort':'지우기',
  'widget.members.error.name':'이름을 넣어 주세요','widget.members.error.phone':'연락처를 숫자 10~11자리로 넣어 주세요',
  'widget.members.lastPayment':'최근 결제','widget.members.lastPaymentEmpty':'최근 결제가 없어요','widget.members.basic':'기본 정보','widget.members.basicSave':'기본 정보 저장하기','widget.members.joined':'가입일','widget.members.consent':'광고 수신','widget.members.yes':'동의','widget.members.no':'동의 안 함','widget.members.history':'방문·이용 이력','widget.members.reservations':'예약 이력','widget.members.received':'받은 쿠폰','widget.members.all':'전체','widget.members.editNote':'메모 고치기','widget.members.updateNote':'메모 저장하기','widget.members.edit':'{name} 고치기','widget.members.remove':'{name} 지우기','widget.members.ending':'이번 주 끝나는 회원권','widget.members.lastUsed':'최근 사용일','widget.members.chooseGrade':'직접 정하기','widget.members.usedCanceled':'사용 취소됨','widget.members.gradeRule':'최근 4주 방문 횟수로 정해요: 단골 4회 이상 · 자주 방문 2~3회 · 가끔 방문 1회 · 오랜 기간 미방문 0회','widget.members.count':'회원','widget.members.memberships':'회원권','widget.members.active':'이용 중 회원권 {n}개','widget.members.list':'회원목록','widget.members.name':'이름','widget.members.phone':'연락처','widget.members.grade':'회원 등급','widget.members.lastVisit':'최근 방문','widget.members.memberId':'회원 ID','widget.members.regular':'단골','widget.members.frequent':'자주 방문','widget.members.occasional':'가끔 방문','widget.members.inactive':'오랜 기간 미방문','widget.members.manual':'직접 정함','widget.members.auto':'자동 등급으로 바꾸기','widget.members.search':'이름이나 연락처 끝자리로 찾아보세요','widget.members.add':'회원 추가하기','widget.members.save':'저장하기','widget.members.close':'닫기','widget.members.delete':'회원 지우기','widget.members.notes':'메모','widget.members.addNote':'메모 추가하기','widget.members.coupon':'쿠폰 보내기','widget.members.noCoupons':'받은 쿠폰 없음','widget.members.noReservations':'예약 이력 없음','widget.members.use':'1회 사용 기록하기','widget.members.cancelUse':'사용 취소하기','widget.members.remaining':'남은 횟수','widget.members.start':'시작일','widget.members.end':'끝나는 날','widget.members.product':'상품','widget.members.none':'검색 결과가 없어요','widget.members.noActive':'이용 중인 회원권이 없어요','widget.members.recent':'최근 4주 방문 {n}회','widget.members.unit':'명','widget.members.noteSave':'메모 저장하기',
}};
function useText(){return useBundle(bundle,...dataBundles);}
type Member=Extract<ReturnType<typeof useWidgetView<'members'>>,{status:'ready'}>['model']['rows'][number];
type Text=ReturnType<typeof useText>;
const displayName=(t:Text,r:Member)=>typeof r.name==='string'?r.name:resolveDataText(t.t,r.name);
const grade=(t:Text,r:Member)=>t.t(`widget.members.${r.grade}`);
/** DS 12.1 StatusChip: 단골 성공(긍정) · 자주·가끔 방문 중립 · 오랜 기간 미방문 경고. 직접 정했으면 칩 옆 caption. One chip per cell. */
const gradeSemantic={regular:'positive',frequent:'none',occasional:'none',inactive:'warning'} as const;
const gradeCell=(t:Text,r:Member)=><><StatusChip semantic={gradeSemantic[r.grade]}>{grade(t,r)}</StatusChip>{r.manuallyGraded?<span className="mc-grade-manual">{t.t('widget.members.manual')}</span>:null}</>;
/** F-1: one sentence that names every blocker (충전금, 외상, 회원권) and what to do; shared by the panel and a stale-delete refusal. */
function blockedReason(t:Text,b:Pick<MemberDeleteBlockers,'charge'|'receivable'|'passes'>){
 const items=[b.charge>0?t.t('widget.members.blocked.charge',{amount:t.format.money(b.charge,'full')}):'',b.receivable>0?t.t('widget.members.blocked.receivable',{amount:t.format.money(b.receivable,'full')}):'',b.passes>0?t.t('widget.members.blocked.pass',{n:b.passes}):''].filter(Boolean);
 const owes=b.charge>0||b.receivable>0,act=owes&&b.passes>0?'both':b.passes>0?'pass':'money';
 return t.t('widget.members.blocked.reason',{items:items.join(t.t('widget.members.blocked.sep')),action:t.t(`widget.members.blocked.act.${act}`)});
}
/** AC-1073: a refused name or number says which one to fix (the data layer's one sentence names both). */
const refusalText=(t:Text,r:{reason?:string;field?:string;messageKey:string})=>r.reason==='MEMBER_INVALID'&&(r.field==='name'||r.field==='phone')?t.t(`widget.members.error.${r.field}`):t.t(r.messageKey);

type SameNumber={memberId:string|null;name:string;phone:string};
/** GD-1: a refused duplicate phone offers the matching masked row (name and number masked, like the member list). */
const sameNumberOf=(r:{reason?:string;details?:Readonly<Record<string,unknown>>}):SameNumber|null=>r.reason==='MEMBER_PHONE_EXISTS'&&r.details?r.details as unknown as SameNumber:null;
function SameNumberRow({t,match,onOpen}:{t:Text;match:SameNumber;onOpen:(memberId:string)=>void}){
 return <p className="mc-caption" data-slot="members.sameNumber">{t.t('widget.members.duplicate.row',{name:match.name,phone:match.phone})}{match.memberId?<> <ActionButton variant="ghost" onClick={()=>onOpen(match.memberId!)}>{t.t('widget.members.duplicate.open')}</ActionButton></>:null}</p>;
}

// eslint-disable-next-line react-refresh/only-export-components -- Public widget accessibility summary hook.
export function useMembersSummary({condition}:{condition:WidgetPanelProps['condition'];featureId:string}){const t=useText(),view=useWidgetView(id,condition);return view.status==='ready'?`${t.t('widget.members.count')} ${view.model.total}${t.t('widget.members.unit')}, ${t.t('widget.members.active',{n:view.model.membershipCount})}`:t.t(view.messageKey);}
export function MembersPanel(props:WidgetPanelProps) {
 const t=useText(),base=useT(),view=useWidgetView(id,props.condition);if(view.status!=='ready')return <StatePanel id={id} view={view} t={base} props={props}/>;
 const m=view.model,grades=['regular','frequent','occasional','inactive'] as const;
 const ending=m.rows.flatMap(r=>r.memberships.filter(ms=>ms.active&&ms.endingThisWeek).map(ms=>({r,ms})));
 const gradeRows=<ListBlock id={id}>{grades.map(g=><Row key={g} id={id} rowId={g} name={t.t(`widget.members.${g}`)} value={t.locale==='ko'?`${m.gradeCounts[g]}명`:String(m.gradeCounts[g])}/>)}</ListBlock>;
 const endingRows=<ListBlock id={id} title={t.locale==='ko'?`${t.t('widget.members.ending')} ${ending.length}개`:t.t('widget.members.ending')}>{ending.map(({r,ms})=><Row key={ms.membershipId} id={id} rowId={ms.membershipId} name={displayName(t,r)} value={t.locale==='ko'?`남은 ${ms.usesLeft??'—'}회 · ${t.format.date(ms.endsOn,'short')}까지`:`${ms.usesLeft??'—'} · ${t.format.date(ms.endsOn,'short')}`}/>)}</ListBlock>;
 return <PanelFrame id={id}><Body props={props} primary={<Kpi id={id} label={t.t('widget.members.count')} value={String(m.total)} unit={t.t('widget.members.unit')} sub={t.t('widget.members.active',{n:m.membershipCount})}/>} chart={props.width>1&&props.height>1?<GradeBar label={t.t('widget.members.grade')} segments={grades.map(g=>({label:t.t(`widget.members.${g}`),value:m.gradeCounts[g],display:String(m.gradeCounts[g])}))}/>:undefined} list={props.height===1?gradeRows:endingRows} secondary={props.width>=2&&props.height>=3?<ListBlock id={id} title={t.t('widget.members.lastVisit')}>{[...m.rows].sort((a,b)=>(b.lastVisit??'').localeCompare(a.lastVisit??'')).slice(0,6).map(r=><Row key={r.memberId} id={id} rowId={r.memberId} name={displayName(t,r)} value={r.lastVisit?t.format.date(r.lastVisit,'short'):'—'}/>)}</ListBlock>:undefined}/></PanelFrame>;
}

/**
 * DS 12.2 `danger` slot: the delete action is the last item of the panel body, a ghost destructive button. A member who still holds
 * 충전금·외상·회원권 shows the F-1 blocked pattern: the button stays focusable (aria-disabled) and the reason sits under it.
 */
function MemberDanger({row,host,close}:{row:Member;host:WidgetDetailProps['host'];close:()=>void}){
 const t=useText(),dispatch=useDataDispatch(),store=useWidgetDataStore();
 const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot),blockers=useMemo(()=>selectMemberDeleteBlockers(snapshot,row.memberId),[snapshot,row.memberId]);
 const [shown,setShown]=useState(false),[error,setError]=useState(''),reasonId=useId(),reasonRef=useRef<HTMLParagraphElement>(null);
 const remove=()=>{
  const r=dispatch({type:'members.delete',memberId:row.memberId});
  if(!r.ok){setError(r.reason==='MEMBER_HAS_OPEN_BALANCE'&&r.details?blockedReason(t,r.details as unknown as MemberDeleteBlockers):t.t(r.messageKey));return;}
  setError('');reportResult(host,r);close();
 };
 return blockers.blocked
  ?<>
   <ActionButton variant="ghost" className="mc-delete-blocked" data-blocked="true" aria-disabled="true" aria-describedby={reasonId} onClick={()=>{setShown(true);host.notify({kind:'error',messageKey:'data.management.error.MEMBER_HAS_OPEN_BALANCE'});/* the Notice below the panel resizes it, so scroll after that layout */requestAnimationFrame(()=>requestAnimationFrame(()=>reasonRef.current?.scrollIntoView?.({block:'nearest'})));}}><Icon name="trash"/>{t.t('widget.members.delete')}</ActionButton>
   <p ref={reasonRef} id={reasonId} className="mc-delete-reason" lang={t.locale} role={shown?'alert':undefined}>{blockedReason(t,blockers)}</p>
  </>
  :<>
   <ActionButton variant="ghost" onClick={remove}>{t.t('widget.members.delete')}</ActionButton>
   {error?<p role="alert" className="mc-delete-reason">{error}</p>:null}
  </>;
}

type Area='basic'|'grade'|'note';
function MemberSide({row,host,detailRef,openMember}:{row:Member;host:WidgetDetailProps['host'];detailRef:WidgetDetailProps['detailRef'];openMember:(memberId:string)=>void}){
 const t=useText(),dispatch=useDataDispatch(),[note,setNote]=useState(''),[errors,setErrors]=useState<Partial<Record<Area,string>>>({}),[memberName,setMemberName]=useState(''),[phone,setPhone]=useState(''),[editingNote,setEditingNote]=useState<string|null>(null),[editedNote,setEditedNote]=useState(''),[nameDirty,setNameDirty]=useState(false),[phoneDirty,setPhoneDirty]=useState(false),[gradeOpen,setGradeOpen]=useState(false),[sameNumber,setSameNumber]=useState<SameNumber|null>(null);
 const gradeOpener=useRef<HTMLButtonElement>(null);
 /** A refusal is shown under the action that caused it (not after the delete zone); a success clears that area. */
 const run=(c:Parameters<typeof dispatch>[0],area:Area)=>{const r=dispatch(c);if(!r.ok){setErrors(e=>({...e,[area]:refusalText(t,r)}));setSameNumber(area==='basic'?sameNumberOf(r):null);return false;}setErrors(e=>({...e,[area]:''}));if(area==='basic')setSameNumber(null);reportResult(host,r);return true;};
 const noteText=(body:Member['notes'][number]['body'])=>resolveDataText(t.t,body);
 return <div className="mc-detail mc-member-side" lang="ko">
  <h4>{t.t('widget.members.basic')}</h4>
  <p>{row.memberId} · {grade(t,row)}{row.manuallyGraded?` · ${t.t('widget.members.manual')}`:''}</p>
  <p>{row.phone}</p>
  <p>{t.t('widget.members.joined')} {t.format.date(row.joinedOn,'short')} · {t.t('widget.members.consent')} {t.t(row.consentSms?'widget.members.yes':'widget.members.no')}</p>
  <TextField label={t.t('widget.members.name')} value={memberName} onValueChange={value=>{setNameDirty(true);setMemberName(value);}} hint={displayName(t,row)}/>
  <TextField label={t.t('widget.members.phone')} value={phone} onValueChange={value=>{setPhoneDirty(true);setPhone(value);}} inputMode="numeric" hint={row.phone}/>
  <ActionButton onClick={()=>{if(run({type:'members.update',memberId:row.memberId,...(nameDirty?{name:memberName}:{}),...(phoneDirty?{phone}:{})},'basic')){setMemberName('');setPhone('');setNameDirty(false);setPhoneDirty(false);}}}>{t.t('widget.members.basicSave')}</ActionButton>
  {errors.basic?<p role="alert">{errors.basic}</p>:null}
  {sameNumber?<SameNumberRow t={t} match={sameNumber} onOpen={openMember}/>:null}
  <h4>{t.t('widget.members.history')}</h4>
  <p>{t.t('widget.members.lastVisit')} {row.lastVisit?t.format.date(row.lastVisit,'short'):'—'}</p>
  <p data-member-last-payment>{t.t('widget.members.lastPayment')} {row.lastPayment?`${row.lastPayment.at.slice(11,16)} ${formatPosMoney(row.lastPayment.amount)}`:t.t('widget.members.lastPaymentEmpty')}</p>
  <p>{t.t('widget.members.recent',{n:row.recentVisits})}</p>
  <p>{t.t('widget.members.reservations')}: {row.reservations.length===0?t.t('widget.members.noReservations'):row.reservations.map(r=>`${t.locale==='ko'?t.format.date(r.date,'short'):r.date} ${r.time} · ${r.partySize}명`).join(' / ')}</p>
  <p>{t.t('widget.members.received')}: {row.coupons.length===0?t.t('widget.members.noCoupons'):row.coupons.map(c=>c.coupon?resolveDataText(t.t,c.coupon.name):'—').join(' / ')}</p>
  <MemberMoneySection memberId={row.memberId} detailRef={detailRef} fallback={row.memberships.length===0?<p>{t.t('widget.members.noActive')}</p>:row.memberships.map(m=><section key={m.membershipId}><p>{m.product?t.t(m.product.nameKey):'—'} · {m.product?.kind==='period'?'구독권':'횟수권'} · {m.product?.kind==='period'?'':`남은 횟수 ${m.usesLeft??'—'}회 · `}{t.format.date(m.startsOn,'short')} ~ {t.format.date(m.endsOn,'short')}</p>{m.uses.map(u=><p key={u.useId}>{t.format.dateTime(u.usedAt)}{u.canceledAt?` · ${t.t('widget.members.usedCanceled')}`:''}</p>)}</section>)}/>
  <h4>{t.t('widget.members.grade')}</h4>
  <p className="mc-caption">{t.t('widget.members.gradeRule')}</p>
  <ActionButton ref={gradeOpener} variant="secondary" aria-expanded={gradeOpen} onClick={()=>setGradeOpen(!gradeOpen)}>{t.t('widget.members.chooseGrade')}</ActionButton>
  {gradeOpen?<ChipChoice label={t.t('widget.members.grade')} value={row.grade} options={(['regular','frequent','occasional','inactive'] as const).map(g=>({value:g,label:t.t(`widget.members.${g}`)}))} onChange={g=>{if(run({type:'members.setGrade',memberId:row.memberId,grade:g},'grade')){setGradeOpen(false);gradeOpener.current?.focus({preventScroll:true});}}}/>:null}
  <ActionButton variant="secondary" onClick={()=>run({type:'members.setGrade',memberId:row.memberId,grade:null},'grade')}>{t.t('widget.members.auto')}</ActionButton>
  {errors.grade?<p role="alert">{errors.grade}</p>:null}
  <h4>{t.t('widget.members.notes')}</h4>
  {row.notes.map(n=><div key={n.noteId} className="mc-member-note"><p>{noteText(n.body)}</p><div className="mc-actions"><ActionButton variant="ghost" aria-label={t.t('widget.members.edit',{name:noteText(n.body).slice(0,20)})} onClick={()=>{setEditingNote(n.noteId);setEditedNote(noteText(n.body));}}>{t.t('widget.members.editShort')}</ActionButton><ActionButton variant="ghost" aria-label={t.t('widget.members.remove',{name:noteText(n.body).slice(0,20)})} onClick={()=>run({type:'members.deleteNote',memberId:row.memberId,noteId:n.noteId},'note')}>{t.t('widget.members.removeShort')}</ActionButton></div></div>)}
  {editingNote?<InlineForm title={t.t('widget.members.editNote')} saveLabel={t.t('widget.members.updateNote')} onClose={()=>setEditingNote(null)} onSave={()=>{if(run({type:'members.updateNote',memberId:row.memberId,noteId:editingNote,body:editedNote},'note'))setEditingNote(null);}}><Textarea label={t.t('widget.members.editNote')} value={editedNote} onValueChange={setEditedNote}/></InlineForm>:null}
  <Textarea label={t.t('widget.members.addNote')} value={note} onValueChange={setNote}/>
  <ActionButton variant="secondary" onClick={()=>{if(run({type:'members.addNote',memberId:row.memberId,body:note},'note'))setNote('');}}>{t.t('widget.members.noteSave')}</ActionButton>
  {errors.note?<p role="alert">{errors.note}</p>:null}
  <ActionButton variant="secondary" onClick={()=>host.openLinked(row.couponRef)}>{t.t('widget.members.coupon')}</ActionButton>
 </div>;
}
export function MembersDetail({condition,host,detailRef}:WidgetDetailProps){
 const t=useText(),base=useT(),view=useWidgetView(id,condition),store=useWidgetDataStore(),dispatch=useDataDispatch();
 const [entry]=useState(()=>memberDetailEntry(detailRef));
 const [tab,setTab]=useState(entry.tab),[selected,setSelected]=useState<string|null>(entry.selected),[focus,setFocus]=useState<GridFocus>(null);
 const [sort,setSort]=useState<GridSort>({columnId:'lastVisit',direction:'desc'}),[query,setQuery]=useState('');
 const [gradeFilter,setGradeFilter]=useState(entry.grade),[adding,setAdding]=useState(entry.adding),[name,setName]=useState(entry.name),[phone,setPhone]=useState(entry.phone);
 const [error,setError]=useState(''),[sameNumber,setSameNumber]=useState<SameNumber|null>(null);const grid=useRef<DataGridHandle>(null);
 const rows=view.status==='ready'?selectMembers(store.getSnapshot(),{query,...(gradeFilter==='all'?{}:{grade:gradeFilter})}).rows.slice():[];if(sort){rows.sort((a,b)=>{const col=sort.columnId;const av=col==='name'?displayName(t,a):col==='lastVisit'?a.lastVisit??'':col==='grade'?grade(t,a):a.memberId,bv=col==='name'?displayName(t,b):col==='lastVisit'?b.lastVisit??'':col==='grade'?grade(t,b):b.memberId;return av.localeCompare(bv)*(sort.direction==='asc'?1:-1)||a.memberId.localeCompare(b.memberId);});}
 const memberships=rows.flatMap(row=>row.memberships.filter(m=>m.active).map(m=>({row,m})));const selectedRow=rows.find(r=>r.memberId===selected);const {root,obscured}=useSideGrid(!!selectedRow,JSON.stringify([view.status,t.locale,tab,query,gradeFilter,sort,adding,store.getSnapshot().revision]));
 if(selected&&!selectedRow)setSelected(null);
 // DS 12.1 column drop beside the panel: every detail of a member is in the panel, so the plain columns go first (ID and name stay).
 const memberCols=useMemo<GridColumn<Member>[]>(()=>[{id:'memberId',header:t.t('widget.members.memberId'),kind:'text',value:r=>r.memberId,minWidth:140,sortable:true},{id:'name',header:t.t('widget.members.name'),kind:'text',value:r=>displayName(t,r),minWidth:160,sortable:true},{id:'phone',header:t.t('widget.members.phone'),kind:'text',value:r=>r.phone,minWidth:180,dropOrder:3},{id:'grade',header:t.t('widget.members.grade'),kind:'status',value:r=>`${grade(t,r)}${r.manuallyGraded?` · ${t.t('widget.members.manual')}`:''}`,render:r=>gradeCell(t,r),minWidth:200,sortable:true,dropOrder:4},{id:'lastVisit',header:t.t('widget.members.lastVisit'),kind:'text',value:r=>r.lastVisit?(t.locale==='ko'?t.format.date(r.lastVisit,'short'):r.lastVisit):'—',minWidth:150,sortable:true,dropOrder:2},{id:'membership',header:t.t('widget.members.memberships'),kind:'number',value:r=>r.memberships.filter(m=>m.active).length,unit:t.t('widget.members.unitPass'),minWidth:120,dropOrder:1}],[t]);
 type MembershipRow=typeof memberships[number];const membershipCols=useMemo<GridColumn<MembershipRow>[]>(()=>[{id:'name',header:t.t('widget.members.member'),kind:'text',value:r=>displayName(t,r.row),minWidth:160},{id:'product',header:t.t('widget.members.product'),kind:'text',value:r=>r.m.product?t.t(r.m.product.nameKey):'—',minWidth:260},{id:'remaining',header:t.t('widget.members.remaining'),kind:'number',value:r=>r.m.product?.kind==='period'?'구독권':r.m.usesLeft??'—',render:r=>r.m.product?.kind==='period'?'구독권':r.m.usesLeft===null||r.m.usesLeft===undefined?'—':<>{r.m.usesLeft}<small> {t.t('widget.members.unitUses')}</small></>,minWidth:130,dropOrder:2},{id:'start',header:t.t('widget.members.start'),kind:'text',value:r=>t.locale==='ko'?t.format.date(r.m.startsOn,'short'):r.m.startsOn,minWidth:150,dropOrder:3},{id:'end',header:t.t('widget.members.end'),kind:'text',value:r=>t.locale==='ko'?t.format.date(r.m.endsOn,'short'):r.m.endsOn,render:r=>{const date=t.locale==='ko'?t.format.date(r.m.endsOn,'short'):r.m.endsOn;return r.m.endingThisWeek?<>{date} <StatusChip semantic="warning">{t.t('widget.members.endingSoon')}</StatusChip></>:date;},minWidth:230},{id:'lastUsed',header:t.t('widget.members.lastUsed'),kind:'text',value:r=>{const at=r.m.uses.filter(u=>!u.canceledAt).at(-1)?.usedAt;return at?`${t.format.date(at,'short')} ${t.format.time(at.slice(11))}`:'—';},minWidth:150,dropOrder:1}],[t]);
 if(view.status!=='ready')return <div className="mc-detail" data-widget="members"><DetailState id={id} view={view} t={base} host={host}/></div>;
 return <div ref={root} className="mc-detail mc-workspace" data-widget="members" lang="ko"><DetailTabs value={tab} onValueChange={setTab} label={t.t('widget.members.list')} tabs={[{value:'list',label:t.t('widget.members.list')},{value:'memberships',label:t.t('widget.members.memberships')}]}/>{tab==='memberships'?<p>{t.t('widget.members.active',{n:view.model.membershipCount})} · {t.t('widget.members.ending')} {view.model.endingThisWeekCount}{t.locale==='ko'?'개':''}</p>:null}{tab==='list'?<DataGrid id="members-grid" label={t.t('widget.members.list')} rows={rows} getRowId={r=>r.memberId} getRowLabel={r=>displayName(t,r)} columns={memberCols} query={query} searchLabel={t.t('widget.members.search')} searchPlaceholder={t.t('widget.members.search')} onQueryChange={setQuery} sort={sort} onSortChange={setSort} selectedRowId={selected} onSelectionChange={setSelected} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} ref={grid} obscuredCells={obscured} filters={{grade:gradeFilter}} renderFilters={()=> <ChipChoice label={t.t('widget.members.grade')} value={gradeFilter} onChange={setGradeFilter} options={(['all','regular','frequent','occasional','inactive'] as const).map(value=>({value,label:t.t(`widget.members.${value}`)}))}/>} addAction={{id:'add',label:t.t('widget.members.add'),onPress:()=>{setSelected(null);setAdding(true);}}} renderAddRow={()=>adding?<InlineForm title={t.t('widget.members.add')} onClose={()=>setAdding(false)} saveLabel={t.t('widget.members.save')} onSave={()=>{const r=dispatch({type:'members.create',name,phone,idempotencyKey:`member-create-${crypto.randomUUID()}`});if(!r.ok){setError(refusalText(t,r));setSameNumber(sameNumberOf(r));return;}reportResult(host,r);setAdding(false);setName('');setPhone('');setError('');setSameNumber(null);setQuery('');setGradeFilter('all');setSelected((r.value as {memberId:string}).memberId);}}><div className="mc-member-add"><TextField label={t.t('widget.members.name')} value={name} onValueChange={setName}/><TextField label={t.t('widget.members.phone')} value={phone} onValueChange={setPhone} inputMode="numeric"/></div>{error?<p role="alert">{error}</p>:null}{sameNumber?<SameNumberRow t={t} match={sameNumber} onOpen={id=>{setAdding(false);setSameNumber(null);setError('');setQuery('');setGradeFilter('all');setSelected(id);}}/>:null}</InlineForm>:null} emptyContent={t.t('widget.members.none')}/>:<DataGrid id="membership-grid" label={t.t('widget.members.memberships')} rows={memberships} getRowId={r=>r.m.membershipId} getRowLabel={r=>displayName(t,r.row)} columns={membershipCols} sort={null} onSortChange={()=>{}} selectedRowId={memberships.find(r=>r.row.memberId===selected)?.m.membershipId??null} onSelectionChange={key=>setSelected(memberships.find(r=>r.m.membershipId===key)?.row.memberId??null)} expandedRowIds={new Set()} focus={focus} onFocusChange={setFocus} ref={grid} obscuredCells={obscured} emptyContent={t.t('widget.members.noActive')}/>}

 <DetailSidePanel open={!!selectedRow} selectedRowId={selected} title={selectedRow?displayName(t,selectedRow):t.t('widget.members.list')} onClose={()=>setSelected(null)} returnFocusKey={selected??''} onRestoreFocus={key=>{const row=tab==='memberships'?memberships.find(r=>r.row.memberId===key)?.m.membershipId:key;restoreGrid(grid,row??'',tab==='list'?'memberId':'name',tab==='list'?rows.map(r=>r.memberId):memberships.map(r=>r.m.membershipId));}} danger={selectedRow?<MemberDanger key={selectedRow.memberId} row={selectedRow} host={host} close={()=>setSelected(null)}/>:undefined}>{selectedRow?<MemberSide key={selectedRow.memberId} row={selectedRow} host={host} detailRef={detailRef} openMember={id=>{setQuery('');setGradeFilter('all');setSelected(id);}}/>:null}</DetailSidePanel></div>;
}
