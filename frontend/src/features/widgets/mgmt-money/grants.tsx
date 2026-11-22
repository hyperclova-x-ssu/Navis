/** 정부지원 (F-30, SCR-30/31): panel, detail with candidates by deadline, conditions, the in-app sample notice and 검토 완료. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useRealRetry, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { resolveDataText, type DataCommand, type GrantRow, type GrantsModel } from '../../../data/widget-data';
import type { GrantNoticeDto } from '../../../data/reality/11/dto';
import { projectOfficialGrants, type GrantsViewModel, type NoticeRow } from '../../../data/reality/11/grants';
import { useInsightCommand } from '../../../data/reality/11/use-insight-command';
import { ActionButton, copyText, DataGrid, DetailDialog, DetailTabs, Icon, InlineEmpty, InlineError, InlineForm, MasterDetail, PinnedColumn, StatusBadge, StatusChip, Textarea, TextField, type DataGridHandle, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import { DetailViewState, MoneyPanel, NoteLine, ViewState, useMoneyT, useRunCommand, useSizeCtx, type PanelSpec, type RowData, type T } from './shared';

import { manualsGrantsDetailPrefill } from '../../assistant/domains/manuals-grants';
import { naverDraftErrorText, setDraftInputLanguage, useNaverDraft, useNaverDraftCopy } from '../naver-drafts';
import { noticeDay, noticeStamp } from './grants.dates';
import { FinancialCenterRecommendations, FundingNotice } from './grants.financial-center';
import { useGrantsCopy } from './grants.copy';

const ID = 'grants' as const;
let applicationSequence = 0;
function useGrantsView(condition: QueryCondition) {
  const view = useWidgetView(ID, condition);
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (view.status !== 'ready' || store.real?.mode('manuals') !== 'http') return view;
  return { ...view, model: projectOfficialGrants(snapshot, view.model) };
}

/** DS 12.1 chip meanings: ◷ in review, ✓ chosen or paid out, ⓘ just applied, no icon for 미선정. */
const applicationSemantic = { applied: 'info', reviewing: 'waiting', selected: 'done', rejected: 'none', completed: 'done' } as const;
const deadlineText = (t: T, n: NoticeRow) => n.official ? n.official.deadline ? noticeDay(t.format, n.official.deadline) : '' : t('widget.grants.deadline', { date: t.format.date(n.applyEndDate, 'short'), time: t.format.time(n.applyEndTime) });
function statusBadge(t: T, n: NoticeRow) {
  if (n.reviewStatus === 'reviewed') return <StatusBadge kind="reviewed" />;
  if (n.official && !n.isCandidate) return null;
  return n.matchStatus === 'needs-check' ? <StatusBadge kind="needsReview" label={t('widget.grants.matchNeedsCheck')} /> : <StatusBadge kind="endingSoon" label={t('widget.grants.daysLeft', { n: n.daysLeft })} tone="neutral" />;
}
/** D-333: from 3x3 up the list also names who runs each program and where, its conditions, and every other open notice with its review or application state. */
const grantRow = (t: T, n: NoticeRow, shape: string, large: boolean, application?: GrantsModel['applications'][number]): RowData => ({
  id: n.noticeId, name: t(n.titleKey),
  sub: large ? [t(n.agencyKey), t(n.regionKey), deadlineText(t, n), n.daysLeft >= 0 && (!n.official || n.official.deadline) ? t('widget.grants.daysLeft', { n: n.daysLeft }) : ''].filter(Boolean).join('\u00A0· ') : shape === 'L' ? deadlineText(t, n) : t('widget.grants.daysLeft', { n: n.daysLeft }),
  detail: large && n.conditionKeys.length ? `${t('widget.grants.conditions')}: ${n.conditionKeys.map((key) => t(key)).join('\u00A0· ')}` : undefined,
  badge: application ? <StatusChip semantic={applicationSemantic[application.status]}>{t(`widget.grants.${application.status}`)}</StatusChip>
    : n.reviewStatus === 'reviewed' ? <StatusBadge kind="reviewed" />
    : n.matchStatus === 'needs-check' ? <StatusBadge kind="needsReview" label={t('widget.grants.matchNeedsCheck')} /> : undefined,
});

