import { useId, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import type { NoticeRequest } from '../../contracts';
import { useWidgetDataStore } from '../../data/react';
import { ActionButton } from '../../ui/components/controls';
import { InlineForm, NumberField, SegmentedControl, TextField } from '../../ui/components/forms';
import { groupStyle } from '../../ui/tones';
import type { Translator } from '../../i18n';
import { isMenuPrice, type AgentActionProposal, type AgentActionReceipt, type MenuProposalEdit } from './agent-actions';
import { navisTranslator } from './messages';
import type { ProposalSession } from './navis-conversation';
import type { AgentClarification, AgentContinuation, AgentTurn, AssistantReply } from './types';
import './proposal-card.css';

const key = 'common.navis.agent.';
const money = (t: Translator, value: number) => t.format.money(value, 'full');

export interface AgentReplyControlsProps {
  readonly reply: AssistantReply;
  readonly onContinue: (answer: AgentContinuation) => void;
  readonly onNotice: (notice: NoticeRequest) => void;
  readonly onActionResult?: (frame: AgentActionReceipt['frame']) => void;
}

export function AgentReplyControls({ reply, onContinue, onNotice, onActionResult }: AgentReplyControlsProps) {
  const t = navisTranslator(reply.locale ?? 'ko');
  if (reply.proposalSession) {
    return <ProposalCard key={reply.proposal?.id ?? (reply.turn?.kind === 'proposal' ? reply.turn.proposal.id : undefined)} session={reply.proposalSession} t={t} onNotice={onNotice} onActionResult={onActionResult} />;
  }
  if (reply.clarification) {
    return <ClarificationChips key={reply.clarification.id} clarification={reply.clarification} t={t} onContinue={onContinue} />;
  }
  if ((reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity') && reply.turn.choices.length) {
    return <ClarificationChoices turn={reply.turn} t={t} onContinue={onContinue} />;
  }
  return null;
}

function ClarificationChips({ clarification, t, onContinue }: {
  readonly clarification: AgentClarification;
  readonly t: Translator;
  readonly onContinue: AgentReplyControlsProps['onContinue'];
}) {
  const [manual, setManual] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [sent, setSent] = useState(false);
  const sentRef = useRef(false);
  const manualButton = useRef<HTMLButtonElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const label = useId();
  const question = t.t(`${key}priceQuestion`);
  const disabled = sent || !clarification.isCurrent();
  const submit = (value: number | null) => {
    if (sentRef.current || !clarification.isCurrent()) return;
    if (!isMenuPrice(value)) {
      setInvalid(true);
      priceRef.current?.focus();
      return;
    }
    sentRef.current = true;
    setSent(true);
    setManual(false);
    onContinue({ clarificationId: clarification.id, price: value });
  };
  return <div className="navis-agent-controls" data-agent-active={!disabled || undefined} role="group" aria-labelledby={label}>
    <p id={label}>{question}</p>
    <div className="navis-agent-controls__actions">
      {clarification.choices.map(choice => 'value' in choice
        ? <ActionButton key={choice.id} variant="outline" aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} onClick={() => submit(choice.value)}>{money(t, choice.value)}</ActionButton>
        : <ActionButton key={choice.id} ref={manualButton} variant="outline" aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} aria-expanded={manual && !disabled} onClick={() => { if (!disabled) setManual(true); }}>{t.t(`${key}manualPrice`)}</ActionButton>)}
    </div>
    {manual && !disabled && <InlineForm title={t.t(`${key}manualPrice`)} saveLabel={t.t(`${key}next`)} closeLabel={t.t('common.cancel')} returnFocusRef={manualButton} onClose={() => setManual(false)} onSave={() => submit(price)}>
      <NumberField label={t.t(`${key}price`)} name="navis-price" min={1} step={1} value={price} onValueChange={value => { setPrice(value); setInvalid(false); }} inputRef={priceRef} error={invalid ? t.t(`${key}priceInvalid`) : undefined} />
    </InlineForm>}
  </div>;
}

function ClarificationChoices({ turn, t, onContinue }: {
  readonly turn: Extract<AgentTurn, { kind: 'clarification' | 'ambiguity' }>;
  readonly t: Translator;
  readonly onContinue: AgentReplyControlsProps['onContinue'];
}) {
  const active = turn.isCurrent();
  return <div className="navis-agent-controls" role="group" aria-label={t.t(`${key}choices`)} data-agent-active={active || undefined}>
    <div className="navis-agent-controls__actions">
      {turn.choices.filter(choice => choice.id !== 'manual').map(choice => <ActionButton key={choice.id} variant="outline" disabled={!active}
        onClick={() => { if (turn.isCurrent()) onContinue({ clarificationId: turn.id, choiceId: choice.id }); }}>
        {[choice.label, choice.detail].filter(Boolean).join(' · ')}
      </ActionButton>)}
    </div>
  </div>;
}

