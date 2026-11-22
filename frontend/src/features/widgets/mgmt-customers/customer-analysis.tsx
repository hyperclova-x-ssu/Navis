/** CCTV 현황 (F-221, 이전 F-31): hourly visits next to roster staffing, peak review mark.
 * 2026-11-12 병합(D-230): 목업은 반복 5 CCTV 현황 화면, 실시간은 반복 5-C 화면(`cctv-panel`·`cctv-detail`). 토글은 자세히 보기 머리와 실시간 패널에 있다. 목업 패널에는 두지 않는다(제목 줄에 두면 반복 5 sweep의 PAD·OVERFLOW 판정에 걸림). */
import { useMemo, useState, useSyncExternalStore } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetHost, WidgetPanelProps } from '../../../contracts';
import type { Translator } from '../../../i18n';
import { CCTV_SNAPSHOT } from '../../../data/cctv';
import { resolveDataText } from '../../../data/widget-data';
import { useDataExecute, useRealPort, useWidgetDataStore, useWidgetView } from '../../../data/react';
import type { CommandReceipt } from '../../../data/reality/00';
import type { CctvHourRow, CustomerAnalysisModel, WidgetView } from '../../../data/models/types';
import { staffLocalTimestamp } from '../../../data/iteration7/staff/clock';
import { selectStaffSchedule } from '../../../data/iteration7/staff/selectors';
import { ActionButton, Badge, StatusBadge, DataGrid, renderStatusChip, useUi, type GridFocus, type GridSort, type GridColumn } from '../../../ui';
import { Bars, Body, DetailState, Kpi, ListBlock, Notes, PanelFrame, Row, StatePanel, splitUnit, useT, type BarItem } from './shared';
import { CctvPlayback, PanelVideo, setCctvMode, useCctvMode, useCctvView } from '../../cctv';
import { createStoreZonesApi } from '../../cctv/zones/real-api';
import { NowNumbers, snapshotView } from '../../cctv/playback';
import { StayCharts } from '../../cctv/playback/StayCharts';
import { CctvAnalysisPanel } from './cctv-panel';
import { CctvAnalysisDetail, CctvLinks, type CctvLinksProps } from './cctv-detail';
import { DetailModeToggle, useCctvT } from './cctv-parts';

const ID = 'customer-analysis' as const;

/**
 * The one view of this widget in both data modes (D-355): the original screens read the same model. Over the service the model comes from the
 * `cctvHourly` / `cctvCamera` rows the insight adapter fills, and one line says the hourly numbers are observed in-store counts, not visits.
 */
function useAnalysisView(condition: QueryCondition) {
  const view = useWidgetView(ID, condition);
  const http = useRealPort()?.mode('cctv') === 'http';
  return useMemo(() => view.status === 'ready' && http
    ? { ...view, notes: [...(view.notes ?? []), { messageKey: 'widget.customer-analysis.observedNote' }] }
    : view, [view, http]);
}

/** The peak-review mark: one command, answered after the receipt over the service (the notice keeps the receipt's own undo deadline) and at once over the fixture. */
function useMarkPeak(host: WidgetHost) {
  const execute = useDataExecute();
  const [sending, setSending] = useState(false);
  const mark = async (date: string, hour: number) => {
    if (sending) return;
    setSending(true);
    try {
      const result = await execute({ type: 'cctv.markPeakForReview', date, hour });
      if (!result.ok) { host.notify({ kind: 'error', messageKey: result.messageKey }); return; }
      const receipt = result.value as Partial<CommandReceipt> | undefined;
      if (result.noticeKey) host.notify({ kind: 'success', messageKey: result.noticeKey, ...(result.params ? { params: result.params } : {}),
        ...(result.undoToken ? { undoToken: result.undoToken } : {}), ...(result.undoToken && receipt?.undoUntil ? { undoUntil: receipt.undoUntil } : {}) });
    } finally { setSending(false); }
  };
  return { sending, mark };
}
const hh = (hour: number): string => `${String(hour).padStart(2, '0')}:00`;