function buildSpec(t: T, model: GrantsViewModel, notes: ReactNode, shape: string, large: boolean): PanelSpec {
  const candidates = model.notices.filter((n) => n.isCandidate);
  const none = model.candidateCount === 0;
  const listed = large ? model.notices : candidates;
  return {
    slot: ID, label: t('widget.grants.reviewCandidates'), value: none ? t('data.state.grants.none') : String(model.candidateCount), semanticValue: model.candidateCount,
    unit: none ? undefined : t('widget.grants.unit', { n: model.candidateCount }), textValue: none, inlineUnit: true, tightT: 1,
    sub: t('widget.grants.inProgress', { n: model.inProgressCount }), subSemanticValue: model.inProgressCount, subEssential: true,
    rows: listed.map((n) => grantRow(t, n, shape, large, model.applications.find((a) => a.noticeId === n.noticeId))), rowsTitle: shape === 'T' || shape === 'L' ? t('widget.grants.listTitle') : undefined, status: notes,
  };
}

export function GrantsPanel(props: WidgetPanelProps) {
  const t = useMoneyT();
  const ctx = useSizeCtx(props);
  const view = useGrantsView(props.condition);
  const retry = useRealRetry('manuals');
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={view.messageKey === 'data.real.error' ? { ...props.host, resetPreview: retry } : props.host} featureId={ID} t={t} />;
  return <MoneyPanel spec={buildSpec(t, view.model, <NoteLine notes={view.notes} t={t} />, ctx.shape, ctx.shape === 'L' && ctx.width >= 3 && ctx.height >= 3)} ctx={ctx} />;
}

export function useGrantsSummary({ condition }: { featureId: unknown; condition: QueryCondition }): string {
  const t = useMoneyT();
  const view = useGrantsView(condition);
  if (view.status !== 'ready') return t(view.messageKey);
  return view.model.candidateCount === 0 ? t('data.state.grants.none') : t('widget.grants.summary', { n: view.model.candidateCount });
}

