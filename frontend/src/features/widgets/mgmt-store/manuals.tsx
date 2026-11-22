/** 매뉴얼 작성 (manuals, F-39): manual list, today's checklist, note-to-draft flow. */
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps, WidgetHost } from '../../../contracts';
import { ActionButton, ChipChoice, ChecklistProgress, ChecklistRow, DetailFooterContent, DetailTabs, Icon, InlineEmpty, InlineError, InlineForm, MasterDetail, StatusBadge, Textarea, TextField } from '../../../ui';
import { useRealPort, useRealRetry, useWidgetDataStore, useWidgetView } from '../../../data/react';
import type { ManualRow, ManualsModel } from '../../../data/widget-data';
import { businessDayForManual } from '../../../data/reality/11/adapter';
import { notifyInsight, useInsightCommand } from '../../../data/reality/11/use-insight-command';
import { useI18n } from '../../../i18n';
import { DetailState, PanelLayout, RowList, splitCount, StatePanel, text, useRowBudget, useT, type T } from './shared';
import { ManualConfirmation } from './manuals.confirmation';
import { ManualStepPhoto } from './manuals.photo';
import { ValueSlot } from '../mgmt-money/value-slot';
import { keepDots } from '../mgmt-money/fit';
import { manualsGrantsDetailPrefill } from '../../assistant/domains/manuals-grants';
import { naverDraftErrorText, setDraftInputLanguage, useNaverDraft, useNaverDraftCopy, type ManualDraft } from '../naver-drafts';

/** Opening, closing and new-staff first (the 1×2 list in plan-1), then the rest. */
const PRIORITY = ['opening', 'closing', 'new-staff', 'recipe', 'cleaning', 'hygiene'];
const byPriority = (a: ManualRow, b: ManualRow): number => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category);
const storeInfoBody = (t: T, manual: ManualRow) => {
  const body = text(t, manual.body).trim() || manual.steps.map(step => text(t, step.body)).join('\n');
  return body.replace(/,\s*가상 주소(?=\))|\s*\(가상 주소\)/gu, '').trim();
};
const doneOf = (m: ManualRow): number => m.steps.filter((s) => s.checkedToday).length;
const CATEGORIES = ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene'] as const;
type ManualWithPhotos = Omit<ManualRow, 'steps'> & { readonly steps: readonly (ManualRow['steps'][number] & { readonly photoKey?: string })[] };
const manualCautions = (t: T, manual: ManualRow) => {
  const value = text(t, manual.cautions);
  return value === '가상 교육용 매뉴얼' ? '' : value;
};

function useManualsView(condition: WidgetPanelProps['condition']) {
  const view = useWidgetView('manuals', condition);
  const store = useWidgetDataStore();
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  if (view.status !== 'ready' || store.real?.mode('manuals') !== 'http') return view;
  const manuals = view.model.manuals.map(manual => {
    const day = businessDayForManual(snapshot, manual.manualId);
    const progress = new Set(snapshot.tables.checklistLog.filter(row => row.manualId === manual.manualId && row.date === day).map(row => row.stepNo));
    const photos = new Map(snapshot.tables.manualStep.filter(row => row.manualId === manual.manualId).map(row => [row.stepNo, row.photoKey]));
    return { ...manual, steps: manual.steps.map(step => ({ ...step, checkedToday: progress.has(step.stepNo), photoKey: photos.get(step.stepNo) })) };
  });
  const todayChecklist = manuals.filter(manual => manual.checklist).map(manual => ({ manualId: manual.manualId, title: manual.title, done: doneOf(manual), total: manual.steps.length }));
  return { ...view, model: { ...view.model, manuals, todayChecklist } };
}