function visitUnit(t: Translator, n: number) {
  return splitUnit(t.t('widget.customer-analysis.visitCount', { n }), t.format.number(n));
}
const staffText = (t: Translator, n: number | null): string => (n === null ? t.t('widget.customer-analysis.noStaff') : t.t('widget.customer-analysis.staffCount', { n }));
const visitsText = (t: Translator, row: CctvHourRow): string => (row.visits === null ? t.t('widget.customer-analysis.notCounted') : t.t('widget.customer-analysis.visitCount', { n: row.visits }));

function useStaffingMetric(model: CustomerAnalysisModel | null) {
  const store = useWidgetDataStore();
  if (model?.peak) return model.peak.staff;
  const snapshot = store.getSnapshot();
  const { staffCalendarAsOf, realInsight } = snapshot.tables;
  if (!model || !realInsight || !staffCalendarAsOf) return null;
  const { date, time } = staffLocalTimestamp(realInsight.asOf);
  const { rows } = selectStaffSchedule(snapshot, { startDate: date, endDate: date });
  return new Set(rows.filter(row => row.kind === 'work' && row.start! <= time && time < row.end!).map(row => row.staffId)).size;
}

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

function RushRows({ t, model, compact }: { readonly t: Translator; readonly model: CustomerAnalysisModel; readonly compact?: boolean }) {
  const row = focusHour(model);
  if (!row) return null;
  return (
    <ListBlock id={ID} title={compact ? undefined : t.t('widget.customer-analysis.rush')}>
        <Row id={ID} rowId={`h${row.hour}-visits`} name={t.t('widget.customer-analysis.hourVisits', { hour: row.hour })} value={visitsText(t, row)} />
        <Row id={ID} rowId={`h${row.hour}-staff`} name={t.t('widget.customer-analysis.hourStaff', { hour: row.hour })} value={staffText(t, row.staff)} />
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

function SampleCameraPanel({ editing }: { readonly editing: boolean }) {
  const t = useCctvT();
  const { reducedMotion } = useUi();
  return <div className="mc-cctv-preview">
    <PanelVideo paused={editing} reducedMotion={reducedMotion} />
    <span className="mc-cctv-preview__badge"><Badge>{t('cctv.example')}</Badge></span>
  </div>;
}

/** Expanded example panels show the clip beside the existing camera and visit summaries. */
function MockCustomerAnalysisPanel(props:WidgetPanelProps) {
 const t=useT(),view=useWidgetView(ID,props.condition),c=useCctvT(),now=useCctvView({video:false});
 const http = useRealPort()?.mode('cctv') === 'http';
 const expanded = props.width > 1 && props.height > 1;
 const clip = expanded && view.variant !== 'camera-disconnected' ? <SampleCameraPanel editing={props.editing} /> : undefined;
 if(view.status!=='ready') {
   const state = <StatePanel id={ID} view={view} t={t} props={props}/>;
   return http && clip ? <div className="mc-cctv-preview-state">{clip}{state}</div> : state;
 }
 // D-323 (owner): the big number is the headcount right now (the same count the detail's 지금 숫자 starts from); the day's visits become the smaller secondary line.
 const m=view.model,{value,unit}=now.inStore===null?{value:'—',unit:''}:splitUnit(c('cctv.guests',{n:now.inStore}),String(now.inStore)),visits=`${t.t('widget.customer-analysis.todayVisits')} ${t.t('widget.customer-analysis.visitCount',{n:m.totalVisits})}`,off=m.cameras.filter(c=>c.connection==='disconnected').length,sub=off>0?t.t('widget.customer-analysis.cameras.warning',{count:off}):t.t('widget.customer-analysis.cameras.normal',{count:m.cameras.length}),warnInLabel=off>0,nowLabel=c('cctv.nowNumbers.mock');
 const bars=<Bars items={barItems(t,m)} max={Math.max(...m.hours.map(h=>h.visits??0),1)} label={t.t('widget.customer-analysis.chartLabel')}/>;
 const cameras=<ListBlock id={ID}>{m.cameras.map(c=><Row key={c.cameraId} id={ID} rowId={c.cameraId} name={resolveDataText(t.t,c.name)} value={t.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected')}/>)}</ListBlock>;
 // D-333: a wide card 4 rows high has room for what the one-line camera sentence summarizes: each camera with its connection and whether it records (the model's own fields).
 const tall=props.width>=3&&props.height>=4;
 const cameraStatus=tall?<ListBlock id={ID} title={t.t('widget.customer-analysis.cameras.title')}>{m.cameras.map(c=><Row key={c.cameraId} id={ID} rowId={c.cameraId} name={resolveDataText(t.t,c.name)} note={t.t(c.operation==='recording'?'widget.customer-analysis.cameras.recording':'widget.customer-analysis.cameras.stopped')} value={t.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected')}/>)}</ListBlock>:null;
 return <PanelFrame id={ID}><Body props={props} primary={<Kpi id={ID} label={warnInLabel?`${nowLabel}\u00A0· ${sub}`:nowLabel} value={value} unit={unit} longest="888" sub={visits} subLang="ko" extra={view.variant==='camera-disconnected'?t.t('data.state.customer-analysis.gaps'):view.notes?.[0]?t.t(view.notes[0].messageKey):off>0||!m.cameras.length?undefined:sub}/>} chart={clip} list={props.height===1?<RushRows t={t} model={m} compact/>:props.width===1?cameras:props.height>=3||props.width>=3?<div className="mc-camera-chart">{bars}<RushRows t={t} model={m}/>{cameraStatus}</div>:undefined}/></PanelFrame>;
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
        <NowNumbers view={view} time={CCTV_SNAPSHOT.t} duration={CCTV_SNAPSHOT.totalVideoSeconds} />
      </div>
    </div>
    <StayCharts view={view} />
    <p className="cctv-fake">{playbackText('cctv.footer.mock')}</p>
  </div>;
}

/** 목업: 반복 5 CCTV 현황 자세히 보기와 카페 영상 재생. */
function MockCustomerAnalysisDetail({ condition, host, detailRef, ...links }: WidgetDetailProps & CctvLinksProps) {
  const t = useT();
  const view = useAnalysisView(condition);
  const staff = useStaffingMetric(view.status === 'ready' ? view.model : null);
  const http = useRealPort()?.mode('cctv') === 'http';
  const { sending, mark: markPeak } = useMarkPeak(host);
  // N19 deep link: a chat hand-off can open the detail with one hour already selected.
  const [picked, setPicked] = useState<number | null>(detailRef?.hour ?? null);
  const [cameraFocus,setCameraFocus]=useState<GridFocus>(null),[cameraSort,setCameraSort]=useState<GridSort>(null);
  const cameraColumns = useMemo<GridColumn<CustomerAnalysisModel['cameras'][number]>[]>(() => [
         {id:'camera',header:t.t('widget.customer-analysis.cameras.camera'),kind:'text',value:c=>resolveDataText(t.t,c.name),minWidth:200,sortable:true},
         {id:'connection',header:t.t('widget.customer-analysis.cameras.connection'),kind:'status',value:c=>t.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected'),render:c=>renderStatusChip(t.t(c.connection==='connected'?'widget.customer-analysis.cameras.connected':'widget.customer-analysis.cameras.disconnected'),c.connection==='connected'?'done':'warning'),minWidth:200},
         {id:'operation',header:t.t('widget.customer-analysis.cameras.operation'),kind:'status',value:c=>t.t(c.operation==='recording'?'widget.customer-analysis.cameras.recording':'widget.customer-analysis.cameras.stopped'),render:c=>renderStatusChip(t.t(c.operation==='recording'?'widget.customer-analysis.cameras.recording':'widget.customer-analysis.cameras.stopped'),c.operation==='recording'?'done':'paused'),minWidth:200},
         {id:'checked',header:t.t('widget.customer-analysis.cameras.checked'),kind:'text',value:c=>`${t.format.date(c.lastCheckedAt,'short')} ${t.format.time(c.lastCheckedAt.slice(11))}`,minWidth:260,sortable:true},
        ], [t]);
  const footage = <section aria-label={t.t('widget.customer-analysis.cameras.images')}>
    {view.variant === 'camera-disconnected' ? <DisconnectedCameraView t={t} /> : <CctvPlayback />}
  </section>;
  if (view.status !== 'ready') return <div className="mc-detail" data-widget={ID}>
    {http ? footage : null}
    <CctvLinks {...links} />
    <CctvDetailState view={view} t={t} host={host} live={false} />
  </div>;
  const m = view.model;
  const disconnected = m.cameras.filter(camera => camera.connection === 'disconnected');
  const zero = m.totalVisits === 0;
  const notes = [
    ...(view.notes ?? []),
    ...(disconnected.length ? [{ messageKey: 'widget.customer-analysis.cameras.offlineNotice', params: { cameras: disconnected.map(camera => resolveDataText(t.t, camera.name)).join(', '), count: disconnected.length } }] : []),
    ...(zero ? [{ messageKey: 'widget.customer-analysis.noVisits' }] : []),
  ];
  const selected = m.hours.find((h) => h.hour === (picked ?? m.peak?.hour ?? -1)) ?? null;
  const max = Math.max(...m.hours.map((h) => h.visits ?? 0), 1);
  const gaps = m.hours.filter((h) => h.status !== 'ok');
  const mark = () => {
    if (!selected || sending || selected.reviewMarked) return;
    void markPeak(m.date, selected.hour);
  };
  const total = visitUnit(t, m.totalVisits);
  return (
    <div className="mc-detail mc-workspace" data-widget={ID}>
      {footage}
      <CctvLinks {...links} />
      <div className="mc-tools">
        <p className="mc-tools__date">{t.format.date(m.date, 'long')}</p>
        <p className="mc-caption">{t.t('widget.customer-analysis.coverage', { range: t.format.hourRange(m.coverage.startHour, m.coverage.endHour) })}</p>
        {m.staffSourceKey ? <p className="mc-caption">{t.t('widget.customer-analysis.sourceNote', { source: t.t(m.staffSourceKey) })}</p> : null}
      </div>
      <Notes notes={notes} t={t} />
      {zero ? <div className="mc-zero-visits"><ActionButton variant="secondary" data-slot={`${ID}.state.action`} onClick={() => setCctvMode('live')}>{t.t('widget.customer-analysis.checkCamera')}</ActionButton></div> : null}
      <section className="mc-grid-region">
        <h3>{t.t('widget.customer-analysis.cameras.title')}</h3>
        <DataGrid id="camera-grid" label={t.t('widget.customer-analysis.cameras.title')} rows={[...m.cameras].sort((a,b)=>cameraSort?(cameraSort.columnId==='checked'?a.lastCheckedAt.localeCompare(b.lastCheckedAt):resolveDataText(t.t,a.name).localeCompare(resolveDataText(t.t,b.name)))*(cameraSort.direction==='asc'?1:-1):0)} columns={cameraColumns} getRowId={c=>c.cameraId} getRowLabel={c=>resolveDataText(t.t,c.name)} sort={cameraSort} onSortChange={setCameraSort} selectedRowId={null} expandedRowIds={new Set()} focus={cameraFocus} onFocusChange={setCameraFocus} emptyContent={t.t('data.state.customer-analysis.no-cameras')}/>

      </section>
      <div className="mc-grid-context">
      <div><h3>{t.t('widget.customer-analysis.cameras.analysis')}</h3>{m.peak?<p>{t.t('widget.customer-analysis.cameras.peakAdvice',{hour:m.peak.hour})}</p>:null}</div>
      <dl className="mc-kpis">
        <div><dt>{t.t('widget.customer-analysis.todayVisits')}</dt><dd data-slot={`${ID}.metric.value`}>{total.value}<small>{total.unit}</small></dd><p>{t.t('widget.customer-analysis.notHeadcount')}</p></div>
        <div><dt>{t.t('widget.customer-analysis.peakHour')}</dt><dd>{m.peak ? t.format.hourRange(m.peak.hour, m.peak.hour + 1) : '—'}</dd></div>
        <div><dt>{t.t('widget.customer-analysis.staffOnShift')}</dt><dd>{staff === null ? '—' : staffText(t, staff)}</dd></div>
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

function LiveCustomerAnalysisPanel(props: WidgetPanelProps) {
  const t = useT();
  const view = useWidgetView(ID, props.condition);
  return <CctvAnalysisPanel {...props} model={view.status === 'ready' ? view.model : null} note={view.status === 'ready' && view.notes?.[0] ? t.t(view.notes[0].messageKey) : null} />;
}

/** SCR-345 / SCR-221: 실시간이면 반복 5-C 패널, 목업이면 반복 5 CCTV 현황 패널. 같은 부품을 예시 데이터와 서비스 데이터 모드가 함께 쓴다(D-355). */
export function CustomerAnalysisPanel(props: WidgetPanelProps) {
  const mode = useCctvMode();
  return mode === 'live' ? <LiveCustomerAnalysisPanel {...props} /> : <MockCustomerAnalysisPanel {...props} />;
}

/** The store's own zone api for the camera the detail is about, only over the service; the original setup flow saves zones through it. */
function useStoreZonesApi(detailRef: WidgetDetailProps['detailRef']) {
  const store = useWidgetDataStore();
  const http = useRealPort()?.mode('cctv') === 'http';
  const cameras = useWidgetViewCameraIds(http);
  const cameraId = cameras.find(id => id === detailRef?.itemId) ?? cameras[0];
  return useMemo(() => http && cameraId ? createStoreZonesApi(store, cameraId) : undefined, [http, store, cameraId]);
}
function useWidgetViewCameraIds(http: boolean): readonly string[] {
  const store = useWidgetDataStore();
  const rows = useSyncExternalStore(store.subscribe, () => store.getSnapshot().tables.realInsight?.cameras, () => undefined);
  return useMemo(() => http ? (rows ?? []).map(camera => camera.cameraId) : [], [http, rows]);
}

/** SCR-346 / 반복 5: 실시간이면 영상·숫자 위에 하루 기록(반복 5-C), 목업이면 CCTV 현황 자세히 보기와 머리의 토글(목업에서 실시간으로 바꾸는 곳). */
export function CustomerAnalysisDetail(props: WidgetDetailProps & CctvLinksProps) {
  const mode = useCctvMode();
  const zonesApi = useStoreZonesApi(props.detailRef);
  if (mode === 'live') return <CctvAnalysisDetail {...props} zonesApi={zonesApi} record={<DayRecord condition={props.condition} host={props.host} detailRef={props.detailRef} />} />;
  return <><DetailModeToggle mode={mode} onChange={setCctvMode} /><MockCustomerAnalysisDetail {...props} /></>;
}

/** 실시간 모드의 하루 기록(반복 5-C T-075 그대로). */
function DayRecord({ condition, host, detailRef }: Pick<WidgetDetailProps, 'condition' | 'host' | 'detailRef'>) {
  const t = useT();
  const view = useAnalysisView(condition);
  const staff = useStaffingMetric(view.status === 'ready' ? view.model : null);
  const { sending, mark: markPeak } = useMarkPeak(host);
  const [picked, setPicked] = useState<number | null>(detailRef?.hour ?? null);
  if (view.status !== 'ready') return <div className="mc-detail" data-widget={ID}><CctvDetailState view={view} t={t} host={host} live /></div>;
  const m = view.model;
  const selected = m.hours.find((h) => h.hour === (picked ?? m.peak?.hour ?? -1)) ?? null;
  const max = Math.max(...m.hours.map((h) => h.visits ?? 0), 1);
  const gaps = m.hours.filter((h) => h.status !== 'ok');
  const mark = () => {
    if (!selected || sending || selected.reviewMarked) return;
    void markPeak(m.date, selected.hour);
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
        <div><dt>{t.t('widget.customer-analysis.staffOnShift')}</dt><dd>{staff === null ? '—' : staffText(t, staff)}</dd></div>
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
