/** 매뉴얼 작성 (manuals, F-39): manual list, today's checklist, note-to-draft flow. */
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps, WidgetHost } from '../../../contracts';
import { ActionButton, ChipChoice, ChecklistProgress, ChecklistRow, DetailTabs, Icon, InlineEmpty, InlineError, InlineForm, MasterDetail, StatusBadge, Textarea, TextField } from '../../../ui';
import { useWidgetView } from '../../../data/react';
import type { ManualRow, ManualsModel } from '../../../data/widget-data';
import { useI18n } from '../../../i18n';
import { DetailState, PanelLayout, RowList, splitCount, StatePanel, text, useRowBudget, useRunCommand, useT, type T } from './shared';
import { ValueSlot } from '../mgmt-money/value-slot';
import { manualsGrantsDetailPrefill } from '../../assistant/domains/manuals-grants';
import { naverDraftErrorText, setDraftInputLanguage, useNaverDraft, useNaverDraftCopy, type ManualDraft } from '../naver-drafts';

/** Opening, closing and new-staff first (the 1×2 list in plan-1), then the rest. */
const PRIORITY = ['opening', 'closing', 'new-staff', 'recipe', 'cleaning', 'hygiene'];
const byPriority = (a: ManualRow, b: ManualRow): number => PRIORITY.indexOf(a.category) - PRIORITY.indexOf(b.category);
const doneOf = (m: ManualRow): number => m.steps.filter((s) => s.checkedToday).length;

function ManualProgress({ done, total }: { done: number; total: number }) {
  const t = useT();
  return <span className="mgmt-checklist-progress"><span>{t.t('widget.manuals.progressSentence', { done, total })}<span className="ui-sr-only"><ChecklistProgress done={done} total={total} /></span></span><span className="mgmt-checklist-segments" aria-hidden="true">{Array.from({ length: total }, (_, i) => <span key={i} data-complete={i < done} />)}</span></span>;
}
function StepExample({ stepNo }: { stepNo: number }) {
  const t = useT();
  return <figure className="mgmt-step-example"><svg viewBox="0 0 160 120" width="160" height="120" role="img" aria-label={t.t('widget.manuals.stepExample', { n: stepNo })}><path d="M16 92h128M24 92V30h112v62M40 30v16h80V30M58 66h36v18H58ZM94 69h10v10H94M51 84h51" fill="none" stroke="currentColor" strokeWidth="2" /></svg><figcaption>{t.t('widget.manuals.stepExample', { n: stepNo })}</figcaption></figure>;
}

function ManualsPanel({ shape, width, height, host, condition }: WidgetPanelProps) {
  const t = useT();
  const { format } = useI18n();
  const view = useWidgetView('manuals', condition);
  const budget = useRowBudget(shape, height);
  if (view.status !== 'ready') return <StatePanel id="manuals" shape={shape} view={view} host={host} open={{ featureId: 'manuals', focus: 'action' }} />;
  const model = view.model;
  const count = splitCount(format, model.publishedCount, 'item');
  const ordered = [...model.manuals].sort(byPriority);
  let list;
  if (shape === 'W') {
    list = <RowList slot="manuals" title={t.t('widget.manuals.recent')} rows={model.recent.map((m) => ({ id: m.manualId, name: text(t, m.title) }))} />;
  } else if (shape === 'T') {
    list = <RowList slot="manuals" rows={(height >= 3 ? ordered : ordered.slice(0, budget)).map((m) => ({ id: m.manualId, name: text(t, m.title) }))} label={t.t('widget.manuals.listLabel')} />;
  } else if (shape !== 'Q') {
    const categoryRows = model.byCategory.map((c) => ({ id: c.category, name: t.t(c.categoryKey), value: format.count(c.count, 'item') }));
    const checklistRows = model.todayChecklist.map((c) => ({ id: `check-${c.manualId}`, name: text(t, c.title), value: <ValueSlot slotId={`manuals.dashboard.checklist.${c.manualId}`} featureId="manuals" scope="dashboard" semanticValue={`${c.done}/${c.total}`}><ManualProgress done={c.done} total={c.total} /></ValueSlot> }));
    list = (
      <>
        <RowList slot="manuals" rows={categoryRows} label={t.t('widget.manuals.listLabel')} />
        <RowList slot="manuals" title={t.t('widget.manuals.todayChecklist')} rows={checklistRows.slice(0, 2)} />
      </>
    );
  }
  return <PanelLayout id="manuals" shape={shape} width={width} height={height} label={t.t('widget.manuals.handover')} sub={t.t('widget.manuals.storeCount', { n: model.storeInfoCount })} subSemanticValue={model.storeInfoCount} value={count.value} semanticValue={model.publishedCount} unit={count.unit} longest="888" list={list} />;
}