function ManualProgress({ done, total }: { done: number; total: number }) {
  const t = useT();
  return <span className="mgmt-checklist-progress"><span>{t.t('widget.manuals.progressSentence', { done, total })}<span className="ui-sr-only"><ChecklistProgress done={done} total={total} /></span></span><span className="mgmt-checklist-segments" aria-hidden="true">{Array.from({ length: total }, (_, i) => <span key={i} data-complete={i < done} />)}</span></span>;
}
function ManualsPanel({ shape, width, height, host, condition }: WidgetPanelProps) {
  const t = useT();
  const { format } = useI18n();
  const view = useManualsView(condition);
  const retry = useRealRetry('manuals');
  const budget = useRowBudget(shape, height);
  if (view.status !== 'ready') return <StatePanel id="manuals" shape={shape} view={view} host={view.messageKey === 'data.real.error' ? { ...host, resetPreview: retry } : host} open={{ featureId: 'manuals', focus: 'action' }} />;
  const model = view.model;
  const count = splitCount(format, model.publishedCount, 'item');
  const ordered = [...model.manuals].sort(byPriority);
  let list;
  if (shape === 'W') {
    list = <RowList slot="manuals" title={t.t('widget.manuals.recent')} rows={model.recent.map((m) => ({ id: m.manualId, name: text(t, m.title) }))} />;
  } else if (shape === 'T') {
    list = <RowList slot="manuals" rows={(height >= 3 ? ordered : ordered.slice(0, budget)).map((m) => ({ id: m.manualId, name: text(t, m.title) }))} label={t.t('widget.manuals.listLabel')} />;
  } else if (shape !== 'Q') {
    /** D-333: the big sizes (3x3 up, 4x2) name the manuals of each category and list every checklist of today (the reverse of the drop order). */
    const large = (width >= 3 && height >= 3) || (width === 4 && height >= 2);
    const titlesOf = (category: string): string => model.manuals.filter((m) => m.category === category).map((m) => text(t, m.title)).join(' · ');
    const fullList = width === 4 && height === 4;
    const categoryRows = model.byCategory.map((c) => ({ id: c.category, name: t.t(c.categoryKey), value: format.count(c.count, 'item'), sub: large && !fullList && titlesOf(c.category) ? keepDots(titlesOf(c.category)) : undefined }));
    const checklistRows = model.todayChecklist.map((c) => ({ id: `check-${c.manualId}`, name: text(t, c.title), value: <ValueSlot slotId={`manuals.dashboard.checklist.${c.manualId}`} featureId="manuals" scope="dashboard" semanticValue={`${c.done}/${c.total}`}><ManualProgress done={c.done} total={c.total} /></ValueSlot> }));
    list = (
      <>
        <RowList slot="manuals" rows={categoryRows} title={t.t('widget.manuals.category')} label={t.t('widget.manuals.listLabel')} />
        <RowList slot="manuals" title={t.t('widget.manuals.todayChecklist')} rows={large ? checklistRows : checklistRows.slice(0, 2)} />
        {fullList && <RowList slot="manuals" title={t.t('widget.manuals.listLabel')} rows={ordered.filter(m => !m.checklist).map(m => ({ id: m.manualId, name: text(t, m.title), sub: t.t(m.categoryKey) }))} label={t.t('widget.manuals.listLabel')} />}
      </>
    );
  }
  return <PanelLayout id="manuals" shape={shape} width={width} height={height} label={t.t('widget.manuals.handoverPanel')} sub={t.t('widget.manuals.storeCount', { n: model.storeInfoCount })} subSemanticValue={model.storeInfoCount} value={count.value} semanticValue={model.publishedCount} unit={count.unit} longest="888" list={list} />;
}

/** Note → draft form. `onCreated` runs after the draft exists. */
function MemoForm({ host, onClose, onCreated }: { readonly host: WidgetHost; readonly onClose: () => void; readonly onCreated?: () => void }) {
  const t = useT();
  const { run, pending } = useInsightCommand(host);
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const save = async () => {
    const result = await run({ type: 'manuals.createDraftFromMemo', memo });
    if (!result) return;
    if (!result.ok) { setError(t.t(result.messageKey)); return; }
    onClose();
    onCreated?.();
  };
  return (
    <InlineForm title={t.t('widget.manuals.fromNote')} onSave={save} onClose={onClose} saving={pending} saveLabel={t.t('widget.manuals.makeDraft')}>
      <Textarea label={t.t('widget.manuals.memoLabel')} value={memo} disabled={pending} onValueChange={(v) => { setMemo(v); setError(undefined); }} error={error} hint={t.t('widget.manuals.memoHint')} />
    </InlineForm>
  );
}

