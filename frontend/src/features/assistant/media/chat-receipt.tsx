import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { RunStore } from '../../../contracts';
import type { WidgetDataStore } from '../../../data/widget-data';
import { createTranslator, I18nProvider } from '../../../i18n';
import type { ChatReceiptIdentity, ChatReceiptNoticeRequest } from '../../../state';
import { ActionButton, AnchoredPopover, Card, ChipChoice, DateField, Icon, IconButton, NumberField, TextField } from '../../../ui';
import { groupStyle } from '../../../ui/tones';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { ReceiptReviewField } from '../../widgets/mgmt-money/receipt-ocr';
import { createAgentActions, type AgentActionReceipt } from '../agent-actions';
import {
  receiptExpenseBusinessDate, receiptExpenseCategories, receiptExpenseDraft, receiptExpenseProposal,
  type ReceiptExpenseFields, type ReceiptRecognition,
} from '../domains/money';
import { navisStreamMessages as copy, navisTranslator } from '../messages';
import { ProposalReceipt } from '../proposal-card';
import { postMedia } from './media-request';
import './chat-receipt.css';

export interface ChatReceiptContext {
  readonly run: RunStore;
  readonly store: WidgetDataStore;
}

const korean = navisTranslator('ko');
const ledgerText = createTranslator('ko', mgmtMoneyBundle);
const categoryOptions = receiptExpenseCategories.map(value => ({ value, label: korean.t(`data.expenseCategory.${value}`) }));
const photoTypes = ['image/jpeg', 'image/png'];
const accept = photoTypes.join(',');
const maxPhotoBytes = 5_000_000;
const noSubscription = () => () => {};
const noSnapshot = () => null;
const receiptScope = (run?: RunStore) => {
  if (!run) return null;
  const { runId, layer, edit } = run.getState();
  return `${runId}:${layer}:${edit.mode}`;
};

type Draft = ReturnType<typeof receiptExpenseDraft>;
type Anchor = string | undefined;
type PhotoState =
  | { readonly kind: 'reading' | 'error'; readonly anchor: Anchor; readonly file: File }
  | { readonly kind: 'card'; readonly anchor: Anchor; readonly file?: File; readonly draft: Draft; readonly revision: number;
      readonly failure?: string; readonly uncertain?: boolean; /** A real (HTTP) expense is saved only after the server's receipt: the card waits. */ readonly pending?: true };
type SavedExpense = {
  readonly anchor: Anchor;
  readonly identity: ChatReceiptIdentity;
  readonly receipt: AgentActionReceipt;
  readonly summary: string;
};

// Like the transcript, the successful receipts live for this run across pane remounts.
const savedByRun = new WeakMap<RunStore, { readonly runId: string; readonly entries: readonly SavedExpense[] }>();
const savedExpenses = (run?: RunStore) => {
  const entry = run && savedByRun.get(run);
  return entry && entry.runId === run?.getState().runId ? entry.entries : [];
};