function ProposalCard({ session, t, onNotice, onActionResult }: {
  readonly session: ProposalSession;
  readonly t: Translator;
  readonly onNotice: AgentReplyControlsProps['onNotice'];
  readonly onActionResult: AgentReplyControlsProps['onActionResult'];
}) {
  const store = useWidgetDataStore();
  const { proposal, menu, preview, edit, editField, feedback, reproposed, refreshFailed } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const editButton = useRef<HTMLButtonElement>(null);
  const title = useId();
  const [blocked, setBlocked] = useState(false);
  const inactive = !proposal.isCurrent();
  const pending = session.isPending();
  const receipt = feedback ?? proposal.getReceipt();
  const outcome = inactive && pending ? 'cancelled' : receipt?.frame.outcome ?? (inactive ? 'cancelled' : undefined);
  const extra = receipt?.requiresExtraConfirmation;
  const canEdit = !!menu && !inactive && !edit && (pending || outcome === 'invalid');
  const settle = (next: AgentActionReceipt | 'finishEditing' | undefined) => {
    setBlocked(next === 'finishEditing');
    if (!next || typeof next === 'string') return;
    onActionResult?.(next.frame);
    if (next.notice) onNotice(menu && t.locale !== 'ko' ? { ...next.notice, messageKey: `${key}applied` } : next.notice);
  };
  // Only command-specific, validated previews may appear in a confirmation card.
  if (!menu && !preview) return null;
  const status = blocked ? 'finishEditing' : reproposed ? 'conflict' : extra ? 'extraConfirm' : outcome === 'applied' && !menu ? 'changeApplied' : outcome;
  return <section className="ai-candidate navis-agent-controls" style={groupStyle('products')} data-readonly="proposal"
    data-agent-active={pending || undefined} data-agent-editing={!!edit || undefined} data-outcome={outcome} aria-labelledby={title}>
    <strong id={title}>{preview?.title ?? t.t(`${key}menuCreate`)}</strong>
    {!edit && (menu ? <MenuPreview key={proposal.id} menu={menu} t={t} invalid={receipt?.field} />
      : <dl className="navis-agent-controls__rows">
        {preview?.fields.map(({ label, before, after }, index) => <div key={index}>
          <dt>{label}</dt><dd>{before === after ? after : t.t(`${key}countChange`, { before, after })}</dd>
        </div>)}
      </dl>)}
    <div className="navis-agent-controls__actions">
      <ActionButton aria-disabled={!pending || !!edit || undefined} tabIndex={!pending || edit ? -1 : undefined}
        onKeyDown={event => { if (event.repeat && event.key === 'Enter') event.preventDefault(); }}
        onClick={event => { if (event.detail < 2) settle(session.confirm(store, proposal.id, extra)); }}>{t.t(`${key}${extra ? 'confirmAgain' : menu ? 'confirm' : 'confirmChange'}`)}</ActionButton>
      {menu && <ActionButton ref={editButton} variant="secondary" aria-disabled={!canEdit || undefined} tabIndex={canEdit ? undefined : -1} onClick={() => { if (canEdit) session.edit(); }}>{t.t(`${key}edit`)}</ActionButton>}
      <ActionButton variant="outline" aria-disabled={!pending || undefined} tabIndex={!pending ? -1 : undefined} onClick={() => settle(session.cancel())}>{t.t(`${key}cancelProposal`)}</ActionButton>
    </div>
    {edit && !inactive && <MenuEditor edit={edit} priceOnly={editField === 'price'} t={t} returnFocusRef={editButton} onPreview={session.preview} onCancel={() => session.cancel()} />}
    {!edit && status && <div role="status">{t.t(`${key}${status}`)}</div>}
    {refreshFailed && <p role="status">{t.t(`${key}manualRoute`)}</p>}
  </section>;
}