function DraftFace({ draft, host }: { readonly draft: ManualsModel['drafts'][number]; readonly host: WidgetHost }) {
  const t = useT();
  const { run, pending, http } = useInsightCommand(host);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const [category, setCategory] = useState(draft.category);
  const [title, setTitle] = useState(text(t, draft.title));
  const [content, setContent] = useState(draft.steps.map(step => text(t, step)).join('\n'));
  const save = async () => {
    setError(undefined);
    const steps = category === 'store-info' ? [content] : content.split('\n').map(step => step.trim()).filter(Boolean);
    const result = await run(http ? { type: 'manuals.saveDraft', draftId: draft.draftId, title, steps, category } : { type: 'manuals.saveDraft', draftId: draft.draftId });
    if (result && !result.ok) setError(t.t(result.messageKey));
    if (result?.ok) setConfirm(false);
  };
  return (
    <div className="ui-draft-card" data-slot="manuals.draft" data-row-id={draft.draftId}>
      <span className="ui-draft-card__label">{t.t('common.draft')}</span>
      {http ? <>
        <TextField label={t.t('widget.manuals.draftTitle')} value={title} onValueChange={setTitle} />
        {draft.category !== 'store-info' && <ChipChoice label={t.t('widget.manuals.category')} value={category} onChange={setCategory} options={CATEGORIES.map(value => ({ value, label: value === 'cleaning' && t.locale === 'ko' ? '청소' : t.t(`data.manualCategory.${value}`) }))} />}
        <Textarea label={t.t('widget.manuals.content')} value={content} onValueChange={setContent} />
      </> : <p className="ui-draft-card__text"><strong>{text(t, draft.title)}</strong>{'\n'}{draft.steps.map((s, i) => `${i + 1}. ${text(t, s)}`).join('\n')}</p>}
      <p className="mgmt-note">{t.t('widget.manuals.draftNote')}</p>
      <div className="ui-draft-card__actions"><ActionButton disabled={pending || !title.trim()} onClick={() => { if (http) { setError(undefined); setConfirm(true); } else void save(); }}>{t.t('common.saveAction')}</ActionButton></div>
      {http && <ManualConfirmation open={confirm} purpose="publish" name={title} pending={pending} error={error} onClose={() => setConfirm(false)} onConfirm={save} />}
    </div>
  );
}

function ManualBody({ manual, host }: { readonly manual: ManualWithPhotos; readonly host: WidgetHost }) {
  const t = useT();
  const { run, pending } = useInsightCommand(host);
  const port = useRealPort();
  const files = port?.mode('manuals') === 'http' ? port.files : undefined;
  const photo = ({ photoKey, stepNo }: ManualWithPhotos['steps'][number]) => files && photoKey
    ? <ManualStepPhoto key={photoKey} files={files} fileId={photoKey} stepNo={stepNo} /> : null;
  /** A check the data layer refused (NOT_CHECKLIST): said in words under that step, never as a saved toast. */
  const [stepError, setStepError] = useState<{ readonly stepNo: number; readonly message: string }>();
  const done = doneOf(manual);
  const cautions = manualCautions(t, manual);
  return (
    <div className="mgmt-manual" data-row-id={manual.manualId}>
      <header className="mgmt-manual__head">
        <div className="mgmt-manual__heading">
          <h3 className="mgmt-manual__title">{text(t, manual.title)}</h3>
          <p className="mgmt-note">{t.t(manual.categoryKey)}</p>
        </div>
        {manual.checklist ? <span className="mgmt-progress"><ValueSlot slotId={`manuals.detail.progress.${manual.manualId}`} featureId="manuals" scope="detail" semanticValue={`${done}/${manual.steps.length}`}><ManualProgress done={done} total={manual.steps.length} /></ValueSlot></span> : null}
      </header>
      {manual.section === 'store-info' ? (
        <p className="mgmt-lead mgmt-manual__body" data-slot="manuals.body"><ValueSlot slotId={`manuals.detail.body.${manual.manualId}`} featureId="manuals" scope="detail" semanticValue={storeInfoBody(t, manual)}>{storeInfoBody(t, manual)}</ValueSlot></p>
      ) : (
        <section className="mgmt-manual__procedure">
          <h4 className="mgmt-manual__section-title">{t.t('widget.manuals.procedures')}</h4>
          {manual.steps.length === 0 ? <p className="mgmt-note">{t.t('widget.manuals.noSteps')}</p> : manual.checklist ? (
            <div className="mgmt-manual-steps" role="group" aria-busy={pending || undefined} aria-label={`${text(t, manual.title)} ${t.t('widget.manuals.todayChecklist')}`}>
              {manual.steps.map((step) => (
                <div key={step.stepNo} className="mgmt-manual-step">
                  <ValueSlot as="div" slotId={`manuals.editor.${manual.manualId}.step.${step.stepNo}`} featureId="manuals" scope="editor" semanticValue={step.checkedToday}>
                    <ChecklistRow checked={step.checkedToday} disabled={pending} onCheckedChange={async checked => {
                      const result = await run({ type: 'manuals.toggleStep', manualId: manual.manualId, stepNo: step.stepNo, checked }, { quiet: true });
                      if (!result) return;
                      setStepError(result.ok ? undefined : { stepNo: step.stepNo, message: t.t(result.messageKey) });
                      if (result.ok && checked && t.locale === 'ko') notifyInsight(host, result, { messageKey: 'data.management.notice.stepCompleted', params: { name: text(t, step.body) } });
                    }}>{text(t, step.body)}</ChecklistRow>
                  </ValueSlot>
                  {photo(step)}
                  {stepError?.stepNo === step.stepNo ? <p className="ui-field__error" role="alert"><Icon name="error" />{stepError.message}</p> : null}
                </div>
              ))}
            </div>
          ) : (
            <ol className="mgmt-steps mgmt-manual-steps">
              {manual.steps.map((step) => <li key={step.stepNo}><div className="mgmt-manual-step">{text(t, step.body)}{photo(step)}</div></li>)}
            </ol>
          )}
        </section>
      )}
      {cautions ? <p className="mgmt-lead">{t.t('widget.manuals.cautions')}: {cautions}</p> : null}
    </div>
  );
}

function ManualsDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const { format } = useI18n();
  const view = useManualsView(condition);
  const port = useRealPort();
  const retry = useRealRetry('manuals');
  const [tab, setTab] = useState<string>('all');
  const [section, setSection] = useState<'handover' | 'store-info'>(() => detailRef.view === 'store-info' ||
    view.status === 'ready' && view.model.storeInfo.some(manual => manual.manualId === detailRef.itemId) ? 'store-info' : 'handover');
  const [editor, setEditor] = useState<'create' | 'edit' | null>(detailRef.focus === 'action' ? (detailRef.itemId ? 'edit' : 'create') : null);
  const { run, pending, http } = useInsightCommand(host);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string>();
  const [selected, setSelected] = useState<string | null>(detailRef.itemId ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const [seedActive, setSeedActive] = useState(detailRef.focus === 'action');
  useEffect(() => {
    if (detailRef.itemId && !detailRef.focus) selectedButton.current?.focus();
  }, [detailRef.itemId, detailRef.focus, view.status]);
  useEffect(() => {
    if (port?.mode('manuals') !== 'http') return;
    if (port.state('manuals').status === 'ready') retry();
    window.addEventListener('focus', retry);
    return () => window.removeEventListener('focus', retry);
  }, [port, retry]);
  if (view.status !== 'ready') {
    return (
      <div className="mgmt-detail" data-widget="manuals">
        <DetailState view={view} host={view.messageKey === 'data.real.error' ? { ...host, resetPreview: retry } : host} onAction={() => { host.resetPreview(); setEditor('create'); }} />
      </div>
    );
  }
  const model = view.model;
  const tabs = [{ value: 'all', label: t.t('widget.manuals.all') }, ...model.byCategory.map((c) => ({ value: c.category as string, label: `${t.t(c.categoryKey)} ${format.count(c.count, 'item')}` }))];
  const effectiveSection = selected && model.storeInfo.some(manual => manual.manualId === selected) ? 'store-info' : section;
  const visible = (effectiveSection === 'handover' ? model.manuals : model.storeInfo).filter((m) => effectiveSection === 'store-info' || tab === 'all' || m.category === tab);
  const current = selected ? visible.find((m) => m.manualId === selected) ?? null : visible[0] ?? null;
  const seed = editor === 'create' && seedActive ? manualsGrantsDetailPrefill(detailRef) : undefined;
  const toDelete = visible.find(manual => manual.manualId === deleteId);

  const list = (
    <ul className="mgmt-manual-list" aria-label={t.t('widget.manuals.listLabel')}>
      {visible.map((m) => (
        <li key={m.manualId}>
          <button type="button" className="mgmt-manual-item" ref={m.manualId === detailRef.itemId ? selectedButton : undefined} aria-current={current?.manualId === m.manualId ? 'true' : undefined} onClick={() => setSelected(m.manualId)} data-row-id={m.manualId}>
            <span className="mgmt-manual-item__title">{text(t, m.title)}</span>
            <span className="mgmt-manual-item__meta">{m.section === 'store-info' ? t.t(m.categoryKey) : t.t('widget.manuals.stepCount', { n: m.steps.length })}{m.checklist ? <StatusBadge kind="checked" semantic="none" tone="neutral" label={t.t('widget.manuals.checklistBadge')} /> : null}</span>
          </button>
        </li>
      ))}
    </ul>
  );
  const detail = editor === 'create' ? (
    <ManualDraftEditor initialSection={effectiveSection} seed={seed} focusTitle={seedActive}
      host={host} button={createButton} onClose={() => { setSeedActive(false); setEditor(null); }}
      onSaved={(nextSection, manualId) => {
        setSeedActive(false);
        setSection(nextSection);
        setTab('all');
        setSelected(manualId);
        setEditor(null);
      }} />
  ) : (
    <div className="mgmt-manual-pane">
      {editor === 'edit' && current ? <ManualEditor key={current.manualId} manual={current} focusTitle={seedActive} host={host} onClose={() => setEditor(null)} /> : current ? (
        <>
          <ManualBody key={current.manualId} manual={current} host={host} />
          <DetailFooterContent><div className="mgmt-actions mgmt-manual__actions">
            <ActionButton variant="outline" onClick={() => setEditor('edit')}>{t.t('widget.manuals.edit')}</ActionButton>
            <ActionButton variant="destructive" onClick={() => { host.supersedeSuccessNotice?.(); setDeleteError(undefined); setDeleteId(current.manualId); }}>{t.t('widget.manuals.delete')}</ActionButton>
          </div></DetailFooterContent>
        </>
      ) : http && !visible.length ? <InlineEmpty title={t.t('data.state.manuals.none')} /> : null}
      <div className="mgmt-block">
        {formOpen ? <MemoForm host={host} onClose={() => setFormOpen(false)} /> : <div><ActionButton variant="secondary" onClick={() => setFormOpen(true)}>{t.t('widget.manuals.fromNote')}</ActionButton></div>}
        {model.drafts.map((d) => <DraftFace key={d.draftId} draft={d} host={host} />)}
      </div>
    </div>
  );
  return (
    <div className="mgmt-detail" data-widget="manuals">
      <DetailTabs value={effectiveSection} onValueChange={(v) => { setSection(v); setTab('all'); setSelected(null); setEditor(null); setSeedActive(false); }} label={t.t('widget.manuals.sectionTabs')} tabs={[{ value: 'handover', label: `${t.t('widget.manuals.handover')} ${format.count(model.publishedCount, 'item')}` }, { value: 'store-info', label: t.t('widget.manuals.storeCount', { n: model.storeInfoCount }) }]} />
      {effectiveSection === 'handover' ? <DetailTabs value={tab} onValueChange={(v) => { setTab(v); setSelected(null); }} tabs={tabs} label={t.t('widget.manuals.tabsLabel')} /> : null}
      {http && view.notes?.map(note => <p key={note.messageKey} role="status" className="mgmt-note">{t.t(note.messageKey)} <ActionButton variant="secondary" onClick={retry}>{t.t('common.retry')}</ActionButton></p>)}
      <div className="mgmt-detail-toolbar"><ActionButton ref={createButton} variant="secondary" aria-expanded={editor === 'create'} onClick={() => setEditor('create')}>{t.t('widget.manuals.createDocument')}</ActionButton></div>
      <MasterDetail list={list} detail={detail} listLabel={t.t('widget.manuals.listLabel')} detailLabel={t.t('widget.manuals.steps')} />
      {toDelete && <ManualConfirmation open purpose="delete" name={text(t, toDelete.title)} pending={pending} error={deleteError} onClose={() => setDeleteId(null)} onConfirm={async () => {
        const result = await run({ type: 'manuals.delete', manualId: toDelete.manualId });
        if (result?.ok) { setSelected(null); setDeleteId(null); }
        else if (result) setDeleteError(t.t(result.messageKey));
      }} />}
    </div>
  );
}

