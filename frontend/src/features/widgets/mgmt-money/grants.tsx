/** 정부지원 (F-30, SCR-30/31): panel, detail with candidates by deadline, conditions, the in-app sample notice and 검토 완료. */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import { resolveDataText, type GrantRow, type GrantsModel } from '../../../data/widget-data';
import { ActionButton, copyText, DataGrid, DetailTabs, Icon, InlineEmpty, InlineError, MasterDetail, PinnedColumn, StatusBadge, StatusChip, Textarea, type DataGridHandle, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import { DetailViewState, MoneyPanel, NoteLine, ViewState, useMoneyT, useRunCommand, useSizeCtx, type PanelSpec, type RowData, type T } from './shared';

import { manualsGrantsDetailPrefill } from '../../assistant/domains/manuals-grants';
import { naverDraftErrorText, setDraftInputLanguage, useNaverDraft, useNaverDraftCopy } from '../naver-drafts';

const ID = 'grants' as const;
let applicationSequence = 0;

/** DS 12.1 chip meanings: ◷ in review, ✓ chosen or paid out, ⓘ just applied, no icon for 미선정. */
const applicationSemantic = { applied: 'info', reviewing: 'waiting', selected: 'done', rejected: 'none', completed: 'done' } as const;
const deadlineText = (t: T, n: GrantRow) => t('widget.grants.deadline', { date: t.format.date(n.applyEndDate, 'short'), time: t.format.time(n.applyEndTime) });
function statusBadge(t: T, n: GrantRow) {
  if (n.reviewStatus === 'reviewed') return <StatusBadge kind="reviewed" />;
  return n.matchStatus === 'needs-check' ? <StatusBadge kind="needsReview" label={t('widget.grants.matchNeedsCheck')} /> : <StatusBadge kind="endingSoon" label={t('widget.grants.daysLeft', { n: n.daysLeft })} tone="neutral" />;
}
const grantRow = (t: T, n: GrantRow, shape: string): RowData => ({
  id: n.noticeId, name: t(n.titleKey), sub: shape === 'L' ? deadlineText(t, n) : t('widget.grants.daysLeft', { n: n.daysLeft }),
  badge: n.matchStatus === 'needs-check' ? <StatusBadge kind="needsReview" label={t('widget.grants.matchNeedsCheck')} /> : undefined,
});

function buildSpec(t: T, model: GrantsModel, notes: ReactNode, shape: string): PanelSpec {
  const candidates = model.notices.filter((n) => n.isCandidate);
  const none = model.candidateCount === 0;
  return {
    slot: ID, label: t('widget.grants.reviewCandidates'), value: none ? t('data.state.grants.none') : String(model.candidateCount), semanticValue: model.candidateCount,
    unit: none ? undefined : t('widget.grants.unit', { n: model.candidateCount }), textValue: none, inlineUnit: true, tightT: 1,
    sub: t('widget.grants.inProgress', { n: model.inProgressCount }), subSemanticValue: model.inProgressCount, subEssential: true,
    rows: candidates.map((n) => grantRow(t, n, shape)), rowsTitle: shape === 'T' || shape === 'L' ? t('widget.grants.listTitle') : undefined, status: notes,
  };
}

export function GrantsPanel(props: WidgetPanelProps) {
  const t = useMoneyT();
  const ctx = useSizeCtx(props);
  const view = useWidgetView(ID, props.condition);
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={props.host} featureId={ID} t={t} />;
  return <MoneyPanel spec={buildSpec(t, view.model, <NoteLine notes={view.notes} t={t} />, ctx.shape)} ctx={ctx} />;
}

export function useGrantsSummary({ condition }: { featureId: unknown; condition: QueryCondition }): string {
  const t = useMoneyT();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return t(view.messageKey);
  return view.model.candidateCount === 0 ? t('data.state.grants.none') : t('widget.grants.summary', { n: view.model.candidateCount });
}

/* ---------- detail ---------- */
export function GrantsDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useMoneyT();
  const view = useWidgetView(ID, condition);
  const run = useRunCommand(host);
  const initialTab = detailRef.view === 'applications' ? 'applications'
    : detailRef.view === 'template' || detailRef.view === 'templates' ? 'template' : 'notices';
  const [selectedId, setSelectedId] = useState<string | null>(initialTab === 'applications' ? null : detailRef.itemId ?? null);
  const [official, setOfficial] = useState<string | null>(detailRef.view === 'official' ? detailRef.itemId ?? null : null);
  const officialOpener = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [tab, setTab] = useState<'notices' | 'template' | 'applications'>(initialTab);
  const [gridSort, setGridSort] = useState<GridSort>(null);
  const [gridFocus, setGridFocus] = useState<GridFocus>(null);
  const grid = useRef<DataGridHandle>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const officialClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!detailRef.itemId) return;
    if (detailRef.view === 'applications') grid.current?.focusCell(detailRef.itemId, 'name');
    else if (detailRef.view === 'official') officialClose.current?.focus();
    else if (initialTab === 'notices') selectedButton.current?.focus();
  }, [detailRef.itemId, detailRef.view, initialTab]);
  const prefill = initialTab === 'template' ? manualsGrantsDetailPrefill(detailRef) : undefined;
  if (view.status === 'error') return <div className="mm-detail" data-widget={ID}><DetailViewState view={view} host={host} t={t} /></div>;
  if (view.status === 'empty') {
    const toNotices = <ActionButton variant="secondary" onClick={() => setTab('notices')}>{t('widget.grants.openNotices')}</ActionButton>;
    return <div className="mm-detail" data-widget={ID}><DetailTabs value={tab} onValueChange={setTab} label={t('widget.grants.tabs')} tabs={[{ value: 'notices', label: t('widget.grants.notices') }, { value: 'template', label: t('widget.grants.template') }, { value: 'applications', label: t('widget.grants.applications') }]} />{tab === 'template' ? <EmptyGrantDraft action={toNotices} /> : tab === 'applications'
      ? <InlineEmpty title={t('widget.grants.noApplications')} description={t('widget.grants.noApplicationsHint')} action={toNotices} />
      : <InlineEmpty title={t(view.messageKey)} description={t('widget.grants.noNoticesHint')} action={<ActionButton variant="secondary" onClick={() => setTab('applications')}>{t('widget.grants.openApplications')}</ActionButton>} />}</div>;
  }
  const m = view.model;
  const selected = selectedId ? m.notices.find((n) => n.noticeId === selectedId) ?? null : m.notices[0] ?? null;
  const review = (noticeId: string) => {
    if (busy.current) return;
    busy.current = true;
    run({ type: 'grants.markReviewed', noticeId });
    busy.current = false;
  };
  const list = (
    <>
      <h3 className="mm-card__title">{t('widget.grants.listTitle')}</h3>
      {m.notices.length === 0 ? <p className="mm-muted">{t('data.state.grants.none')}</p> : (
        <ul className="mm-select-list" data-slot="grants.list">
          {m.notices.map((n) => (
            <li key={n.noticeId} data-row-id={n.noticeId}>
              <button type="button" className="mm-select-row" ref={n.noticeId === detailRef.itemId ? selectedButton : undefined} aria-pressed={n.noticeId === selected?.noticeId} onClick={() => setSelectedId(n.noticeId)}>
                <span className="mm-select-row__text"><strong>{t(n.titleKey)}</strong><span>{t(n.agencyKey)}{'\u00A0'}· {deadlineText(t, n)}</span></span>
                {statusBadge(t, n)}
              </button>
            </li>
          ))}
        </ul>
      )}
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
          <dd>{t.format.date(selected.applyEndDate, 'short')} {t.format.time(selected.applyEndTime)}{'\u00A0'}· {t('widget.grants.daysLeft', { n: selected.daysLeft })}</dd>
        </div>
      </dl>
      <h4 className="mm-card__subtitle">{t('widget.grants.conditions')}</h4>
      <ul className="mm-bullets">{selected.conditionKeys.map((key) => <li key={key}>{t(key)}</li>)}</ul>
      <p>{t(selected.summaryKey)}</p>
      <p className="mm-muted">{t('widget.grants.source', { source: t(m.sourceKey) })}</p>
      <div className="mm-actions">
        {(selected.isCandidate || selected.reviewStatus === 'reviewed' && !m.applications.some(a => a.noticeId === selected.noticeId)) ? <ActionButton onClick={() => run({ type: 'grants.apply', noticeId: selected.noticeId, idempotencyKey: `grant-${selected.noticeId}-${++applicationSequence}` }, t.locale === 'ko' ? { messageKey: 'data.management.notice.grantApplied', params: { name: t(selected.titleKey) } } : undefined)}>{t('widget.grants.apply')}</ActionButton> : null}
        <ActionButton ref={officialOpener} variant="secondary" onClick={() => setOfficial(selected.noticeId)}>{t('common.viewOfficialNotice')}</ActionButton>
        {selected.reviewStatus === 'reviewed'
          ? <StatusBadge kind="reviewed" />
          : <ActionButton variant="secondary" onClick={() => review(selected.noticeId)}>{t('common.markReviewed')}</ActionButton>}
      </div>
      {official === selected.noticeId ? (
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
      <DetailTabs value={tab} onValueChange={setTab} label={t('widget.grants.tabs')} tabs={[{ value: 'notices', label: t('widget.grants.notices') }, { value: 'template', label: t('widget.grants.template') }, { value: 'applications', label: t('widget.grants.applications') }]} />
      {tab === 'notices' ? <MasterDetail list={list} detail={detail} listLabel={t('widget.grants.listTitle')} detailLabel={t('widget.grants.conditions')} /> : tab === 'template' ? (
        <GrantDraftView notices={m.notices} initialId={selected?.noticeId ?? (selectedId ? EMPTY_SAMPLE : undefined)}
          prefill={typeof prefill?.body === 'string' ? prefill.body : undefined} focusAction={detailRef.focus === 'action'} />
      ) : <section className="mm-card mm-detail__grid"><DataGrid ref={grid} id="grant-applications" label={t('widget.grants.applications')} rowActionsLabel={t('widget.grants.deleteColumn')} rows={m.applications} getRowId={a => a.applicationId} getRowLabel={a => resolveDataText(t, a.title)} columns={[
        { id: 'name', header: t('widget.grants.applicationName'), kind: 'text', minWidth: 200, value: a => resolveDataText(t, a.title) },
        { id: 'date', header: t('widget.grants.appliedOn'), kind: 'text', minWidth: 140, value: a => a.appliedOn, render: a => t.format.date(a.appliedOn, 'short'), accessibleValue: a => t.format.date(a.appliedOn, 'short') },
        { id: 'status', header: t('widget.grants.applicationStatus'), kind: 'status', minWidth: 140, value: a => a.status, accessibleValue: a => t(`widget.grants.${a.status}`), render: a => <StatusChip semantic={applicationSemantic[a.status]}>{t(`widget.grants.${a.status}`)}</StatusChip>, editable: () => true, editor: 'select', options: ['applied', 'reviewing', 'selected', 'rejected', 'completed'].map(value => ({ value, label: t(`widget.grants.${value}`) })) },
        { id: 'memo', header: t('widget.grants.resultMemo'), kind: 'text', minWidth: 200, value: a => resolveDataText(t, a.resultMemo), editable: () => true },
      ] satisfies GridColumn<GrantsModel['applications'][number]>[]} sort={gridSort} onSortChange={setGridSort} focus={gridFocus} onFocusChange={setGridFocus} selectedRowId={null} expandedRowIds={new Set()} toolbar={m.applications.length === 0 ? <ActionButton variant="secondary" onClick={() => setTab('notices')}>{t('widget.grants.openNotices')}</ActionButton> : undefined} emptyContent={<div className="mm-grid-empty"><p>{t('widget.grants.noApplications')}</p><p className="mm-muted">{t('widget.grants.noApplicationsHint')}</p></div>} getRowActions={a => [{ id: 'delete', label: t('widget.grants.delete'), onPress: () => { run({ type: 'grants.deleteApplication', applicationId: a.applicationId }); } }]} onCommit={({ rowId, columnId, raw }) => {
        const result = columnId === 'status' ? run({ type: 'grants.updateApplication', applicationId: rowId, status: raw as GrantsModel['applications'][number]['status'] }) : run({ type: 'grants.updateApplication', applicationId: rowId, resultMemo: raw });
        return result.ok ? { ok: true } : { ok: false, error: { id: result.code, message: t(result.messageKey) } };
      }} /></section>}
    </div>
  );
}

const EMPTY_SAMPLE = 'empty';
const GRANT_MAX_LENGTH = 900;

function EmptyGrantDraft({ action }: { readonly action?: ReactNode }) {
  const { t } = useNaverDraftCopy();
  return <InlineEmpty title={t('widget.grants.draft.empty')} action={action} />;
}

function GrantDraftView({ notices, initialId, prefill, focusAction }: {
  readonly notices: readonly GrantRow[]; readonly initialId?: string; readonly prefill?: string; readonly focusAction?: boolean;
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
      <li><button type="button" className="mm-select-row" aria-pressed={!notice} onClick={() => setSample(EMPTY_SAMPLE)}>{draftCopy.t('widget.grants.draft.emptySample')}</button></li>
    </ul>
  );
  return (
    <MasterDetail list={list} detail={<GrantDraftEditor key={sample} notice={notice}
      prefill={sample === initialId && notice ? prefill : undefined} focusAction={sample === initialId && focusAction} />} listLabel={t('widget.grants.listTitle')} detailLabel={t('widget.grants.template')} />
  );
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