// The hook and its private renderers update together during Fast Refresh.
export function useChatReceiptFlow(context: ChatReceiptContext | undefined, anchor: Anchor, visible: boolean, chatBusy: boolean,
  transcript: RefObject<HTMLDivElement | null>, nearBottom: RefObject<boolean>) {
  const { run, store } = context ?? {};
  const snapshot = useSyncExternalStore(store?.subscribe ?? noSubscription, store?.getSnapshot ?? noSnapshot);
  const scope = useSyncExternalStore(run?.subscribe ?? noSubscription, () => receiptScope(run));
  const [previousScope, setPreviousScope] = useState(scope);
  const [state, setState] = useState<PhotoState>();
  const [saved, setSaved] = useState(() => savedExpenses(run));
  const [newReceipt, setNewReceipt] = useState<string>();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerId = useId();
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const toolbarButton = useRef<HTMLButtonElement>(null);
  const request = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const confirmedDraft = useRef<Draft | null>(null);
  const active = useRef<HTMLDivElement>(null);
  const reading = state?.kind === 'reading';

  if (previousScope !== scope) {
    setPreviousScope(scope);
    setState(undefined);
    setPickerOpen(false);
    setSaved(savedExpenses(run));
  }

  function cancelReading() {
    if (!request.current && !reading) return;
    request.current?.abort();
    request.current = null;
    setState(undefined);
  }

  useLayoutEffect(() => {
    if (visible && (!chatBusy || !request.current)) return;
    request.current?.abort();
    request.current = null;
    // Retire cancelled media before an enclosing surface can reopen it.
    setState(undefined);
    setPickerOpen(false);
  }, [visible, chatBusy]);
  useLayoutEffect(() => () => {
    request.current?.abort();
    request.current = null;
  }, [scope]);
  useLayoutEffect(() => {
    const scroll = transcript.current;
    const row = active.current;
    if (!scroll || !row || !nearBottom.current) return;
    if (row.offsetHeight > scroll.clientHeight) scroll.scrollTo?.({ top: row.offsetTop });
    else row.scrollIntoView?.({ block: 'nearest' });
  }, [state?.kind, saved.length, transcript, nearBottom]);

  function clearPhoto() {
    cancelReading();
    setState(undefined);
    toolbarButton.current?.focus({ preventScroll: true });
  }

  function dismissPicker(restoreFocus: boolean) {
    setPickerOpen(false);
    if (restoreFocus) toolbarButton.current?.focus({ preventScroll: true });
  }

  function pickPhoto(source: 'camera' | 'library') {
    const chooser = (source === 'camera' ? camera : picker).current;
    if (!chooser) return;
    if (typeof chooser.showPicker === 'function') {
      try {
        chooser.showPicker();
        setPickerOpen(false);
        return;
      } catch {
        // The input's click also supports browsers that decline showPicker().
      }
    }
    // Close the popover before the fallback click is treated as an outside press.
    flushSync(() => setPickerOpen(false));
    chooser.click();
  }

  async function scan(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file || !visible || chatBusy || !run || !store || request.current) return;
    const target = { anchor, file };
    if (!photoTypes.includes(file.type) || file.size === 0 || file.size > maxPhotoBytes) {
      setState({ kind: 'error', ...target });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    request.current = controller;
    const isCurrent = () => request.current === controller && !signal.aborted && receiptScope(run) === scope;
    setState({ kind: 'reading', ...target });
    try {
      const recognized = await postMedia<ReceiptRecognition>('receipt-ocr', file, signal);
      if (isCurrent()) setState({ kind: 'card', ...target, draft: receiptExpenseDraft(recognized), revision: store.getSnapshot().revision });
    } catch {
      if (isCurrent()) setState({ kind: 'error', ...target });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  function manual() {
    if (state?.kind === 'error' && snapshot) setState({ kind: 'card', anchor: state.anchor, draft: receiptExpenseDraft(), revision: snapshot.revision });
  }

  function updateField<Key extends keyof ReceiptExpenseFields>(name: Key, value: ReceiptExpenseFields[Key]) {
    setState(current => current?.kind === 'card' ? {
      ...current, failure: undefined,
      draft: { fields: { ...current.draft.fields, [name]: value }, review: { ...current.draft.review, [name]: false } },
    } : current);
  }

  const businessDate = snapshot && receiptExpenseBusinessDate(snapshot);
  const validation = state?.kind === 'card' && businessDate ? receiptExpenseProposal(state.draft.fields, businessDate, !!state.file) : undefined;

  function confirm() {
    if (!visible || !run || !store || state?.kind !== 'card' || !validation || 'invalid' in validation ||
        saving.current || state.uncertain || confirmedDraft.current === state.draft) return;
    const scope = run.getState();
    const current = store.getSnapshot();
    const canCommit = () => {
      const next = run.getState();
      return next.runId === scope.runId && next.runId === current.runId &&
        next.layer === scope.layer && next.layer !== 'orders-payment' && next.edit.mode === 'view';
    };
    if (!canCommit()) return;
    if (current.revision !== state.revision) {
      setState({ ...state, revision: current.revision, failure: expenseFailure('conflict') });
      return;
    }
    saving.current = true;
    let deferred = false;
    try {
      const prepared = createAgentActions(store, undefined, run).prepare({
        command: 'ledger.recordExpense', args: validation.args,
        snapshotRevision: current.revision, proposalId: crypto.randomUUID(), runId: scope.runId,
        layer: scope.activeBoard, page: scope.boards[scope.activeBoard].currentPage + 1, tier: 'normal',
      }, validation.slots, current, canCommit);
      if (prepared.kind !== 'proposal') {
        setState({ ...state, failure: expenseFailure(prepared.kind, 'messageKey' in prepared ? prepared.messageKey : undefined) });
        return;
      }
      // The card, not the typed or spoken text, is what commits; `validation` and `state` are the ones the owner pressed.
      const finish = (receipt: AgentActionReceipt) => {
        if (receipt.frame.outcome !== 'applied') {
          setState({ ...state, uncertain: receipt.uncertain,
            failure: receipt.uncertain ? copy.executionUnknown : expenseFailure(receipt.frame.outcome, receipt.frame.messageKey) });
          return;
        }
        confirmedDraft.current = state.draft;
        const identity = { proposalId: receipt.frame.proposalId };
        const { category, merchant, memo } = state.draft.fields;
        const confirmed = [korean.format.date(validation.slots.date, 'long'), korean.t(`data.expenseCategory.${category}`),
          korean.format.money(validation.slots.amount, 'full'), merchant.trim(), memo.trim()].filter(Boolean).join(' · ');
        const next = [...savedExpenses(run), { anchor: state.anchor, receipt, identity, summary: `${copy.expenseSaved} · ${confirmed}` }];
        savedByRun.set(run, { runId: scope.runId, entries: next });
        if (receipt.notice) {
          const notice: ChatReceiptNoticeRequest = { ...receipt.notice, chatReceipt: identity };
          run.actions.showNotice(notice);
        }
        setSaved(next);
        setNewReceipt(identity.proposalId);
        setState(undefined);
      };
      const receipt = prepared.proposal.confirm(store);
      if (receipt.pending) {
        // Money over HTTP: nothing is shown as saved before the service answers; a second press while waiting is ignored.
        deferred = true;
        setState({ ...state, pending: true, failure: undefined });
        void prepared.proposal.settled().then(finish, () => setState({ ...state, uncertain: true, failure: copy.executionUnknown })).finally(() => { saving.current = false; });
        return;
      }
      finish(receipt);
    } finally {
      if (!deferred) saving.current = false;
    }
  }

  const toolbar = context && <>
    <ActionButton className="ai-photo__camera" ref={toolbarButton} size="icon" variant="secondary" aria-label={copy.receiptPhoto} loading={reading}
      aria-haspopup="dialog" aria-controls={pickerOpen ? pickerId : undefined} aria-expanded={pickerOpen}
      disabled={!visible || chatBusy || reading} onClick={() => setPickerOpen(open => !open)}>
      <svg className="ui-icon ui-icon--default" aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="24" height="24"
        fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7h4l2-3h6l2 3h4v13H3z" /><circle cx="12" cy="13" r="3" />
      </svg>
    </ActionButton>
    <input ref={camera} type="file" accept={accept} capture="environment" hidden onChange={event => void scan(event)} />
    <input ref={picker} type="file" accept={accept} hidden onChange={event => void scan(event)} />
    {pickerOpen && <AnchoredPopover open={visible} id={pickerId} anchorRef={toolbarButton} side="top" label={copy.receiptPhoto}
      allowAnchorInteraction focusOnOpen onClose={reason => dismissPicker(reason === 'Esc')}>
      <div className="ai-photo__choices" onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        dismissPicker(true);
      }}>
        <ActionButton variant="ghost" onClick={() => pickPhoto('camera')}>{copy.receiptTake}</ActionButton>
        <ActionButton variant="ghost" onClick={() => pickPhoto('library')}>{copy.receiptPick}</ActionButton>
      </div>
    </AnchoredPopover>}
  </>;
  const attachment = state?.file ? <PhotoAttachment file={state.file} remove={clearPhoto} /> : null;
  const threadAt = (id: Anchor) => context && <>
    {saved.filter(entry => entry.anchor === id).map(entry => <ExpenseReceipt key={entry.identity.proposalId}
      entry={entry} run={context.run} visible={visible} focus={newReceipt === entry.identity.proposalId} />)}
    {state && state.anchor === id && <div className="ai-conversation__message ai-photo__thread" data-role="assistant" ref={active}>
      {state.kind === 'reading' && <p className="ai-photo__status" role="status">{copy.receiptReading}</p>}
      {state.kind === 'error' && <div className="ai-photo__status" data-error>
        <p role="alert"><Icon name="warning" />{copy.receiptReadFailed}</p>
        <div className="ai-photo__choices">
          <ActionButton variant="secondary" onClick={() => pickPhoto('camera')}>{copy.receiptRetake}</ActionButton>
          <ActionButton variant="secondary" onClick={() => pickPhoto('library')}>{copy.receiptPick}</ActionButton>
          <ActionButton variant="outline" onClick={manual}>{copy.receiptManual}</ActionButton>
        </div>
      </div>}
      {state.kind === 'card' && businessDate && <I18nProvider locale="ko">
        <ExpenseCard draft={state.draft} recognized={!!state.file} businessDate={businessDate}
          failure={state.failure} uncertain={state.uncertain} pending={state.pending} invalid={validation && 'invalid' in validation ? validation.invalid : undefined}
          confirm={confirm} edit={updateField} close={clearPhoto} retake={() => pickPhoto('camera')} />
      </I18nProvider>}
    </div>}
  </>;
  return { toolbar, attachment, threadAt, cancelReading, reading, hasThread: Boolean(state || saved.length) };
}