/** Note → draft form. `onCreated` runs after the draft exists. */
function MemoForm({ host, onClose, onCreated }: { readonly host: WidgetHost; readonly onClose: () => void; readonly onCreated?: () => void }) {
  const t = useT();
  const run = useRunCommand(host);
  const [memo, setMemo] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const save = () => {
    const result = run({ type: 'manuals.createDraftFromMemo', memo });
    if (!result.ok) { setError(t.t(result.messageKey)); return; }
    onClose();
    onCreated?.();
  };
  return (
    <InlineForm title={t.t('widget.manuals.fromNote')} onSave={save} onClose={onClose} saveLabel={t.t('widget.manuals.makeDraft')}>
      <Textarea label={t.t('widget.manuals.memoLabel')} value={memo} onValueChange={(v) => { setMemo(v); setError(undefined); }} error={error} hint={t.t('widget.manuals.memoHint')} />
    </InlineForm>
  );
}

function DraftFace({ draft, host }: { readonly draft: ManualsModel['drafts'][number]; readonly host: WidgetHost }) {
  const t = useT();
  const run = useRunCommand(host);
  return (
    <div className="ui-draft-card" data-slot="manuals.draft" data-row-id={draft.draftId}>
      <span className="ui-draft-card__label">{t.t('common.draft')}</span>
      <p className="ui-draft-card__text"><strong>{text(t, draft.title)}</strong>{'\n'}{draft.steps.map((s, i) => `${i + 1}. ${text(t, s)}`).join('\n')}</p>
      <p className="mgmt-note">{t.t('widget.manuals.draftNote')}</p>
      <div className="ui-draft-card__actions"><ActionButton onClick={() => run({ type: 'manuals.saveDraft', draftId: draft.draftId })}>{t.t('common.saveAction')}</ActionButton></div>
    </div>
  );
}

function ManualBody({ manual, host }: { readonly manual: ManualRow; readonly host: WidgetHost }) {
  const t = useT();
  const run = useRunCommand(host);
  /** A check the data layer refused (NOT_CHECKLIST): said in words under that step, never as a saved toast. */
  const [stepError, setStepError] = useState<{ readonly stepNo: number; readonly message: string }>();
  const done = doneOf(manual);
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
        <p className="mgmt-lead mgmt-manual__body" data-slot="manuals.body"><ValueSlot slotId={`manuals.detail.body.${manual.manualId}`} featureId="manuals" scope="detail" semanticValue={text(t, manual.body)}>{text(t, manual.body)}</ValueSlot></p>
      ) : (
        <section className="mgmt-manual__procedure">
          <h4 className="mgmt-manual__section-title">{t.t('widget.manuals.procedures')}</h4>
          {manual.steps.length === 0 ? <p className="mgmt-note">{t.t('widget.manuals.noSteps')}</p> : manual.checklist ? (
            <div className="mgmt-manual-steps" role="group" aria-label={`${text(t, manual.title)} ${t.t('widget.manuals.todayChecklist')}`}>
              {manual.steps.map((step) => (
                <div key={step.stepNo} className="mgmt-manual-step">
                  <ValueSlot as="div" slotId={`manuals.editor.${manual.manualId}.step.${step.stepNo}`} featureId="manuals" scope="editor" semanticValue={step.checkedToday}>
                    <ChecklistRow checked={step.checkedToday} onCheckedChange={() => {
                      const result = run({ type: 'manuals.toggleStep', manualId: manual.manualId, stepNo: step.stepNo }, { quiet: true });
                      setStepError(result.ok ? undefined : { stepNo: step.stepNo, message: t.t(result.messageKey) });
                      if (result.ok && !step.checkedToday && t.locale === 'ko') host.notify({ kind: 'success', messageKey: 'data.management.notice.stepCompleted', params: { name: text(t, step.body) }, undoToken: result.undoToken });
                    }}>{text(t, step.body)}</ChecklistRow>
                  </ValueSlot>
                  {stepError?.stepNo === step.stepNo ? <p className="ui-field__error" role="alert"><Icon name="error" />{stepError.message}</p> : null}
                  <StepExample stepNo={step.stepNo} />
                </div>
              ))}
            </div>
          ) : (
            <ol className="mgmt-steps mgmt-manual-steps">
              {manual.steps.map((step) => <li key={step.stepNo}><div className="mgmt-manual-step">{text(t, step.body)}<StepExample stepNo={step.stepNo} /></div></li>)}
            </ol>
          )}
        </section>
      )}
      {text(t, manual.cautions) ? <p className="mgmt-lead">{t.t('widget.manuals.cautions')}: {text(t, manual.cautions)}</p> : null}
    </div>
  );
}

