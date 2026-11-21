/** CCTV 현황 (F-221, 이전 F-31): hourly visits next to roster staffing, peak review mark.
 * 2026-11-12 병합(D-230): 목업은 반복 5 CCTV 현황 화면, 실시간은 반복 5-C 화면(`cctv-panel`·`cctv-detail`). 토글은 자세히 보기 머리와 실시간 패널에 있다. 목업 패널에는 두지 않는다(제목 줄에 두면 반복 5 sweep의 PAD·OVERFLOW 판정에 걸림). */
import { useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { QueryCondition, WidgetDetailProps, WidgetHost, WidgetPanelProps } from '../../../contracts';
import { useBundle, type MessageBundle, type Translator } from '../../../i18n';
import { CCTV_SNAPSHOT } from '../../../data/cctv';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { CctvHourRow, CustomerAnalysisModel, WidgetView } from '../../../data/models/types';
import { ActionButton, Badge, StatusBadge, StillFrame, DataGrid, renderStatusChip, type GridFocus, type GridSort, type GridColumn } from '../../../ui';
import { Bars, Body, DetailState, Kpi, ListBlock, Notes, PanelFrame, Row, StatePanel, reportResult, splitUnit, useT, type BarItem } from './shared';
import { CctvPlayback, setCctvMode, useCctvMode, useCctvView, type CctvMode } from '../../cctv';
import { NowNumbers, snapshotView } from '../../cctv/playback';
import { StayCharts } from '../../cctv/playback/StayCharts';
import { CctvAnalysisPanel } from './cctv-panel';
import { CctvAnalysisDetail, CctvLinks, type CctvLinksProps } from './cctv-detail';
import { ModeToggle, useCctvT } from './cctv-parts';

const ID = 'customer-analysis' as const;
const cameraCopy: MessageBundle<string> = { id:'widget.camera.screen', en:{}, 'zh-Hans':{}, 'zh-Hant':{}, ko:{
  'widget.customer-analysis.cameras.peakAdvice':'{hour}시대에 방문이 가장 많아요. 이 시간 근무 인원을 살펴보세요','widget.customer-analysis.cameras.camera':'카메라','widget.customer-analysis.cameras.connection':'연결 상태','widget.customer-analysis.cameras.operation':'작동 상태','widget.customer-analysis.cameras.analysis':'매장 분석','widget.customer-analysis.cameras.title':'CCTV 상태', 'widget.customer-analysis.cameras.images':'카메라 화면','widget.customer-analysis.cameras.example':'예시 정지 화면이에요',
  'widget.customer-analysis.cameras.connected':'연결됨', 'widget.customer-analysis.cameras.disconnected':'연결 끊김',
  'widget.customer-analysis.cameras.recording':'녹화 중', 'widget.customer-analysis.cameras.stopped':'녹화 중지',
  'widget.customer-analysis.cameras.close':'닫기', 'widget.customer-analysis.cameras.checked':'마지막 확인'
} };
const useCameraText = () => useBundle(cameraCopy, ...dataBundles);
const hh = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

function visitUnit(t: Translator, n: number) {
  return splitUnit(t.t('widget.customer-analysis.visitCount', { n }), t.format.number(n));
}
const staffText = (t: Translator, n: number | null): string => (n === null ? t.t('widget.customer-analysis.noStaff') : t.t('widget.customer-analysis.staffCount', { n }));
const visitsText = (t: Translator, row: CctvHourRow): string => (row.visits === null ? t.t('widget.customer-analysis.notCounted') : t.t('widget.customer-analysis.visitCount', { n: row.visits }));

export function useCustomerAnalysisSummary({ condition }: { featureId: string; condition: QueryCondition }): string {
  const t = useT();
  const c = useCctvT();
  const mode = useCctvMode();
  const live = useCctvView({ video: false });
  const view = useWidgetView(ID, condition);
  if (mode === 'live') {
    const conn = live.connection;
    if ((conn === 'live' || conn === 'reconnecting') && live.inStore !== null) return c('cctv.a11y.panelLive', { n: live.inStore });
    const state = conn === 'lost' ? `${c('cctv.conn.lost')}, ${c('cctv.conn.reconnect')}` : conn === 'server-down' ? `${c('cctv.conn.serverDown')}, ${c('cctv.conn.retry')}` : conn === 'none' ? `${c('cctv.conn.none')}, ${c('cctv.conn.connect')}` : c('cctv.conn.waiting');
    return `${t.t('widget.customer-analysis.title')}, ${c('cctv.mode.live')}, ${state}`;
  }
  if (view.status !== 'ready') return t.t(view.messageKey);
  const note = view.notes?.[0];
  // D-323: the headcount now leads; the day's visits follow as the secondary sentence.
  return [...(live.inStore === null ? [] : [`${c('cctv.nowNumbers.mock')} ${c('cctv.guests', { n: live.inStore })}`]), `${t.t('widget.customer-analysis.todayVisits')} ${t.t('widget.customer-analysis.visitCount', { n: view.model.totalVisits })}`, note ? t.t(note.messageKey) : t.t('widget.customer-analysis.estimate')].join(', ');
}

/** The hour whose visits and staffing the 2×1 / 1×2 block shows: the peak, else the last counted hour. */
const focusHour = (m: CustomerAnalysisModel): CctvHourRow | null => m.peak ?? null;

function RushRows({ t, model }: { readonly t: Translator; readonly model: CustomerAnalysisModel }) {
  const row = focusHour(model);
  return (
    <ListBlock id={ID} title={t.t('widget.customer-analysis.rush')}>
      {row ? <>
        <Row id={ID} rowId={`h${row.hour}-visits`} name={t.t('widget.customer-analysis.hourVisits', { hour: row.hour })} value={visitsText(t, row)} />
        <Row id={ID} rowId={`h${row.hour}-staff`} name={t.t('widget.customer-analysis.hourStaff', { hour: row.hour })} value={staffText(t, row.staff)} />
      </> : null}
    </ListBlock>
  );
}

export function barItems(t: Translator, model: CustomerAnalysisModel): BarItem[] {
  return model.hours.map((h) => ({
    key: `h${h.hour}`, value: h.visits, label: t.t('widget.customer-analysis.hourLabel', { hour: h.hour }), name: `${t.format.time(hh(h.hour))} ${visitsText(t, h)}, ${staffText(t, h.staff)}`,
    display: h.visits === null ? '—' : String(h.visits), sub: h.staff === null ? undefined : t.t('widget.customer-analysis.staffCount', { n: h.staff }),
    marker: h.status !== 'ok' ? 'gap' : h.reviewMarked ? 'review' : null, tone: model.peak?.hour === h.hour ? 'peak' : 'a',
  }));
}

/** 목업: 반복 5 CCTV 현황 패널 그대로(토글 없음). */
function MockCustomerAnalysisPanel(props:WidgetPanelProps) {
 const t=useT(),view=useWidgetView(ID,props.condition),cameraText=useCameraText(),c=useCctvT(),now=useCctvView({video:false});
 if(view.status!=='ready')return <StatePanel id={ID} view={view} t={t} props={props}/>;
 // D-323 (owner): the big number is the headcount right now (the same count the detail's 지금 숫자 starts from); the day's visits become the smaller secondary line.
 const m=view.model,{value,unit}=now.inStore===null?{value:'—',unit:''}:splitUnit(c('cctv.guests',{n:now.inStore}),String(now.inStore)),visits=`${t.t('widget.customer-analysis.todayVisits')} ${t.t('widget.customer-analysis.visitCount',{n:m.totalVisits})}`,off=m.cameras.filter(c=>c.connection==='disconnected').length,sub=off>0?t.t('widget.customer-analysis.cameras.warning',{count:off}):t.t('widget.customer-analysis.cameras.normal',{count:m.cameras.length}),warnInLabel=off>0,nowLabel=c('cctv.nowNumbers.mock');
 const still=<div data-drop="8"><StillFrame name={resolveDataText(cameraText.t,m.cameras[0]!.name)} scene="entrance"/></div>;
 const bars=<Bars items={barItems(t,m)} max={Math.max(...m.hours.map(h=>h.visits??0),1)} label={t.t('widget.customer-analysis.chartLabel')}/>;
 const cameras=<ListBlock id={ID}>{m.cameras.map(c=><Row key={c.cameraId} id={ID} rowId={c.cameraId} name={resolveDataText(cameraText.t,c.name)} value={cameraText.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected')}/>)}</ListBlock>;
 return <PanelFrame id={ID}><Body props={props} primary={<Kpi id={ID} label={warnInLabel?`${nowLabel}\u00A0· ${sub}`:nowLabel} value={value} unit={unit} longest="888" sub={visits} subLang="ko" extra={view.variant==='camera-disconnected'?t.t('data.state.customer-analysis.gaps'):view.notes?.[0]?t.t(view.notes[0].messageKey):off>0?undefined:sub}/>} chart={props.width>1&&props.height>1?still:undefined} list={props.height===1?<RushRows t={t} model={m}/>:props.width===1?cameras:props.height>=3||props.width>=3?<div className="mc-camera-chart">{bars}<RushRows t={t} model={m}/></div>:undefined}/></PanelFrame>;
}

/** Empty / error view of the detail. An empty view that has no action of its own (예시 `집계 불가`) gets the one next step: check the camera connection, which lives in the 실시간 view (H1). */
function CctvDetailState({ view, t, host, live }: { readonly view: Exclude<WidgetView<unknown>, { status: 'ready' }>; readonly t: Translator; readonly host: WidgetHost; readonly live: boolean }) {
  if (view.status !== 'empty' || view.actionKey) return <DetailState id={ID} view={view} t={t} host={host} />;
  return <div className="mc-detail-state" data-slot={`${ID}.state.message`} data-tone="info">
    <p role="status">{t.t(view.messageKey)}</p>
    {live ? null : <ActionButton variant="secondary" data-slot={`${ID}.state.action`} onClick={() => setCctvMode('live')}>{t.t('widget.customer-analysis.checkCamera')}</ActionButton>}
  </div>;
}

function DisconnectedCameraView({ t }: { readonly t: Translator }) {
  const playbackText = useCctvT();
  const view = snapshotView();
  return <div className="cctv-playback" lang={t.locale}>
    <div className="cctv-stage-row">
      <div className="cctv-stage-col">
        <div className="cctv-stage mc-camera-unavailable">{t.t('widget.customer-analysis.cameras.offlineFrame')}</div>
      </div>
      <div className="cctv-side">
        <p className="cctv-estimate">{playbackText('cctv.estimateNote')}</p>
        <NowNumbers view={view} time={CCTV_SNAPSHOT.t} duration={CCTV_SNAPSHOT.totalVideoSeconds} />
      </div>
    </div>
    <StayCharts view={view} />
    <p className="cctv-fake">{playbackText('cctv.footer.mock')}</p>
  </div>;
}

/** 목업: 반복 5 CCTV 현황 자세히 보기와 카페 영상 재생. */
function MockCustomerAnalysisDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  // N19 deep link: a chat hand-off can open the detail with one hour already selected.
  const [picked, setPicked] = useState<number | null>(detailRef?.hour ?? null);
  const [sending, setSending] = useState(false);
  const [cameraFocus,setCameraFocus]=useState<GridFocus>(null),[cameraSort,setCameraSort]=useState<GridSort>(null);
  const cameraText = useCameraText();
  const cameraColumns = useMemo<GridColumn<CustomerAnalysisModel['cameras'][number]>[]>(() => [
         {id:'camera',header:cameraText.t('widget.customer-analysis.cameras.camera'),kind:'text',value:c=>resolveDataText(cameraText.t,c.name),minWidth:200,sortable:true},
         {id:'connection',header:cameraText.t('widget.customer-analysis.cameras.connection'),kind:'status',value:c=>cameraText.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected'),render:c=>renderStatusChip(cameraText.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected'),c.connection==='connected'?'done':'warning'),minWidth:200},
         {id:'operation',header:cameraText.t('widget.customer-analysis.cameras.operation'),kind:'status',value:c=>cameraText.t(c.operation==='recording'?'widget.customer-analysis.cameras.recording':'widget.customer-analysis.cameras.stopped'),render:c=>renderStatusChip(cameraText.t(c.operation==='recording'?'widget.customer-analysis.cameras.recording':'widget.customer-analysis.cameras.stopped'),c.operation==='recording'?'done':'paused'),minWidth:200},
         {id:'checked',header:cameraText.t('widget.customer-analysis.cameras.checked'),kind:'text',value:c=>`${cameraText.format.date(c.lastCheckedAt,'short')} ${cameraText.format.time(c.lastCheckedAt.slice(11))}`,minWidth:260,sortable:true},
        ], [cameraText]);
  if (view.status !== 'ready') return <div className="mc-detail" data-widget={ID}><CctvDetailState view={view} t={t} host={host} live={false} /></div>;
  const m = view.model;
  const disconnected = m.cameras.filter(camera => camera.connection === 'disconnected');
  const zero = m.totalVisits === 0;
  const notes = [
    ...(view.notes ?? []),
    ...(disconnected.length ? [{ messageKey: 'widget.customer-analysis.cameras.offlineNotice', params: { cameras: disconnected.map(camera => resolveDataText(cameraText.t, camera.name)).join(', '), count: disconnected.length } }] : []),
    ...(zero ? [{ messageKey: 'widget.customer-analysis.noVisits' }] : []),
  ];
  const selected = m.hours.find((h) => h.hour === (picked ?? m.peak?.hour ?? -1)) ?? null;
  const max = Math.max(...m.hours.map((h) => h.visits ?? 0), 1);
  const gaps = m.hours.filter((h) => h.status !== 'ok');
  const mark = () => {
    if (!selected || sending || selected.reviewMarked) return;
    setSending(true);
    reportResult(host, dispatch({ type: 'cctv.markPeakForReview', date: m.date, hour: selected.hour }));
    setSending(false);
  };
  const total = visitUnit(t, m.totalVisits);
  return (
    <div className="mc-detail mc-workspace" data-widget={ID}>
      <div className="mc-tools">
        <p className="mc-tools__date">{t.format.date(m.date, 'long')}</p>
        <p className="mc-caption">{t.t('widget.customer-analysis.coverage', { range: t.format.hourRange(m.coverage.startHour, m.coverage.endHour) })}</p>
        {m.staffSourceKey ? <p className="mc-caption">{t.t('widget.customer-analysis.sourceNote', { source: t.t(m.staffSourceKey) })}</p> : null}
      </div>
      <Notes notes={notes} t={t} />
      {zero ? <div className="mc-zero-visits"><ActionButton variant="secondary" data-slot={`${ID}.state.action`} onClick={() => setCctvMode('live')}>{t.t('widget.customer-analysis.checkCamera')}</ActionButton></div> : null}
      <section className="mc-grid-region" lang="ko">
        <h3>{cameraText.t('widget.customer-analysis.cameras.title')}</h3>
        <DataGrid id="camera-grid" label={cameraText.t('widget.customer-analysis.cameras.title')} rows={[...m.cameras].sort((a,b)=>cameraSort?(cameraSort.columnId==='checked'?a.lastCheckedAt.localeCompare(b.lastCheckedAt):resolveDataText(cameraText.t,a.name).localeCompare(resolveDataText(cameraText.t,b.name)))*(cameraSort.direction==='asc'?1:-1):0)} columns={cameraColumns} getRowId={c=>c.cameraId} getRowLabel={c=>resolveDataText(cameraText.t,c.name)} sort={cameraSort} onSortChange={setCameraSort} selectedRowId={null} expandedRowIds={new Set()} focus={cameraFocus} onFocusChange={setCameraFocus} emptyContent={t.t('widget.customer-analysis.noStaff')}/>

      </section>
      <div className="mc-grid-context">
      <section lang="ko" aria-label={cameraText.t('widget.customer-analysis.cameras.images')}>
        <h3>{cameraText.t('widget.customer-analysis.cameras.images')}</h3>
        {disconnected.length ? <DisconnectedCameraView t={t} /> : <CctvPlayback />}
      </section>
      <div lang="ko"><h3>{cameraText.t('widget.customer-analysis.cameras.analysis')}</h3>{m.peak?<p>{cameraText.t('widget.customer-analysis.cameras.peakAdvice',{hour:m.peak.hour})}</p>:null}</div>
      <dl className="mc-kpis">
        <div><dt>{t.t('widget.customer-analysis.todayVisits')}</dt><dd data-slot={`${ID}.metric.value`}>{total.value}<small>{total.unit}</small></dd><p>{t.t('widget.customer-analysis.notHeadcount')}</p></div>
        <div><dt>{t.t('widget.customer-analysis.peakHour')}</dt><dd>{m.peak ? t.format.hourRange(m.peak.hour, m.peak.hour + 1) : '—'}</dd></div>
        <div><dt>{t.t('widget.customer-analysis.staffOnShift')}</dt><dd>{m.peak ? staffText(t, m.peak.staff) : '—'}</dd></div>
      </dl>
      <div className="mc-columns">
        <section aria-label={t.t('widget.customer-analysis.chartLabel')} className="mc-chart-card">
          <h3 className="mc-h3">{t.t('widget.customer-analysis.chartLabel')}</h3>
          <Bars items={barItems(t, m)} max={max} label={t.t('widget.customer-analysis.chartLabel')} height="tall" onSelect={(key) => setPicked(Number(key.slice(1)))} selectedKey={selected ? `h${selected.hour}` : null} />
          <p className="mc-caption">{t.t('widget.customer-analysis.pickHint')}</p>
          {gaps.length ? <p className="mc-caption mc-flag"><span aria-hidden="true">△ </span>{t.t('widget.customer-analysis.missingHours', { hours: gaps.map((g) => t.format.time(hh(g.hour))).join(', ') })}</p> : null}
        </section>
        <section className="mc-side" aria-label={t.t('widget.customer-analysis.selected')}>
          <h3 className="mc-h3">{t.t('widget.customer-analysis.selected')}</h3>
          {selected ? (
            <div className="mc-compare" data-slot={`${ID}.card`}>
              <p className="mc-compare__range">{t.format.hourRange(selected.hour, selected.hour + 1)}</p>
              <p className="mc-compare__line">{selected.visits === null ? t.t('widget.customer-analysis.notCounted') : t.t('widget.customer-analysis.compare', { visits: selected.visits, staff: selected.staff ?? 0 })}</p>
              {selected.visits !== null && selected.staff === null ? <p className="mc-caption">{t.t('widget.customer-analysis.noStaff')}</p> : null}
              {selected.status === 'partial' ? <Badge>{t.t('widget.customer-analysis.partlyCounted')}</Badge> : null}
              {selected.reviewMarked ? <StatusBadge kind="reviewed" label={t.t('widget.customer-analysis.reviewBadge')} tone="warning" /> : null}
              <ActionButton disabled={selected.reviewMarked || selected.visits === null || sending} onClick={mark}>{t.t('widget.customer-analysis.markReview')}</ActionButton>
            </div>
          ) : null}
          <table className="mc-table" aria-label={t.t('widget.customer-analysis.chartLabel')}>
            <thead><tr><th scope="col">{t.t('widget.customer-analysis.colHour')}</th><th scope="col">{t.t('widget.customer-analysis.colVisits')}</th><th scope="col">{t.t('widget.customer-analysis.colStaff')}</th><th scope="col">{t.t('widget.customer-analysis.colStatus')}</th></tr></thead>
            <tbody>
              {m.hours.map((h) => (
                <tr key={h.hour} data-row-id={`h${h.hour}`} data-selected={selected?.hour === h.hour ? 'true' : undefined}>
                  <th scope="row">{t.format.time(hh(h.hour))}</th>
                  <td>{h.visits === null ? '—' : h.visits}</td>
                  <td>{h.staff === null ? '—' : h.staff}</td>
                  <td>{h.status === 'none' ? t.t('widget.customer-analysis.notCounted') : h.status === 'partial' ? t.t('widget.customer-analysis.partlyCounted') : h.reviewMarked ? t.t('widget.customer-analysis.reviewBadge') : m.peak?.hour === h.hour ? t.t('widget.customer-analysis.peakHour') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      </div>
    </div>
  );
}

function MockDetailControls() {
  const [head, setHead] = useState<Element | null>(null);
  useLayoutEffect(() => { setHead(document.querySelector('[data-detail-header-slot="customer-analysis"]')); }, []); // eslint-disable-line react-hooks/set-state-in-effect
  const controls = <ModeToggle mode="mock" onChange={(m: CctvMode) => setCctvMode(m)} />;
  return head ? createPortal(controls, head) : <div className="cc-detail__head">{controls}</div>;
}

function LiveCustomerAnalysisPanel(props: WidgetPanelProps) {
  const t = useT();
  const view = useWidgetView(ID, props.condition);
  return <CctvAnalysisPanel {...props} model={view.status === 'ready' ? view.model : null} note={view.status === 'ready' && view.notes?.[0] ? t.t(view.notes[0].messageKey) : null} />;
}

/** SCR-345 / SCR-221: 실시간이면 반복 5-C 패널, 목업이면 반복 5 CCTV 현황 패널. */
export function CustomerAnalysisPanel(props: WidgetPanelProps) {
  return useCctvMode() === 'live' ? <LiveCustomerAnalysisPanel {...props} /> : <MockCustomerAnalysisPanel {...props} />;
}

/** SCR-346 / 반복 5: 실시간이면 영상·숫자 위에 하루 기록(반복 5-C), 목업이면 CCTV 현황 자세히 보기와 머리의 토글(목업에서 실시간으로 바꾸는 곳). */
export function CustomerAnalysisDetail(props: WidgetDetailProps & CctvLinksProps) {
  if (useCctvMode() === 'live') return <CctvAnalysisDetail {...props} record={<DayRecord condition={props.condition} host={props.host} detailRef={props.detailRef} />} />;
  return <><MockDetailControls /><CctvLinks linkedTables={props.linkedTables} linkPicker={props.linkPicker} linkZones={props.linkZones} linkError={props.linkError}/><MockCustomerAnalysisDetail {...props} /></>;
}

/** 실시간 모드의 하루 기록(반복 5-C T-075 그대로). */
function DayRecord({ condition, host, detailRef }: Pick<WidgetDetailProps, 'condition' | 'host' | 'detailRef'>) {
  const t = useT();
  const view = useWidgetView(ID, condition);
  const dispatch = useDataDispatch();
  const [picked, setPicked] = useState<number | null>(detailRef?.hour ?? null);
  const [sending, setSending] = useState(false);
  if (view.status !== 'ready') return <div className="mc-detail" data-widget={ID}><CctvDetailState view={view} t={t} host={host} live /></div>;
  const m = view.model;
  const selected = m.hours.find((h) => h.hour === (picked ?? m.peak?.hour ?? -1)) ?? null;
  const max = Math.max(...m.hours.map((h) => h.visits ?? 0), 1);
  const gaps = m.hours.filter((h) => h.status !== 'ok');
  const mark = () => {
    if (!selected || sending || selected.reviewMarked) return;
    setSending(true);
    reportResult(host, dispatch({ type: 'cctv.markPeakForReview', date: m.date, hour: selected.hour }));
    setSending(false);
  };
  const total = visitUnit(t, m.totalVisits);
  return (
    <div className="mc-detail" data-widget={ID}>
      <div className="mc-tools">
        <p className="mc-tools__date">{t.format.date(m.date, 'long')}</p>
        <p className="mc-caption">{t.t('widget.customer-analysis.coverage', { range: t.format.hourRange(m.coverage.startHour, m.coverage.endHour) })}</p>
        {m.staffSourceKey ? <p className="mc-caption">{t.t('widget.customer-analysis.sourceNote', { source: t.t(m.staffSourceKey) })}</p> : null}
      </div>
      <Notes notes={view.notes} t={t} />
      <dl className="mc-kpis">
        <div><dt>{t.t('widget.customer-analysis.todayVisits')}</dt><dd data-slot={`${ID}.metric.value`}>{total.value}<small>{total.unit}</small></dd><p>{t.t('widget.customer-analysis.notHeadcount')}</p></div>
        <div><dt>{t.t('widget.customer-analysis.peakHour')}</dt><dd>{m.peak ? t.format.hourRange(m.peak.hour, m.peak.hour + 1) : '—'}</dd></div>
        <div><dt>{t.t('widget.customer-analysis.staffOnShift')}</dt><dd>{m.peak ? staffText(t, m.peak.staff) : '—'}</dd></div>
      </dl>
      <div className="mc-columns">
        <section aria-label={t.t('widget.customer-analysis.chartLabel')} className="mc-chart-card">
          <h3 className="mc-h3">{t.t('widget.customer-analysis.chartLabel')}</h3>
          <Bars items={barItems(t, m)} max={max} label={t.t('widget.customer-analysis.chartLabel')} height="tall" onSelect={(key) => setPicked(Number(key.slice(1)))} selectedKey={selected ? `h${selected.hour}` : null} />
          <p className="mc-caption">{t.t('widget.customer-analysis.pickHint')}</p>
          {gaps.length ? <p className="mc-caption mc-flag"><span aria-hidden="true">△ </span>{t.t('widget.customer-analysis.missingHours', { hours: gaps.map((g) => t.format.time(hh(g.hour))).join(', ') })}</p> : null}
        </section>
        <section className="mc-side" aria-label={t.t('widget.customer-analysis.selected')}>
          <h3 className="mc-h3">{t.t('widget.customer-analysis.selected')}</h3>
          {selected ? (
            <div className="mc-compare" data-slot={`${ID}.card`}>
              <p className="mc-compare__range">{t.format.hourRange(selected.hour, selected.hour + 1)}</p>
              <p className="mc-compare__line">{selected.visits === null ? t.t('widget.customer-analysis.notCounted') : t.t('widget.customer-analysis.compare', { visits: selected.visits, staff: selected.staff ?? 0 })}</p>
              {selected.visits !== null && selected.staff === null ? <p className="mc-caption">{t.t('widget.customer-analysis.noStaff')}</p> : null}
              {selected.status === 'partial' ? <Badge>{t.t('widget.customer-analysis.partlyCounted')}</Badge> : null}
              {selected.reviewMarked ? <StatusBadge kind="reviewed" label={t.t('widget.customer-analysis.reviewBadge')} tone="warning" /> : null}
              <ActionButton disabled={selected.reviewMarked || selected.visits === null || sending} onClick={mark}>{t.t('widget.customer-analysis.markReview')}</ActionButton>
            </div>
          ) : null}
          <table className="mc-table" aria-label={t.t('widget.customer-analysis.chartLabel')}>
            <thead><tr><th scope="col">{t.t('widget.customer-analysis.colHour')}</th><th scope="col">{t.t('widget.customer-analysis.colVisits')}</th><th scope="col">{t.t('widget.customer-analysis.colStaff')}</th><th scope="col">{t.t('widget.customer-analysis.colStatus')}</th></tr></thead>
            <tbody>
              {m.hours.map((h) => (
                <tr key={h.hour} data-row-id={`h${h.hour}`} data-selected={selected?.hour === h.hour ? 'true' : undefined}>
                  <th scope="row">{t.format.time(hh(h.hour))}</th>
                  <td>{h.visits === null ? '—' : h.visits}</td>
                  <td>{h.staff === null ? '—' : h.staff}</td>
                  <td>{h.status === 'none' ? t.t('widget.customer-analysis.notCounted') : h.status === 'partial' ? t.t('widget.customer-analysis.partlyCounted') : h.reviewMarked ? t.t('widget.customer-analysis.reviewBadge') : m.peak?.hour === h.hour ? t.t('widget.customer-analysis.peakHour') : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <p className="mc-caption" data-slot={`${ID}.metric.secondary`}>{t.t('widget.customer-analysis.notHeadcount')}</p>
    </div>
  );
}