function expenseFailure(kind: string, messageKey?: string) {
  const fallback = `common.navis.agent.${kind}`;
  return korean.t('navis.executionFailed', {
    reason: messageKey && korean.has(messageKey) ? korean.t(messageKey) : korean.t(korean.has(fallback) ? fallback : 'common.navis.agent.invalid'),
  });
}

// eslint-disable-next-line react-refresh/only-export-components
function PhotoAttachment({ file, remove }: { readonly file: File; readonly remove: () => void }) {
  const [preview, setPreview] = useState<{ readonly file: File; readonly url: string }>();
  useLayoutEffect(() => {
    if (!photoTypes.includes(file.type) || file.size === 0 || file.size > maxPhotoBytes || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="ai-photo__attachment">
    <span className="ai-photo__thumb">{preview?.file === file ? <img src={preview.url} alt="" /> : <Icon name="receipt" />}</span>
    <span className="ai-photo__name" title={file.name}>{file.name}</span>
    <IconButton icon="close" label={copy.receiptRemove} variant="ghost" onClick={remove} />
  </div>;
}

interface ExpenseCardProps {
  readonly draft: Draft;
  readonly recognized: boolean;
  readonly businessDate: string;
  readonly invalid?: keyof ReceiptExpenseFields;
  readonly failure?: string;
  readonly uncertain?: boolean;
  readonly pending?: boolean;
  confirm(): void;
  edit<Key extends keyof ReceiptExpenseFields>(name: Key, value: ReceiptExpenseFields[Key]): void;
  close(): void;
  retake(): void;
}

// eslint-disable-next-line react-refresh/only-export-components
function ExpenseCard({ draft: { fields, review }, recognized, businessDate, invalid, failure, uncertain, pending, confirm, edit, close, retake }: ExpenseCardProps) {
  const title = useId();
  return <Card className="navis-card navis-agent-controls ai-photo__card" style={groupStyle('finance')} data-readonly="proposal"
    role="region" aria-labelledby={title} data-agent-active={!uncertain || undefined}>
    <span className="navis-card__highlight" aria-hidden="true" />
    <strong id={title}>{copy.expenseCard}</strong>
    {recognized && <div className="ai-photo__status" data-recognized>
      <p role="status">{copy.receiptCheck}</p>
      <ActionButton variant="ghost" onClick={retake}>{copy.receiptRetake}</ActionButton>
    </div>}
    <div className="ai-photo__required">
      <ReceiptReviewField locale="ko" review={review.date}>
        {hint => <DateField name="receipt-date" label={copy.expenseDate} value={fields.date} max={businessDate} today={businessDate}
          required onValueChange={value => edit('date', value)} hint={hint}
          error={fields.date && fields.date > businessDate ? copy.expenseDateFuture : undefined} />}
      </ReceiptReviewField>
      <ReceiptReviewField locale="ko" review={review.amount}>
        {hint => <NumberField name="receipt-amount" label={copy.expenseAmount} value={fields.amount} min={1} step={1}
          unit={ledgerText.t('widget.ledger.currency')} onValueChange={value => edit('amount', value)} hint={hint}
          error={invalid === 'amount' && fields.amount !== null ? korean.t('data.error.amountInvalid') : undefined} />}
      </ReceiptReviewField>
    </div>
    <div className="ai-photo__category">
      <span className="ui-field__label">{copy.expenseCategory}</span>
      <ChipChoice label={copy.expenseCategory} options={categoryOptions} value={fields.category} onChange={value => edit('category', value)} />
    </div>
    <ReceiptReviewField locale="ko" review={review.merchant}>
      {hint => <TextField name="receipt-merchant" label={copy.expenseMerchant} value={fields.merchant} onValueChange={value => edit('merchant', value)} hint={hint} />}
    </ReceiptReviewField>
    <ReceiptReviewField locale="ko" review={review.memo}>
      {hint => <TextField name="receipt-memo" label={copy.expenseMemo} value={fields.memo} onValueChange={value => edit('memo', value)} hint={hint}
        error={invalid === 'memo' ? copy.expenseMemoTooLong : undefined} />}
    </ReceiptReviewField>
    {failure && <p role="alert" className="navis-agent-controls__caution"><Icon name="warning" />{failure}</p>}
    <div className="navis-agent-controls__actions" data-navis-pending-action-row={!uncertain || undefined}>
      <ActionButton size="primary" disabled={!!invalid || uncertain || pending} loading={pending} onClick={event => { if (event.detail < 2) confirm(); }}
        onKeyDown={event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); }}>
        {copy.expenseSave}
      </ActionButton>
      <ActionButton variant="outline" onClick={close}>{copy.close}</ActionButton>
    </div>
  </Card>;
}

// eslint-disable-next-line react-refresh/only-export-components
function ExpenseReceipt({ entry, run, visible, focus }: {
  readonly entry: SavedExpense; readonly run: RunStore; readonly visible: boolean; readonly focus: boolean;
}) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (focus && visible) {
      row.current?.focus({ preventScroll: true });
      row.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [focus, visible]);
  return <div className="ai-conversation__message ai-photo__thread" data-role="assistant">
    <ProposalReceipt run={run} visible={visible} identity={entry.identity} receipt={entry.receipt}
      title={copy.expenseCard} summary={entry.summary} rowRef={row} />
  </div>;
}