/* ---------- detail ---------- */
export function GrantsDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useMoneyT();
  const copy = useGrantsCopy();
  const view = useGrantsView(condition);
  const retry = useRealRetry('manuals');
  const fixtureRun = useRunCommand(host);
  const { http, pending, run } = useInsightCommand(host);
  // HTTP: the Financial Center recommendations are rows of the same list as the official notices (source named on each row), not a filter or a second block.
  const [fundingRef, setFundingRef] = useState<string>();
  const fundingActive = !!fundingRef;
  const fundingList = http ? <FinancialCenterRecommendations selected={fundingRef} onSelect={setFundingRef} /> : null;
  const fundingDetail = fundingActive ? <FundingNotice key={fundingRef} refId={fundingRef} /> : null;
  const [actionError, setActionError] = useState<string>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const attempt = useRef<{ noticeId: string; key: string } | undefined>(undefined);
  const initialTab = detailRef.view === 'applications' ? 'applications'
    : detailRef.view === 'template' || detailRef.view === 'templates' ? 'template' : 'notices';
  const [selectedId, setSelectedId] = useState<string | null>(initialTab === 'applications' ? null : detailRef.itemId ?? null);
  const [official, setOfficial] = useState<string | null>(detailRef.view === 'official' ? detailRef.itemId ?? null : null);
  const officialOpener = useRef<HTMLButtonElement>(null);
  const officialLink = useRef<HTMLAnchorElement>(null);
  const [tab, setTab] = useState<'notices' | 'template' | 'applications'>(initialTab);
  const [gridSort, setGridSort] = useState<GridSort>(null);
  const [gridFocus, setGridFocus] = useState<GridFocus>(null);
  const grid = useRef<DataGridHandle>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const officialClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!detailRef.itemId) return;
    if (detailRef.view === 'applications') grid.current?.focusCell(detailRef.itemId, 'name');
    else if (detailRef.view === 'official') (officialLink.current ?? officialClose.current)?.focus();
    else if (initialTab === 'notices') selectedButton.current?.focus();
  }, [detailRef.itemId, detailRef.view, initialTab, view.status]);
  const prefill = initialTab === 'template' ? manualsGrantsDetailPrefill(detailRef) : undefined;
  if (view.status === 'error' || view.status === 'empty' && view.messageKey === 'data.real.loading') return <div className="mm-detail" data-widget={ID}><DetailViewState view={view} host={http ? { ...host, resetPreview: retry } : host} t={t} /></div>;
  if (view.status === 'empty') {
    const toNotices = <ActionButton variant="secondary" onClick={() => setTab('notices')}>{t('widget.grants.openNotices')}</ActionButton>;
    return <div className="mm-detail" data-widget={ID}><DetailTabs value={tab} onValueChange={setTab} label={t('widget.grants.tabs')} tabs={[{ value: 'notices', label: t('widget.grants.notices') }, { value: 'template', label: t('widget.grants.template') }, { value: 'applications', label: t('widget.grants.applications') }]} />{tab === 'template' ? <EmptyGrantDraft action={toNotices} /> : tab === 'applications'
      ? <InlineEmpty title={t('widget.grants.noApplications')} description={t('widget.grants.noApplicationsHint')} action={toNotices} />
      : http ? <MasterDetail list={<><h3 className="mm-card__title">{t('widget.grants.listTitle')}</h3><p>{t(view.messageKey)}</p>{fundingList}<GrantSync host={host} /></>} detail={fundingDetail} listLabel={t('widget.grants.listTitle')} detailLabel={t('widget.grants.conditions')} />
      : <InlineEmpty title={t(view.messageKey)} description={t('widget.grants.noNoticesHint')} action={<ActionButton variant="secondary" onClick={() => setTab('applications')}>{t('widget.grants.openApplications')}</ActionButton>} />}</div>;
  }
  const m: GrantsViewModel = view.model;
  const selected = selectedId ? m.notices.find((n) => n.noticeId === selectedId) ?? null : m.notices[0] ?? null;
  const selectedOfficial = selected?.official;
  const deletion = m.applications.find(row => row.applicationId === deleteId);
  const applicationOpen = selected && (selectedOfficial ? !selectedOfficial.startsOn || selectedOfficial.startsOn <= (selected.businessDay ?? '') : selected.isCandidate || selected.reviewStatus === 'reviewed');
  const submit = async (command: DataCommand, notice?: { messageKey: string; params: { name: string } }) => {
    setActionError(undefined);
    const result = await run(command, { notice });
    if (result && !result.ok) setActionError(t(result.messageKey));
    return result;
  };
  const recordApplication = async (notice: NoticeRow) => {
    if (attempt.current?.noticeId !== notice.noticeId) attempt.current = { noticeId: notice.noticeId, key: http ? globalThis.crypto.randomUUID() : `grant-${notice.noticeId}-${++applicationSequence}` };
    const result = await submit({ type: 'grants.apply', noticeId: notice.noticeId, idempotencyKey: attempt.current.key },
      t.locale === 'ko' ? { messageKey: 'data.management.notice.grantApplied', params: { name: t(notice.titleKey) } } : { messageKey: 'data.management.notice.saved', params: { name: t(notice.titleKey) } });
    if (result && (result.ok || !result.outcomeUnknown)) attempt.current = undefined;
  };
  const list = (
    <>
      <>
        <h3 className="mm-card__title">{t('widget.grants.listTitle')}</h3>
        {m.notices.length === 0 ? <p className="mm-muted">{t('data.state.grants.none')}</p> : (
          <ul className="mm-select-list" data-slot="grants.list">
            {m.notices.map((n) => (
              <li key={n.noticeId} data-row-id={n.noticeId}>
                <button type="button" className="mm-select-row" ref={n.noticeId === detailRef.itemId ? selectedButton : undefined} aria-pressed={!fundingActive && n.noticeId === selected?.noticeId} onClick={() => { setFundingRef(undefined); setSelectedId(n.noticeId); }}>
                  <span className="mm-select-row__text"><strong>{t(n.titleKey)}</strong><span>{[t(n.agencyKey), deadlineText(t, n)].filter(Boolean).join('\u00A0· ')}</span></span>
                  {statusBadge(t, n)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
      {fundingList}
      {http && <GrantSync host={host} scope={m.notices[0]?.official} />}
    </>
  );
  const detail = selected ? (
    <div className="mm-item" data-slot="grants.item" data-row-id={selected.noticeId}>
      <h3 className="mm-card__title">{t(selected.titleKey)}</h3>
      <dl className="mm-dl mm-grant-facts">
        <div><dt>{t('widget.grants.agency')}</dt><dd>{t(selected.agencyKey)}</dd></div>
        <div><dt>{t('widget.grants.region')}</dt><dd>{t(selected.regionKey)}</dd></div>
        <div>
          <dt>{t('widget.grants.deadlineLabel')}</dt>
          <dd>{selectedOfficial ? selectedOfficial.deadline ? noticeDay(t.format, selectedOfficial.deadline) : copy.t('grants.noDate') : <>{t.format.date(selected.applyEndDate, 'short')} {t.format.time(selected.applyEndTime)}{'\u00A0'}· {t('widget.grants.daysLeft', { n: selected.daysLeft })}</>}</dd>
        </div>
        {selectedOfficial && <>
          <div><dt>{copy.t('grants.industry')}</dt><dd>{selectedOfficial.industry}</dd></div>
          {selectedOfficial.startsOn && <div><dt>{copy.t('grants.start')}</dt><dd>{noticeDay(t.format, selectedOfficial.startsOn)}</dd></div>}
          {selectedOfficial.target && <div><dt>{copy.t('grants.target')}</dt><dd>{selectedOfficial.target}</dd></div>}
          {selectedOfficial.applicationMethod && <div><dt>{copy.t('grants.method')}</dt><dd>{selectedOfficial.applicationMethod}</dd></div>}
          <div><dt>{copy.t('grants.updated')}</dt><dd><time dateTime={selectedOfficial.sourceUpdatedAt}>{noticeStamp(t.format, selectedOfficial.sourceUpdatedAt)}</time></dd></div>
        </>}
      </dl>
      {!selectedOfficial && <><h4 className="mm-card__subtitle">{t('widget.grants.conditions')}</h4>
      <ul className="mm-bullets">{selected.conditionKeys.map((key) => <li key={key}>{t(key)}</li>)}</ul></>}
      <p>{t(selected.summaryKey)}</p>
      <p className="mm-muted">{selectedOfficial ? copy.t('grants.source') : t('widget.grants.source', { source: t(m.sourceKey) })}</p>
      <div className="mm-actions">
        {applicationOpen && !m.applications.some(a => a.noticeId === selected.noticeId) && <ActionButton loading={pending} onClick={() => void recordApplication(selected)}>{t('common.linked.grants.markApplied')}</ActionButton>}
        {selectedOfficial ? <a ref={officialLink} className="ui-button ui-button--secondary ui-button--default" href={selectedOfficial.officialUrl} target="_blank" rel="noopener noreferrer"><span className="ui-press-surface">{t('common.linked.grants.openNotice')}</span></a>
          : <ActionButton ref={officialOpener} variant="secondary" onClick={() => setOfficial(selected.noticeId)}>{t('common.viewOfficialNotice')}</ActionButton>}
        {selected.reviewStatus === 'reviewed'
          ? <StatusBadge kind="reviewed" />
          : <ActionButton variant="secondary" disabled={pending} onClick={() => void submit({ type: 'grants.markReviewed', noticeId: selected.noticeId })}>{t('common.markReviewed')}</ActionButton>}
      </div>
      {!selectedOfficial && official === selected.noticeId ? (
        <section className="mm-card mm-official" aria-label={t('widget.grants.officialTitle')} data-slot="grants.official" data-esc-layer>
          <h4 className="mm-card__subtitle">{t('widget.grants.officialTitle')}</h4>
          <p><strong>{t(selected.titleKey)}</strong></p>
          <p>{t(selected.agencyKey)}{'\u00A0'}· {t(selected.regionKey)}</p>
          <p>{t('widget.grants.period', { start: t.format.date(selected.applyStart.slice(0, 10), 'short'), end: `${t.format.date(selected.applyEndDate, 'short')} ${t.format.time(selected.applyEndTime)}` })}</p>
          <p>{t(selected.summaryKey)}</p>
          <p className="mm-muted"><Icon name="info" /> {t('widget.grants.officialNote')}</p>
          <ActionButton ref={officialClose} variant="secondary" data-esc-close onClick={() => { setOfficial(null); officialOpener.current?.focus({ preventScroll: true }); }}>{t('common.close')}</ActionButton>
        </section>
      ) : null}
    </div>
  ) : <p className="mm-muted">{t('widget.grants.selectItem')}</p>;
  return (
    <div className={`mm-detail${tab === 'applications' ? ' mm-detail--grid' : tab === 'template' ? ' mm-detail--grant-draft' : ''}`} data-widget={ID}>
      <p className="mm-detail__note" lang="ko">{t('widget.grants.reviewCandidates')} {t.format.count(m.candidateCount, 'count')}{'\u00A0'}· {t('widget.grants.reviewedNote')}</p>
      <NoteLine notes={view.notes} t={t} />
      {http && view.notes?.length ? <ActionButton variant="secondary" onClick={retry}>{t('common.retry')}</ActionButton> : null}
      {pending && <p role="status" className="mm-muted">{t('data.real.loading')}</p>}
      {actionError && !deletion && <p role="alert" className="ui-field__error">{actionError}</p>}
      <DetailTabs value={tab} onValueChange={setTab} label={t('widget.grants.tabs')} tabs={[{ value: 'notices', label: t('widget.grants.notices') }, { value: 'template', label: t('widget.grants.template') }, { value: 'applications', label: t('widget.grants.applications') }]} />
      {tab === 'notices' ? <MasterDetail list={list} detail={fundingDetail ?? detail} listLabel={t('widget.grants.listTitle')} detailLabel={t('widget.grants.conditions')} /> : tab === 'template' ? (
        <GrantDraftView notices={m.notices} http={http} initialId={selected?.noticeId ?? (selectedId ? EMPTY_SAMPLE : undefined)}
          prefill={typeof prefill?.body === 'string' ? prefill.body : undefined} focusAction={detailRef.focus === 'action'} />
      ) : <section className="mm-card mm-detail__grid">{http && <p className="mm-muted">{t('common.linked.grants.appliedNote')}</p>}<DataGrid ref={grid} id="grant-applications" label={t('widget.grants.applications')} rowActionsLabel={t('widget.grants.deleteColumn')} rows={m.applications} getRowId={a => a.applicationId} getRowLabel={a => resolveDataText(t, a.title)} columns={[
        { id: 'name', header: t('widget.grants.applicationName'), kind: 'text', minWidth: 200, value: a => resolveDataText(t, a.title) },
        { id: 'date', header: t('widget.grants.appliedOn'), kind: 'text', minWidth: 140, value: a => a.appliedOn, render: a => t.format.date(a.appliedOn, 'short'), accessibleValue: a => t.format.date(a.appliedOn, 'short') },
        { id: 'status', header: t('widget.grants.applicationStatus'), kind: 'status', minWidth: 140, value: a => a.status, accessibleValue: a => t(`widget.grants.${a.status}`), render: a => <StatusChip semantic={applicationSemantic[a.status]}>{t(`widget.grants.${a.status}`)}</StatusChip>, editable: () => !pending, editor: 'select', options: ['applied', 'reviewing', 'selected', 'rejected', 'completed'].map(value => ({ value, label: t(`widget.grants.${value}`) })) },
        { id: 'memo', header: t('widget.grants.resultMemo'), kind: 'text', minWidth: 200, value: a => resolveDataText(t, a.resultMemo), editable: () => !pending },
      ] satisfies GridColumn<GrantsModel['applications'][number]>[]} sort={gridSort} onSortChange={setGridSort} focus={gridFocus} onFocusChange={setGridFocus} selectedRowId={null} expandedRowIds={new Set()} toolbar={m.applications.length === 0 ? <ActionButton variant="secondary" onClick={() => setTab('notices')}>{t('widget.grants.openNotices')}</ActionButton> : undefined} emptyContent={<div className="mm-grid-empty"><p>{t('widget.grants.noApplications')}</p><p className="mm-muted">{t('widget.grants.noApplicationsHint')}</p></div>} getRowActions={a => [{ id: 'delete', label: t('widget.grants.delete'), disabled: pending, onPress: () => { setActionError(undefined); setDeleteId(a.applicationId); } }]} onCommit={({ rowId, columnId, raw }) => {
        const command: DataCommand = columnId === 'status' ? { type: 'grants.updateApplication', applicationId: rowId, status: raw as GrantsModel['applications'][number]['status'] } : { type: 'grants.updateApplication', applicationId: rowId, resultMemo: raw };
        if (http) { void submit(command); return { ok: true }; }
        const result = fixtureRun(command);
        return result.ok ? { ok: true } : { ok: false, error: { id: result.code, message: t(result.messageKey) } };
      }} /></section>}
      {deletion && <DetailDialog open title={copy.t('grants.deleteQuestion')} dialogRole="alertdialog" closeLocked={pending} onClose={() => setDeleteId(null)} footer={
        <div className="mm-actions"><ActionButton variant="secondary" disabled={pending} onClick={() => setDeleteId(null)}>{t('common.cancel')}</ActionButton>
          <ActionButton variant="destructive" loading={pending} onClick={async () => {
            if ((await submit({ type: 'grants.deleteApplication', applicationId: deletion.applicationId }))?.ok) setDeleteId(null);
          }}>{t('widget.grants.delete')}</ActionButton></div>
      }><p>{resolveDataText(t, deletion.title)}</p>{actionError && <p role="alert" className="ui-field__error">{actionError}</p>}</DetailDialog>}
    </div>
  );
}

function GrantSync({ host, scope }: { readonly host: WidgetHost; readonly scope?: GrantNoticeDto }) {
  const t = useMoneyT();
  const copy = useGrantsCopy();
  const { run, pending } = useInsightCommand(host);
  const [open, setOpen] = useState(false);
  const [region, setRegion] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState<string>();
  const show = () => { setRegion(scope?.region ?? ''); setIndustry(scope?.industry ?? ''); setError(undefined); setOpen(true); };
  if (!open) return <ActionButton variant="secondary" onClick={show}>{copy.t('grants.sync')}</ActionButton>;
  return <InlineForm title={copy.t('grants.sync')} saveLabel={copy.t('grants.sync')} saving={pending} saveDisabled={!region.trim() || !industry.trim() || region.trim().length > 40 || industry.trim().length > 80}
    onClose={() => setOpen(false)} onSave={async () => {
      const result = await run({ type: 'grants.syncNotices', region: region.trim(), industry: industry.trim() });
      if (result?.ok) setOpen(false);
      else if (result) setError(t(result.messageKey));
    }}>
    <TextField label={copy.t('grants.region')} value={region} disabled={pending} onValueChange={setRegion} />
    <TextField label={copy.t('grants.industry')} value={industry} disabled={pending} onValueChange={setIndustry} />
    {error && <p role="alert" className="ui-field__error">{error}</p>}
  </InlineForm>;
}

const EMPTY_SAMPLE = 'empty';
const GRANT_MAX_LENGTH = 900;

function EmptyGrantDraft({ action }: { readonly action?: ReactNode }) {
  const { t } = useNaverDraftCopy();
  return <InlineEmpty title={t('widget.grants.draft.empty')} action={action} />;
}

function GrantDraftView({ notices, initialId, prefill, focusAction, http }: {
  readonly notices: readonly NoticeRow[]; readonly initialId?: string; readonly prefill?: string; readonly focusAction?: boolean; readonly http: boolean;
}) {
  const t = useMoneyT();
  const draftCopy = useNaverDraftCopy();
  const [sample, setSample] = useState(initialId ?? notices[0]?.noticeId ?? EMPTY_SAMPLE);
  const notice = notices.find(row => row.noticeId === sample);
  const list = (
    <ul className="mm-select-list mm-grant-draft-list">
      {notices.map(row => (
        <li key={row.noticeId}>
          <button type="button" className="mm-select-row" aria-pressed={row.noticeId === sample} onClick={() => setSample(row.noticeId)}>
            <span className="mm-select-row__text">
              <strong>{t(row.titleKey)}</strong>
              <span>{t(row.agencyKey)} · {t(row.regionKey)}</span>
              <span>{row.conditionKeys.map(key => t(key)).join(' · ') || t('widget.grants.draftCheck')}</span>
              <span>{deadlineText(t, row)}</span>
            </span>
          </button>
        </li>
      ))}
      <li><button type="button" className="mm-select-row" aria-pressed={!notice} onClick={() => setSample(EMPTY_SAMPLE)}>{draftCopy.t(http ? 'widget.grants.draft.noNotice' : 'widget.grants.draft.emptySample')}</button></li>
    </ul>
  );
  return (
    <MasterDetail list={list} detail={http ? <OfficialGrantDraft key={sample} row={notice} prefill={sample === initialId ? prefill : undefined} focusAction={sample === initialId && focusAction} /> : <GrantDraftEditor key={sample} notice={notice}
      prefill={sample === initialId && notice ? prefill : undefined} focusAction={sample === initialId && focusAction} />} listLabel={t('widget.grants.listTitle')} detailLabel={t('widget.grants.template')} />
  );
}

/**
 * The service has no sample draft to generate from (the original editor's 초안 만들기 reads sample notices), so this is the same editor shell
 * (title and summary head, copy footer, the counted text field) with the official notice's own facts as the starting text.
 */
function OfficialGrantDraft({ row, prefill, focusAction }: { readonly row?: NoticeRow; readonly prefill?: string; readonly focusAction?: boolean }) {
  const t = useMoneyT();
  const draftCopy = useNaverDraftCopy();
  const copy = useGrantsCopy();
  const notice = row?.official;
  const [body, setBody] = useState(prefill ?? (notice ? [notice.title, notice.agency, notice.officialUrl].join('\n') + '\n\n' : ''));
  const [result, setResult] = useState<'idle' | 'success' | 'error'>('idle');
  const editor = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (focusAction) editor.current?.focus(); }, [focusAction]);
  const tooLong = body.length > GRANT_MAX_LENGTH;
  return <PinnedColumn footer={<div className="mm-grant-draft__actions">
    <ActionButton size="primary" disabled={tooLong || !body.trim()} onClick={async () => {
      const copied = await copyText(body);
      if (editor.current?.value !== body) return;
      setResult(copied ? 'success' : 'error');
      if (!copied) { editor.current?.focus(); editor.current?.select(); }
    }}>{t('widget.grants.copy')}</ActionButton>
    {result === 'success' && <p role="status"><Icon name="check" />{t('widget.grants.copied')}</p>}
    {result === 'error' && <p className="ui-draft-card__error" role="alert"><Icon name="error" />{t('widget.grants.copyFailed')}</p>}
  </div>}><section className="mm-card mm-grant-draft">
    {row && <>
      <h3 className="mm-card__title">{t(row.titleKey)}</h3>
      <div className="mm-grant-draft__summary">
        <p>{t(row.summaryKey)}</p>
        <p className="mm-muted">{copy.t('grants.source')}</p>
      </div>
    </>}
    <div>
      <Textarea className="mm-grant-draft__editor" label={t('widget.grants.template')} value={body} inputRef={field => { editor.current = field; setDraftInputLanguage(field); }}
        onValueChange={value => { setBody(value); setResult('idle'); }}
        hint={draftCopy.t('widget.grants.draft.count', { n: body.length, max: GRANT_MAX_LENGTH })}
        error={tooLong ? draftCopy.t('widget.grants.draft.tooLong', { max: GRANT_MAX_LENGTH }) : undefined} />
    </div>
  </section></PinnedColumn>;
}

function GrantDraftEditor({ notice, prefill, focusAction }: {
  readonly notice?: GrantRow; readonly prefill?: string; readonly focusAction?: boolean;
}) {
  const t = useMoneyT();
  const draftCopy = useNaverDraftCopy();
  const { generation, generate } = useNaverDraft('grants');
  const [body, setBody] = useState(prefill ?? '');
  const [sources, setSources] = useState<readonly string[] | null>(prefill ? [] : null);
  const [copied, setCopied] = useState<'idle' | 'success' | 'error'>('idle');
  const editor = useRef<HTMLTextAreaElement>(null);
  const generateButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusAction) (editor.current ?? generateButton.current)?.focus();
  }, [focusAction]);

  const loading = generation.status === 'loading';
  const tooLong = body.length > GRANT_MAX_LENGTH;
  const start = () => {
    setCopied('idle');
    void generate(notice?.noticeId ?? null, draft => {
      setBody(draft?.content.body ?? '');
      setSources(draft?.sourceLabels ?? null);
    });
  };
  const copy = async () => {
    const ok = await copyText(body);
    if (editor.current?.value !== body) return;
    setCopied(ok ? 'success' : 'error');
    if (!ok) {
      editor.current?.focus();
      editor.current?.select();
    }
  };

  return (
    <PinnedColumn footer={
      <div className="mm-grant-draft__actions">
        <ActionButton size="primary" onClick={copy} disabled={loading || !body.trim() || tooLong}>{t('widget.grants.copy')}</ActionButton>
        {copied === 'success' && <p role="status"><Icon name="check" />{t('widget.grants.copied')}</p>}
        {copied === 'error' && <p className="ui-draft-card__error" role="alert"><Icon name="error" />{t('widget.grants.copyFailed')}</p>}
      </div>
    }>
      <section className="mm-card mm-grant-draft">
        {notice && <>
          <h3 className="mm-card__title">{t(notice.titleKey)}</h3>
          <div className="mm-grant-draft__summary">
            <p>{t('widget.grants.draftProfile')}</p>
            <p>{t(notice.summaryKey)}</p>
            <p className="mm-muted">{t('data.management.grantGuide')}</p>
          </div>
        </>}
        <div className="mm-actions">
          {generation.status === 'error'
            ? <InlineError message={naverDraftErrorText(generation, draftCopy.t)} onRetry={start} />
            : <ActionButton ref={generateButton} variant="secondary" disabled={loading} aria-busy={loading || undefined} onClick={start}>{t('widget.grants.generate')}</ActionButton>}
          {loading && <p role="status">{draftCopy.t('widget.grants.draft.loading')}</p>}
        </div>
        {generation.status === 'empty' && <EmptyGrantDraft />}
        {sources && sources.length > 0 && (
          <ul className="mm-grant-draft__sources" aria-label={t('widget.grants.draftSources')}>
            {sources.map(source => <li lang="ko" key={source}>{source}</li>)}
            {body.includes('확인 필요') && <li><StatusBadge kind="needsReview" label={t('widget.grants.draftCheck')} /></li>}
          </ul>
        )}
        {(sources !== null || generation.status === 'empty') && (
          <div>
            <Textarea className="mm-grant-draft__editor" label={t('widget.grants.template')} value={body} inputRef={field => { editor.current = field; setDraftInputLanguage(field); }}
              disabled={loading || generation.status === 'empty'}
              onValueChange={value => { setBody(value); setCopied('idle'); }}
              hint={draftCopy.t('widget.grants.draft.count', { n: body.length, max: GRANT_MAX_LENGTH })}
              error={tooLong ? draftCopy.t('widget.grants.draft.tooLong', { max: GRANT_MAX_LENGTH }) : undefined} />
          </div>
        )}
      </section>
    </PinnedColumn>
  );
}

export const grantsModule: WidgetModule = { id: ID, Panel: GrantsPanel, Detail: GrantsDetail, useSummary: useGrantsSummary };