function ManualsDetail({ condition, host, detailRef }: WidgetDetailProps) {
  const t = useT();
  const { format } = useI18n();
  const view = useWidgetView('manuals', condition);
  const [tab, setTab] = useState<string>('all');
  const [section, setSection] = useState<'handover' | 'store-info'>(() => detailRef.view === 'store-info' ||
    view.status === 'ready' && view.model.storeInfo.some(manual => manual.manualId === detailRef.itemId) ? 'store-info' : 'handover');
  const [editor, setEditor] = useState<'create' | 'edit' | null>(detailRef.focus === 'action' ? (detailRef.itemId ? 'edit' : 'create') : null);
  const run = useRunCommand(host);
  const [selected, setSelected] = useState<string | null>(detailRef.itemId ?? null);
  const [formOpen, setFormOpen] = useState(false);
  const createButton = useRef<HTMLButtonElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const [seedActive, setSeedActive] = useState(detailRef.focus === 'action');
  useEffect(() => {
    if (detailRef.itemId && !detailRef.focus) selectedButton.current?.focus();
  }, [detailRef.itemId, detailRef.focus]);
  if (view.status !== 'ready') {
    return (
      <div className="mgmt-detail" data-widget="manuals">
        <DetailState view={view} host={host} onAction={() => { host.resetPreview(); setEditor('create'); }} />
      </div>
    );
  }
  const model = view.model;
  const tabs = [{ value: 'all', label: t.t('widget.manuals.all') }, ...model.byCategory.map((c) => ({ value: c.category as string, label: `${t.t(c.categoryKey)} ${c.count}` }))];
  const visible = (section === 'handover' ? model.manuals : model.storeInfo).filter((m) => section === 'store-info' || tab === 'all' || m.category === tab);
  const current = selected ? visible.find((m) => m.manualId === selected) ?? null : visible[0] ?? null;
  const seed = editor === 'create' && seedActive ? manualsGrantsDetailPrefill(detailRef) : undefined;

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
    <ManualDraftEditor initialSection={section} seed={seed} focusTitle={seedActive}
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
          <div className="mgmt-actions mgmt-manual__actions">
            <ActionButton variant="outline" onClick={() => setEditor('edit')}>{t.t('widget.manuals.edit')}</ActionButton>
            <ActionButton variant="destructive" onClick={() => { run({ type: 'manuals.delete', manualId: current.manualId }); setSelected(null); }}>{t.t('widget.manuals.delete')}</ActionButton>
          </div>
        </>
      ) : null}
      <div className="mgmt-block mgmt-manual-checklist">
        <div className="mgmt-block__head"><h3 className="mgmt-h3">{t.t('widget.manuals.todayChecklist')}</h3></div>
        <RowList slot="manuals" rows={model.todayChecklist.map((c) => ({ id: `check-${c.manualId}`, name: text(t, c.title), value: <ValueSlot slotId={`manuals.detail.checklist.${c.manualId}`} featureId="manuals" scope="detail" semanticValue={`${c.done}/${c.total}`}><ManualProgress done={c.done} total={c.total} /></ValueSlot> }))} label={t.t('widget.manuals.todayChecklist')} />
      </div>
      <div className="mgmt-block">
        {formOpen ? <MemoForm host={host} onClose={() => setFormOpen(false)} /> : <div><ActionButton variant="secondary" onClick={() => setFormOpen(true)}>{t.t('widget.manuals.fromNote')}</ActionButton></div>}
        {model.drafts.map((d) => <DraftFace key={d.draftId} draft={d} host={host} />)}
      </div>
    </div>
  );
  return (
    <div className="mgmt-detail" data-widget="manuals">
      <DetailTabs value={section} onValueChange={(v) => { setSection(v); setTab('all'); setSelected(null); setEditor(null); setSeedActive(false); }} label={t.t('widget.manuals.sectionTabs')} tabs={[{ value: 'handover', label: `${t.t('widget.manuals.handover')} ${format.count(model.publishedCount, 'item')}` }, { value: 'store-info', label: t.t('widget.manuals.storeCount', { n: model.storeInfoCount }) }]} />
      {section === 'handover' ? <DetailTabs value={tab} onValueChange={(v) => { setTab(v); setSelected(null); }} tabs={tabs} label={t.t('widget.manuals.tabsLabel')} /> : null}
      <div className="mgmt-detail-toolbar"><ActionButton ref={createButton} variant="secondary" aria-expanded={editor === 'create'} onClick={() => setEditor('create')}>{t.t('widget.manuals.createDocument')}</ActionButton></div>
      <MasterDetail list={list} detail={detail} listLabel={t.t('widget.manuals.listLabel')} detailLabel={t.t('widget.manuals.steps')} />
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
  const run = useRunCommand(host);
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

  function save(confirmDuplicate = false) {
    clearErrors();
    // SCR-222: only the title (and the kind of document) is required; the steps and cautions may follow later.
    if (!title.trim()) { setTitleError(t.t('widget.manuals.titleRequired')); return; }
    const lines = steps.map(step => step.trim()).filter(Boolean);
    // Store information is a single published body used by both the widget and Navis.
    const body = lines.length > 1 ? lines.map((step, index) => `${index + 1}. ${step}`).join('\n') : lines[0];
    const result = run({
      type: 'manuals.create', section, title: title.trim(), category: section === 'store-info' ? 'store-info' : generatedCategory,
      steps: section === 'store-info' ? (body ? [body] : []) : lines, cautions, idempotencyKey: `manual-${++manualSequence}`,
      ...(confirmDuplicate ? { confirmDuplicate: true } : {}),
    });
    if (!result.ok) {
      if (result.reason === 'MANUAL_TITLE_EXISTS') { setTitleAsked(true); setTitleError(t.t(result.messageKey)); return; }
      if (result.reason === 'STEPS_INVALID') { setStepsError(t.t(result.messageKey)); return; }
      setCommandError(t.t(result.messageKey));
      return;
    }
    const value = result.value;
    onSaved(section, value && typeof value === 'object' && 'manualId' in value && typeof value.manualId === 'string' ? value.manualId : null);
  }

  return (
    <div className="mgmt-manual-draft">
      <InlineForm title={t.t('widget.manuals.createDocument')} returnFocusRef={button} onClose={onClose} onSave={() => save()} saveDisabled={loading || tooLong}>
        <p className="mgmt-note">{t.t('widget.manuals.category')}</p>
        <ChipChoice label={t.t('widget.manuals.category')} value={section} onChange={setSection} options={[
          { value: 'handover', label: t.t('widget.manuals.handover') }, { value: 'store-info', label: t.t('widget.manuals.storeInfo') },
        ]} />
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
        <div className="mgmt-manual-draft__fields">
          <TextField label={t.t('widget.manuals.draftTitle')} value={title} disabled={loading} inputRef={field => { titleInput.current = field; setDraftInputLanguage(field); }}
            onValueChange={value => { setFields(previous => ({ ...previous, title: value })); setTitleError(undefined); setTitleAsked(false); }}
            error={titleError} />
          {titleAsked && <div ref={asked} className="mgmt-actions" data-slot="manuals.title-asked">
            <ActionButton variant="secondary" onClick={() => save(true)}>{t.t('widget.manuals.saveAnyway')}</ActionButton>
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
        {commandError && <p className="ui-field__error" role="alert">{commandError}</p>}
      </InlineForm>
    </div>
  );
}

function ManualEditor({ manual, focusTitle, host, onClose }: { manual: ManualRow; focusTitle: boolean; host: WidgetHost; onClose: () => void }) {
  const t = useT(), run = useRunCommand(host);
  const { section } = manual;
  const [title, setTitle] = useState(text(t, manual.title));
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusTitle) titleInput.current?.focus(); }, [focusTitle]);
  const [content, setContent] = useState(section === 'store-info' ? text(t, manual.body) : manual.steps.map(step => text(t, step.body)).join('\n'));
  const [cautions, setCautions] = useState(text(t, manual.cautions));
  const [category, setCategory] = useState(manual.category);
  const [error, setError] = useState<string>();
  return <InlineForm title={t.t('widget.manuals.edit')} onClose={onClose} onSave={() => {
    if (!title.trim()) { setError(t.t('widget.manuals.titleRequired')); return; }
    const steps = section === 'store-info' ? (content.trim() ? [content.trim()] : []) : content.split('\n').map(s => s.trim()).filter(Boolean);
    if (!steps.length) { setError(t.t('widget.manuals.contentRequired')); return; }
    const result = run({ type: 'manuals.update', manualId: manual.manualId, patch: { section, title: title.trim(), category, steps, cautions } });
    if (result.ok) onClose(); else setError(t.t(result.messageKey));
  }}><TextField label={t.t('widget.manuals.draftTitle')} value={title} inputRef={titleInput} onValueChange={setTitle} error={error} /><ChipChoice label={t.t('widget.manuals.category')} value={category} onChange={setCategory} options={(section === 'store-info' ? ['store-info'] as const : ['opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene'] as const).map(value => ({ value, label: t.t(`data.manualCategory.${value}`) }))} /><Textarea label={t.t('widget.manuals.content')} value={content} onValueChange={setContent} /><Textarea label={t.t('widget.manuals.cautions')} value={cautions} onValueChange={setCautions} /></InlineForm>;
}

export const manualsModule: WidgetModule = { id: 'manuals', Panel: ManualsPanel, Detail: ManualsDetail, useSummary: useManualsSummary };