function MenuPreview({ menu, t, invalid }: { readonly menu: AgentActionProposal; readonly t: Translator; readonly invalid?: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const after = menu.preview.after;
  const none = t.t(`${key}none`);
  const rows = [
    ['name', after.name],
    ['category', t.t(`${key}${after.category}`)],
    ['price', money(t, after.price)],
    ['memo', after.memo ?? none],
    ['saleStatus', t.t(`${key}${after.saleStatus}`)],
    ['prep', t.t(`${key}minutes`, { n: t.format.number(after.prepMin) })],
    ['sold', t.format.number(after.soldQty)],
    ['cost', after.cost === null ? none : money(t, after.cost)],
    ['recipe', after.recipeCount ? t.format.number(after.recipeCount) : none],
    ['options', after.optionCount ? t.format.number(after.optionCount) : none],
    ['photo', t.t(`${key}${after.hasPhoto ? 'present' : 'none'}`)],
  ] as const;
  const row = ([field, value]: typeof rows[number]) => <div key={field} data-invalid={invalid === field || undefined}>
    <dt>{t.t(`${key}${field}`)}</dt><dd>{value}</dd>
  </div>;
  return <>
    <dl className="navis-agent-controls__rows">
      {row(rows[0])}
      {row(rows[2])}
      <div><dt>{t.t(`${key}count`)}</dt><dd>{t.t(`${key}countChange`, { before: t.format.number(menu.preview.countBefore), after: t.format.number(menu.preview.countAfter) })}</dd></div>
    </dl>
    <ActionButton variant="ghost" className="navis-agent-controls__toggle" aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(value => !value)}>{t.t(`${key}${expanded ? 'hideDetails' : 'showDetails'}`)}</ActionButton>
    <div id={detailsId} hidden={!expanded} className="navis-agent-controls__details" tabIndex={expanded ? 0 : undefined} role="group"
      aria-label={t.t(`${key}changeDetails`)}>
      <p>{t.t(`${key}before`)} <span>{none}</span></p>
      <strong>{t.t(`${key}after`)}</strong>
      <dl className="navis-agent-controls__rows">{rows.filter(([field]) => field !== 'name' && field !== 'price').map(row)}</dl>
    </div>
  </>;
}

function MenuEditor({ edit, priceOnly, t, returnFocusRef, onPreview, onCancel }: {
  readonly edit: MenuProposalEdit;
  readonly priceOnly: boolean;
  readonly t: Translator;
  readonly returnFocusRef: RefObject<HTMLButtonElement | null>;
  readonly onPreview: (draft: MenuProposalEdit['draft']) => boolean;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState(edit.draft.name);
  const [category, setCategory] = useState(edit.draft.category);
  const [price, setPrice] = useState<number | null>(edit.draft.price);
  const [memo, setMemo] = useState(edit.draft.memo ?? '');
  const [attempted, setAttempted] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const memoRef = useRef<HTMLInputElement>(null);
  return <InlineForm title={t.t(`${key}${priceOnly ? 'editPrice' : 'edit'}`)} saveLabel={t.t(`${key}refresh`)} closeLabel={t.t('common.cancel')} returnFocusRef={returnFocusRef} onClose={onCancel} onSave={() => {
    setAttempted(true);
    if (!name.trim() || name.length > 120) { nameRef.current?.focus(); return; }
    if (!isMenuPrice(price)) { priceRef.current?.focus(); return; }
    if (memo.length > 1000) { memoRef.current?.focus(); return; }
    if (!onPreview({ name, category, price, memo })) setUnavailable(true);
  }}>
    {!priceOnly && <TextField name="navis-menu-name" label={t.t(`${key}name`)} value={name} onValueChange={setName} inputRef={nameRef} error={attempted && (!name.trim() || name.length > 120) ? t.t(`${key}nameInvalid`) : undefined} />}
    {!priceOnly && <SegmentedControl label={t.t(`${key}category`)} value={category} onChange={setCategory} options={[
      { value: 'drink', label: t.t(`${key}drink`) }, { value: 'dessert', label: t.t(`${key}dessert`) },
    ]} />}
    <NumberField label={t.t(`${key}price`)} name="navis-menu-price" min={1} step={1} value={price} onValueChange={setPrice} inputRef={priceRef} error={attempted && !isMenuPrice(price) ? t.t(`${key}priceInvalid`) : undefined} />
    {!priceOnly && <TextField name="navis-menu-memo" label={t.t(`${key}memo`)} value={memo} onValueChange={setMemo} inputRef={memoRef} error={attempted && memo.length > 1000 ? t.t(`${key}memoInvalid`) : undefined} />}
    {unavailable && <p role="alert">{t.t(`${key}manualRoute`)}</p>}
  </InlineForm>;
}