function useManualsSummary({ condition }: { featureId: string; condition: WidgetPanelProps['condition'] }): string {
  const t: T = useT();
  const { format } = useI18n();
  const view = useWidgetView('manuals', condition);
  if (view.status !== 'ready') return t.t(view.messageKey);
  return `${t.t('widget.manuals.handover')} ${format.count(view.model.publishedCount, 'item')} · ${t.t('widget.manuals.storeCount', { n: view.model.storeInfoCount })}`;
}

type ManualSection = ManualRow['section'];
const noteCategories = { 'mn-open': 'opening', 'mn-close': 'closing', 'mn-newstaff': 'new-staff' } as const;
const noteKeys = ['mn-open', 'mn-close', 'mn-newstaff'] as const;
type Note = typeof noteKeys[number] | 'empty' | '';
const MAX_STEPS = 5;
const MAX_MANUAL_LENGTH = 700;
const blankDraft: ManualDraft = { title: '', steps: [''], cautions: '' };
let manualSequence = 0;

function ManualDraftEditor({ initialSection, seed, focusTitle, host, button, onClose, onSaved }: {
  readonly initialSection: ManualSection;
  readonly seed?: Readonly<Record<string, unknown>>;
  readonly focusTitle?: boolean;
  readonly host: WidgetHost;
  readonly button: RefObject<HTMLButtonElement | null>;
  readonly onClose: () => void;
  readonly onSaved: (section: ManualSection, manualId: string | null) => void;
}) {
  const t = useT();
  const draftCopy = useNaverDraftCopy();
  const { run, http, pending } = useInsightCommand(host);
  const [confirm, setConfirm] = useState(false);
  const attempt = useRef<{ payload: string; key: string } | undefined>(undefined);
  const { generation, generate, reset } = useNaverDraft('manuals');
  const [section, setSection] = useState<ManualSection>(
    seed?.section === 'store-info' || seed?.section === 'handover' ? seed.section : initialSection);
  const [sample, setSample] = useState<Note>('');
  const [fields, setFields] = useState<ManualDraft>(() => ({
    title: typeof seed?.title === 'string' ? seed.title : blankDraft.title,
    steps: Array.isArray(seed?.steps) ? seed.steps.map((step: string | { body: string }) => typeof step === 'string' ? step : step.body) : blankDraft.steps,
    cautions: typeof seed?.cautions === 'string' ? seed.cautions : blankDraft.cautions,
  }));
  const category = seed?.category;
  const [generatedCategory, setGeneratedCategory] = useState<ManualRow['category']>(
    category === 'opening' || category === 'closing' || category === 'recipe' || category === 'cleaning' || category === 'new-staff' ? category : 'hygiene');
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusTitle) titleInput.current?.focus(); }, [focusTitle]);
  const [titleError, setTitleError] = useState<string>();
  const [stepsError, setStepsError] = useState<string>();
  const [commandError, setCommandError] = useState<string>();
  /** MANUAL_TITLE_EXISTS: the data layer asked once; the owner can say yes (그래도 저장하기) or leave it (그대로 두기). */
  const [titleAsked, setTitleAsked] = useState(false);
  const clearErrors = () => { setTitleError(undefined); setStepsError(undefined); setCommandError(undefined); setTitleAsked(false); };
  const asked = useRef<HTMLDivElement>(null);
  // The question sits under the title, but the save button is pinned at the bottom of a long form: bring the question into view.
  useEffect(() => { if (titleAsked) asked.current?.scrollIntoView?.({ block: 'nearest' }); }, [titleAsked]);
  const { title, steps, cautions } = fields;
  const count = title.length + steps.join('').length + cautions.length;
  const tooLong = count > MAX_MANUAL_LENGTH;
  const loading = generation.status === 'loading';

  function start() {
    if (!sample) return;
    clearErrors();
    void generate(sample === 'empty' ? null : sample, draft => {
      setFields(draft?.content ?? blankDraft);
      setGeneratedCategory(draft && sample !== 'empty' ? noteCategories[sample] : 'hygiene');
    });
  }

  async function save(confirmDuplicate = false) {
    clearErrors();
    // SCR-222: only the title (and the kind of document) is required; the steps and cautions may follow later.
    if (!title.trim()) { setTitleError(t.t('widget.manuals.titleRequired')); return; }
    const lines = steps.map(step => step.trim()).filter(Boolean);
    // Store information is a single published body used by both the widget and Navis.
    const body = lines.length > 1 ? lines.map((step, index) => `${index + 1}. ${step}`).join('\n') : lines[0];
    if (http && !confirm && !confirmDuplicate) { setConfirm(true); return; }
    const input = {
      type: 'manuals.create' as const, section, title: title.trim(), category: section === 'store-info' ? 'store-info' as const : generatedCategory,
      steps: section === 'store-info' ? (body ? [body] : []) : lines, cautions,
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
    };
    const payload = JSON.stringify(input);
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: http ? globalThis.crypto.randomUUID() : `manual-${++manualSequence}` };
    const result = await run({ ...input, idempotencyKey: attempt.current.key });
    if (!result) return;
    if (!result.ok) {
      if (!result.outcomeUnknown) attempt.current = undefined;
      if (result.reason === 'MANUAL_TITLE_EXISTS' || result.reason === 'DUPLICATE_MANUAL_TITLE') { setConfirm(false); setTitleAsked(true); setTitleError(t.t(result.messageKey)); return; }
      if (result.reason === 'STEPS_INVALID') { setStepsError(t.t(result.messageKey)); return; }
      setCommandError(t.t(result.messageKey));
      return;
    }
    const value = result.value as { manualId?: string; resourceId?: string } | undefined;
    onSaved(section, value?.resourceId ?? value?.manualId ?? null);
  }

  return (
    <div className="mgmt-manual-draft">
      <InlineForm footerActions title={t.t('widget.manuals.createDocument')} returnFocusRef={button} onClose={onClose} onSave={() => void save()} saveDisabled={loading || tooLong} saving={pending}>
        <p className="mgmt-note">{t.t('widget.manuals.category')}</p>
        <ChipChoice label={t.t('widget.manuals.category')} value={section} onChange={setSection} options={[
          { value: 'handover', label: t.t('widget.manuals.handover') }, { value: 'store-info', label: t.t('widget.manuals.storeInfo') },
        ]} />
        {http ? section === 'handover' && <ChipChoice label={t.t('widget.manuals.category')} value={generatedCategory} onChange={setGeneratedCategory}
          options={CATEGORIES.map(value => ({ value, label: value === 'cleaning' && t.locale === 'ko' ? '청소' : t.t(`data.manualCategory.${value}`) }))} /> : <>
        <p className="mgmt-note">{t.t('widget.manuals.sampleNote')}</p>
        <ChipChoice label={t.t('widget.manuals.sampleNote')} value={sample} onChange={value => { if (value !== sample) { reset(); setSample(value); } }}
          options={[
            ...noteKeys.map(value => ({ value, label: t.t(`widget.manuals.note.${value}`) })),
            { value: 'empty', label: draftCopy.t('widget.grants.draft.emptySample') },
          ]} />
        <div className="mgmt-actions">
          {generation.status === 'error'
            ? <InlineError message={naverDraftErrorText(generation, draftCopy.t)} onRetry={start} />
            : <ActionButton variant="secondary" disabled={!sample || loading} aria-busy={loading || undefined} onClick={start}>{t.t('widget.manuals.generate')}</ActionButton>}
          {loading && <p role="status">{draftCopy.t('widget.grants.draft.loading')}</p>}
        </div>
        {generation.status === 'empty' && <InlineEmpty title={draftCopy.t('widget.grants.draft.empty')} />}
        </>}
        <div className="mgmt-manual-draft__fields">
          <TextField label={t.t('widget.manuals.draftTitle')} value={title} disabled={loading} inputRef={field => { titleInput.current = field; setDraftInputLanguage(field); }}
            onValueChange={value => { setFields(previous => ({ ...previous, title: value })); setTitleError(undefined); setTitleAsked(false); }}
            error={titleError} />
          {titleAsked && <div ref={asked} className="mgmt-actions" data-slot="manuals.title-asked">
            <ActionButton variant="secondary" loading={pending} onClick={() => void save(true)}>{t.t('widget.manuals.saveAnyway')}</ActionButton>
            <ActionButton variant="outline" onClick={onClose}>{t.t('widget.manuals.leaveAsIs')}</ActionButton>
          </div>}
          <fieldset className="mgmt-manual-draft__steps">
            <legend>{t.t('widget.manuals.procedures')}</legend>
            <ol>
              {steps.map((step, index) => (
                <li key={index}>
                  <TextField label={t.t('widget.manuals.editStep', { n: index + 1 })} value={step} disabled={loading} inputRef={setDraftInputLanguage}
                    onValueChange={value => {
                      setFields(previous => ({ ...previous, steps: previous.steps.map((line, i) => i === index ? value : line) }));
                      setStepsError(undefined);
                    }}
                    error={index === 0 ? stepsError : undefined} />
                </li>
              ))}
            </ol>
            {steps.length < MAX_STEPS && <ActionButton variant="secondary" disabled={loading}
              onClick={() => setFields(previous => previous.steps.length < MAX_STEPS ? { ...previous, steps: [...previous.steps, ''] } : previous)}>
              {t.t('widget.manuals.addStep')}
            </ActionButton>}
          </fieldset>
          <Textarea label={t.t('widget.manuals.optionalCautions')} value={cautions} disabled={loading} inputRef={setDraftInputLanguage}
            onValueChange={value => setFields(previous => ({ ...previous, cautions: value }))}
            hint={draftCopy.t('widget.grants.draft.count', { n: count, max: MAX_MANUAL_LENGTH })}
            error={tooLong ? draftCopy.t('widget.grants.draft.tooLong', { max: MAX_MANUAL_LENGTH }) : undefined} />
        </div>
        {commandError && !confirm && <p className="ui-field__error" role="alert">{commandError}</p>}
      </InlineForm>
      {http && <ManualConfirmation open={confirm} purpose="publish" name={title} pending={pending} error={commandError} onClose={() => setConfirm(false)} onConfirm={() => void save()} />}
    </div>
  );
}

function ManualEditor({ manual, focusTitle, host, onClose }: { manual: ManualWithPhotos; focusTitle: boolean; host: WidgetHost; onClose: () => void }) {
  const t = useT();
  const { run, pending } = useInsightCommand(host);
  const { section } = manual;
  const [title, setTitle] = useState(text(t, manual.title));
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusTitle) titleInput.current?.focus(); }, [focusTitle]);
  const [content, setContent] = useState(section === 'store-info' ? storeInfoBody(t, manual) : manual.steps.map(step => text(t, step.body)).join('\n'));
  const [cautions, setCautions] = useState(() => manualCautions(t, manual));
  const [category, setCategory] = useState(manual.category);
  const [error, setError] = useState<string>();
  return <InlineForm footerActions title={t.t('widget.manuals.edit')} onClose={onClose} saving={pending} onSave={async () => {
    if (!title.trim()) { setError(t.t('widget.manuals.titleRequired')); return; }
    const lines = section === 'store-info' ? (content.trim() ? [content.trim()] : []) : content.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.length) { setError(t.t('widget.manuals.contentRequired')); return; }
    const attached = manual.steps.some(step => step.photoKey);
    const original = manual.steps.map(step => ({ body: text(t, step.body).trim(), photoKey: step.photoKey }));
    const unchanged = attached && original.length === lines.length && original.every((step, index) => step.body === lines[index]);
    const steps = unchanged ? undefined : lines.map(body => {
      if (!attached) return body;
      const match = original.findIndex(step => step.body === body);
      if (match < 0) return body;
      const [{ photoKey }] = original.splice(match, 1);
      return photoKey ? { body, photoKey } : body;
    });
    const result = await run({ type: 'manuals.update', manualId: manual.manualId, patch: { section, title: title.trim(), category, steps, cautions } });
    if (result?.ok) onClose(); else if (result) setError(t.t(result.messageKey));
  }}><TextField label={t.t('widget.manuals.draftTitle')} value={title} inputRef={titleInput} onValueChange={setTitle} error={error} /><ChipChoice label={t.t('widget.manuals.category')} value={category} onChange={setCategory} options={(section === 'store-info' ? ['store-info'] as const : ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene'] as const).map(value => ({ value, label: value === 'cleaning' && t.locale === 'ko' ? '청소' : t.t(`data.manualCategory.${value}`) }))} /><Textarea label={t.t('widget.manuals.content')} value={content} onValueChange={setContent} /><Textarea label={t.t('widget.manuals.cautions')} value={cautions} onValueChange={setCautions} /></InlineForm>;
}

export const manualsModule: WidgetModule = { id: 'manuals', Panel: ManualsPanel, Detail: ManualsDetail, useSummary: useManualsSummary };
