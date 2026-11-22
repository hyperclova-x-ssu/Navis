import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { agentCommandPolicy } from '../../../shared/navis-agent-schema.mjs';
import { getRegistration } from '../../catalog';
import type { DetailRef, NoticeRequest, RunStore } from '../../contracts';
import { useWidgetDataStore } from '../../data/react';
import type { WidgetDataStore } from '../../data/widget-data';
import { selectCommonNotice, setChatReceiptVisible, type ChatReceiptIdentity, type ChatReceiptNoticeRequest } from '../../state';
import { Card } from '../../ui/components/card';
import { ActionButton } from '../../ui/components/controls';
import { Icon } from '../../ui/icons';
import { InlineForm, NumberField, SegmentedControl, TextField } from '../../ui/components/forms';
import { groupStyle } from '../../ui/tones';
import { mktLocalBundle } from '../widgets/mkt-local/messages';
import { readReplyTestTargetCount } from '../widgets/naver-drafts';
import type { Translator } from '../../i18n';
import { agentReceiptStatus, agentReceiptUndoFailed, agentReceiptUndoVersion, applyAgentReceiptUndo, isMenuPrice, subscribeAgentReceiptUndo, type AgentActionProposal, type AgentActionReceipt, type MenuProposalEdit } from './agent-actions';
import { navisStreamMessages as chatCopy, navisTranslator } from './messages';
import { NIGHT_NOTICE_TIME_LABEL } from './domains/notices';
import { destinationOpenLabel, outboundHistoryDestination } from './destinations';
import type { AgentProposalPreview, ProposalSession } from './navis-conversation';
import type { AgentClarification, AgentContinuation, AgentTurn, AssistantReply } from './types';
import { motionTokens, timePolicy } from '../../ui/motion';
import './proposal-card.css';

const key = 'common.navis.agent.';
const money = (t: Translator, value: number) => t.format.money(value, 'full');
const korean = navisTranslator('ko');
const noSubscription = () => () => {};
const absent = () => null;
const ignoreKeyRepeat = (event: KeyboardEvent) => {
  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault();
};
const keepConfirmationFocus = (event: MouseEvent) => {
  if (event.detail > 1) event.preventDefault();
};

export interface AgentReplyControlsProps {
  readonly reply: AssistantReply;
  readonly onContinue: (answer: AgentContinuation) => void;
  readonly onNotice: (notice: NoticeRequest) => void;
  readonly onActionResult?: (frame: AgentActionReceipt['frame']) => void;
  readonly run?: RunStore;
  readonly receiptVisible?: boolean;
  readonly onRepropose?: () => void;
  readonly onOpenDetail?: (destination: DetailRef, opener: HTMLButtonElement) => void;
}

export function AgentReplyControls({ reply, onContinue, ...props }: AgentReplyControlsProps) {
  if (reply.proposalSession) {
    return <ProposalCard key={reply.proposal?.id ?? (reply.turn?.kind === 'proposal' ? reply.turn.proposal.id : undefined)}
      session={reply.proposalSession} previewTranslator={navisTranslator(reply.locale ?? 'ko')} {...props} />;
  }
  if (reply.clarification) {
    return <ClarificationChips key={reply.clarification.id} clarification={reply.clarification} t={korean} onContinue={onContinue} />;
  }
  if ((reply.turn?.kind === 'clarification' || reply.turn?.kind === 'ambiguity') && reply.turn.choices.length) {
    return <ClarificationChoices turn={reply.turn} t={korean} onContinue={onContinue} />;
  }
  return null;
}

export function TestSmsHandoffCard({ openLabel, onOpen }: { readonly openLabel: string; readonly onOpen: (opener: HTMLButtonElement) => void }) {
  const title = useId();
  const [count, setCount] = useState<number>();
  useEffect(() => {
    const controller = new AbortController();
    void readReplyTestTargetCount(controller.signal).then(count => {
      if (!controller.signal.aborted) setCount(count);
    });
    return () => controller.abort();
  }, []);
  const copy = mktLocalBundle.ko;
  return <Card className="navis-card navis-agent-controls" style={groupStyle('customers')} role="region" aria-labelledby={title}>
    <strong id={title}>{copy['widget.ai-response.sendTest']}</strong>
    {count !== undefined && <p role="status">{count === 0 ? copy['widget.ai-response.testOff'] : `시험 번호 ${count}곳`}</p>}
    <div className="navis-agent-controls__actions">
      <ActionButton variant="outline" onClick={event => onOpen(event.currentTarget)}>{openLabel}</ActionButton>
    </div>
  </Card>;
}

/**
 * C-14 / M-16: which choice the owner pressed, keyed by the question object. The conversation keeps its messages when the chat closes,
 * so a reopened chat still shows the same pick instead of a group that looks like it was never answered.
 */
const picks = new WeakMap<object, string>();
/** The one line an old question keeps when a newer question or a changed value made it inert and nothing was picked. */
const staleQuestionReason = '지난 질문이라 더 고를 수 없어요';
const QuestionReason = () => <p className="navis-agent-controls__reason"><Icon name="info" />{staleQuestionReason}</p>;

function ClarificationChips({ clarification, t, onContinue }: {
  readonly clarification: AgentClarification;
  readonly t: Translator;
  readonly onContinue: AgentReplyControlsProps['onContinue'];
}) {
  const [manual, setManual] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [picked, setPicked] = useState(() => picks.get(clarification));
  const sentRef = useRef(picked !== undefined);
  const manualButton = useRef<HTMLButtonElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);
  const label = useId();
  const question = t.t(`${key}priceQuestion`);
  const disabled = picked !== undefined || !clarification.isCurrent();
  const submit = (value: number | null, choice: string) => {
    if (sentRef.current || !clarification.isCurrent()) return;
    if (!isMenuPrice(value)) {
      setInvalid(true);
      priceRef.current?.focus();
      return;
    }
    sentRef.current = true;
    picks.set(clarification, choice);
    setPicked(choice);
    setManual(false);
    onContinue({ clarificationId: clarification.id, price: value });
  };
  return <div className="navis-agent-controls" data-agent-active={!disabled || undefined} role="group" aria-labelledby={label}>
    <p id={label}>{question}</p>
    <div className="navis-agent-controls__actions">
      {clarification.choices.map(choice => 'value' in choice
        ? <ActionButton key={choice.id} variant="outline" aria-pressed={picked === choice.id} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} onClick={() => submit(choice.value, choice.id)}>{money(t, choice.value)}</ActionButton>
        : <ActionButton key={choice.id} ref={manualButton} variant="outline" aria-pressed={picked === choice.id} aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : undefined} aria-expanded={manual && !disabled} onClick={() => { if (!disabled) setManual(true); }}>{chatCopy.receiptManual}</ActionButton>)}
    </div>
    {picked === undefined && disabled && <QuestionReason />}
    {manual && !disabled && <InlineForm title={chatCopy.receiptManual} saveLabel={t.t(`${key}next`)} closeLabel={t.t('common.cancel')} returnFocusRef={manualButton} onClose={() => setManual(false)} onSave={() => submit(price, 'manual')}>
      <div onInvalid={event => { event.preventDefault(); setInvalid(true); priceRef.current?.focus(); }}>
        <NumberField label={t.t(`${key}price`)} name="navis-price" min={1} step={1} value={price} onValueChange={value => { setPrice(value); setInvalid(false); }} inputRef={priceRef} error={invalid ? t.t(`${key}priceInvalid`) : undefined} />
      </div>
    </InlineForm>}
  </div>;
}

function ClarificationChoices({ turn, t, onContinue }: {
  readonly turn: Extract<AgentTurn, { kind: 'clarification' | 'ambiguity' }>;
  readonly t: Translator;
  readonly onContinue: AgentReplyControlsProps['onContinue'];
}) {
  const [picked, setPicked] = useState(() => picks.get(turn));
  const active = picked === undefined && turn.isCurrent();
  return <div className="navis-agent-controls" role="group" aria-label={t.t(`${key}choices`)} data-agent-active={active || undefined}>
    <div className="navis-agent-controls__actions">
      {turn.choices.filter(choice => choice.id !== 'manual').map(choice => <ActionButton key={choice.id} variant="outline"
        aria-pressed={picked === choice.id} aria-disabled={!active || undefined} tabIndex={active ? undefined : -1}
        onClick={() => {
          if (picked !== undefined || !turn.isCurrent()) return;
          picks.set(turn, choice.id);
          setPicked(choice.id);
          onContinue({ clarificationId: turn.id, choiceId: choice.id });
        }}>
        {[choice.label, choice.detail].filter(Boolean).join(' · ')}
      </ActionButton>)}
    </div>
    {picked === undefined && !active && <QuestionReason />}
  </div>;
}

const outboundLabels: Readonly<Record<string, string>> = {
  'notice.send': '공지 보내기',
  'coupon.sendSlot': '쿠폰 보내기',
  'coupon.sendReachOut': '쿠폰 보내기',
  'coupon.notifyEnding': '종료 알림 보내기',
  'inquiry.send': '답글 보내기',
  'inquiry.post': '답글 게시하기',
  'community.accept': '제안 수락하기',
  'community.decline': '제안 거절하기',
  'community.sendInterest': '관심 보내기',
};
const sendTimeLabels = new Set(['발송 시각', 'Send time', '发送时间', '傳送時間']);
const draftRevisionLabels = new Set(['초안 버전', 'Draft revision', '草稿版本']);
const destructiveCopy = {
  삭제: { question: '항목을 지울까요?', action: '지우기', receipt: '지웠어요' },
  보관: { question: '항목을 보관할까요?', action: '보관하기', receipt: '보관했어요' },
  취소: { question: '작업을 취소할까요?', action: '취소하기', receipt: '취소했어요' },
  종료: { question: '사용을 끝낼까요?', action: '끝내기', receipt: '끝냈어요' },
} as const;

function destructiveVerb(command: string): keyof typeof destructiveCopy | undefined {
  if (command === 'members.delete') return '보관';
  if (/\.(?:delete|remove_)/u.test(command)) return '삭제';
  if (/\.(?:cancel|unpublish)/u.test(command) || command === 'manuals.setPublished') return '취소';
  if (command === 'coupon.endEarly') return '종료';
}

function reviewAction(command: string) {
  switch (command) {
    case 'layout.add_widget': case 'layout.add_widgets': return '패널 놓기';
    case 'settings.set_text_scale': return '글자 크기 바꾸기';
    case 'menu.update': return '메뉴 바꾸기';
    case 'menu.setSaleStatus': return '판매 상태 바꾸기';
    case 'video.make': return '영상 만들기';
    case 'video.retry': return '영상 다시 만들기';
    case 'video.markPosted': case 'coupon.markPosted': return '올렸어요 표시하기';
    default: return outboundLabels[command] ?? korean.t(`${key}confirmChange`);
  }
}

function ProposalCard({ session, previewTranslator, onNotice, onActionResult, run, receiptVisible = true, onRepropose, onOpenDetail }:
  Omit<AgentReplyControlsProps, 'reply' | 'onContinue'> & { readonly session: ProposalSession; readonly previewTranslator: Translator }) {
  const store = useWidgetDataStore();
  const { proposal, menu, preview, edit, editField, feedback, reproposed, refreshFailed, closed, replaced, receiptIdentity } =
    useSyncExternalStore(session.subscribe, session.getSnapshot);
  const t = korean;
  const editButton = useRef<HTMLButtonElement>(null);
  const approve = useRef<HTMLButtonElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  const receiptRow = useRef<HTMLDivElement>(null);
  const focusNext = useRef<'review' | 'safe' | 'receipt' | 'receipt-if-lost' | undefined>(undefined);
  const [, rerender] = useState(0);
  const title = useId();
  const [blocked, setBlocked] = useState(false);
  const inactive = !proposal.isCurrent();
  const pending = session.isPending();
  const receipt = feedback ?? proposal.getReceipt();
  // F17: the press went to the real data port and its receipt is on the way. The frame is a placeholder and is never shown or reported.
  const waiting = Boolean(receipt?.pending);
  const outcome = waiting ? 'pending' as const : edit && !inactive ? undefined : receipt?.frame.outcome ?? (inactive ? 'cancelled' : undefined);
  const extra = receipt?.requiresExtraConfirmation;
  const canEdit = !!menu && !inactive && !edit && (pending || outcome === 'invalid');
  const command = proposal.command;
  const feature = agentCommandPolicy(command)?.featureId;
  const group = (feature && getRegistration(feature)?.groupId) || 'products';
  const destructive = proposal.tier === 'extra-confirm' ? destructiveVerb(command) : undefined;
  const destructiveText = destructive && destructiveCopy[destructive];
  const when = command === 'notice.send' ? preview?.fields.find(field => sendTimeLabels.has(field.label))?.after : undefined;
  const nextMorning = when === NIGHT_NOTICE_TIME_LABEL;
  // M-15 (DS §10.2): cards that send something out of the store carry the "밖으로 나가요" strip with the kind of message.
  const outboundKind = command === 'notice.send' ? '공지' : command === 'coupon.sendSlot' || command === 'coupon.sendReachOut' || command === 'coupon.notifyEnding'
    || command === 'coupon.createExpiry' && preview?.reason ? '문자' : undefined;
  const action = destructive ? `${destructive} 내용 확인하기`
    : preview?.confirmLabel ?? (when ? nextMorning ? `${NIGHT_NOTICE_TIME_LABEL}에 보내기` : '발송 예약하기'
    : menu ? t.t(`${key}confirm`) : reviewAction(command));

  useLayoutEffect(() => {
    // A late (real) receipt only takes focus when the owner has not moved on: focus is still lost to the page after the pressed button went away.
    const lost = !document.activeElement || document.activeElement === document.body;
    const target = focusNext.current === 'review' ? approve.current : focusNext.current === 'safe' ? safe.current
      : focusNext.current === 'receipt' || focusNext.current === 'receipt-if-lost' && lost ? receiptRow.current : undefined;
    if (focusNext.current === 'receipt-if-lost' && !target && !lost) focusNext.current = undefined;
    if (target) {
      focusNext.current = undefined;
      target.focus({ preventScroll: true });
    }
  });

  const settle = (next: AgentActionReceipt | 'finishEditing' | undefined, layoutUndo?: ChatReceiptNoticeRequest['layoutUndo'], late = false) => {
    setBlocked(next === 'finishEditing');
    if (!next || typeof next === 'string') return;
    // The press is on its way to the server; its authoritative receipt calls this again (`late`).
    if (next.pending) return;
    if (next.requiresExtraConfirmation) {
      focusNext.current = 'safe';
      return;
    }
    const nextIdentity = session.getSnapshot().receiptIdentity;
    if (next.frame.outcome === 'applied' || next.uncertain) focusNext.current = late ? 'receipt-if-lost' : 'receipt';
    if (late) rerender(count => count + 1);
    if (next.frame.outcome === 'conflict' && session.getSnapshot().reproposed) focusNext.current = 'review';
    onActionResult?.(next.frame);
    if (next.notice && next.frame.outcome === 'applied') {
      const notice: NoticeRequest | ChatReceiptNoticeRequest = run && nextIdentity && next.notice.undo
        ? { ...next.notice, chatReceipt: nextIdentity, ...(layoutUndo && { layoutUndo }) } : next.notice;
      onNotice(notice);
    }
  };
  const confirm = (acknowledgeExtra = false) => {
    const before = command.startsWith('layout.') ? run?.getState().boards : undefined;
    let backing: ChatReceiptNoticeRequest['layoutUndo'];
    const next = session.confirm(store, proposal.id, acknowledgeExtra, final => settle(final, backing, true));
    const after = before && run?.getState().boards;
    if (!before || !after) return settle(next);
    for (const layer of ['management', 'marketing'] as const) {
      const token = after[layer].undo?.token;
      if (token && token !== before[layer].undo?.token) {
        backing = { layer, token };
        return settle(next, backing);
      }
    }
    settle(next);
  };
  const back = () => {
    if (session.back()) {
      focusNext.current = 'review';
      setBlocked(false);
    }
  };
  if (closed) return <div className="navis-agent-controls navis-receipt" data-outcome="closed">
    <Icon name="info" /><span>창을 닫아서 취소했어요</span>
    {onRepropose && <ActionButton variant="secondary" onKeyDown={ignoreKeyRepeat} onClick={event => {
      if (event.detail < 2) onRepropose();
    }}>다시 제안 받기</ActionButton>}
  </div>;
  if (outcome === 'applied' && receipt && receiptIdentity) return <ProposalReceipt run={run} visible={receiptVisible}
    identity={receiptIdentity} receipt={receipt} rowRef={receiptRow} title={preview?.target ?? menu?.preview.after.name}
    summary={receipt.scheduledNotice ? nextMorning ? `${NIGHT_NOTICE_TIME_LABEL}에 보내도록 예약했어요` : '예약했어요'
      : menu ? t.t(`${key}applied`) : outboundLabels[command]?.endsWith('보내기') ? '보냈어요'
        : destructiveText ? destructiveText.receipt : t.t(`${key}changeApplied`)} />;
  const recheck = () => { session.recheck(store, proposal.id, final => settle(final, undefined, true)); };
  if (receipt?.uncertain) {
    const history = outboundHistoryDestination(command, Boolean(when));
    const openLabel = history && destinationOpenLabel(history, previewTranslator);
    const outbound = agentCommandPolicy(command)?.risk === 'external';
    const status = when ? chatCopy.scheduleUnknown : outbound ? chatCopy.sendUnknown : chatCopy.executionUnknown;
    return <div className="navis-agent-controls navis-receipt" tabIndex={-1} ref={receiptRow} data-outcome="uncertain">
      <span className="navis-agent-controls__caution"><Icon name="warning" />{status}</span>
      {receipt.recheckable && <ActionButton variant="outline" onKeyDown={ignoreKeyRepeat} onClick={event => { if (event.detail < 2) recheck(); }}>{chatCopy.recheck}</ActionButton>}
      {history && openLabel && onOpenDetail && <ActionButton variant="outline" onClick={event => onOpenDetail(history, event.currentTarget)}>{openLabel}</ActionButton>}
    </div>;
  }
  // C-13: a card that a new question closed was not cancelled by the owner; it says so and offers the proposal again.
  if (replaced && outcome === 'cancelled') return <div className="navis-agent-controls navis-receipt" data-outcome="replaced">
    <Icon name="info" /><span>새 질문을 받아 이 제안은 닫았어요</span>
    {onRepropose && <ActionButton variant="secondary" onKeyDown={ignoreKeyRepeat} onClick={event => {
      if (event.detail < 2) onRepropose();
    }}>다시 제안 받기</ActionButton>}
  </div>;
  if (outcome === 'cancelled' || outcome === 'unchanged') return <div className="navis-agent-controls navis-receipt" data-outcome={outcome}>
    <Icon name="ban" /><span>{t.t(`${key}${outcome}`)}</span>
  </div>;
  if (!menu && !preview) return null;
  const target = preview?.target ?? menu!.preview.after.name;
  const cardTitle = command === 'menu.create' ? `${target} 메뉴 추가`
    : command === 'menu.delete' ? `${target} 메뉴 지우기` : preview?.title ?? t.t(`${key}menuCreate`);
  const status = blocked ? 'finishEditing' : reproposed ? 'conflict' : extra || waiting ? undefined : outcome;
  const failed = !waiting && !reproposed && !extra && receipt && (outcome === 'busy' || outcome === 'invalid' || outcome === 'conflict');
  const reasonKey = receipt?.frame.messageKey;
  const reason = failed ? reasonKey && t.has(reasonKey) ? t.t(reasonKey, receipt.notice?.params) : t.t(`${key}${outcome}`) : undefined;
  const retry = reason && !receipt?.retryable && !canEdit && onRepropose;
  const pendingRow = pending && !edit || undefined;
  return <Card className="navis-card navis-agent-controls" style={groupStyle(group)} data-readonly="proposal" role="region"
    data-agent-active={pending || undefined} data-agent-editing={!!edit || undefined} data-outcome={outcome} aria-busy={waiting || undefined}
    aria-labelledby={title} onKeyDown={event => {
      if (event.key === 'Escape' && !event.repeat && !event.defaultPrevented && (extra || edit)) {
        event.preventDefault();
        event.stopPropagation();
        back();
      }
    }}>
    <span className="navis-card__highlight" aria-hidden="true" />
    <strong id={title}>{when && nextMorning ? action : cardTitle}</strong>
    {extra ? <div key="extra" className="navis-agent-controls__swap" onMouseDownCapture={keepConfirmationFocus}>
      <strong className="ui-status-badge"><Icon name="warning" />한 번 더 확인</strong>
      <p>{`‘${target}’ ${command === 'menu.delete' ? '메뉴를 지울까요?' : destructiveText ? destructiveText.question : '변경을 적용할까요?'}`}</p>
      {preview?.fields.filter(field => field.label === '안내').map(field => <p key={field.label}>{field.after}</p>)}
      <div className="navis-agent-controls__actions" data-navis-pending-action-row={pendingRow}>
        <ActionButton ref={safe} variant="outline" onKeyDown={ignoreKeyRepeat} onClick={event => {
          if (event.detail < 2) settle(session.cancel());
        }}>
          {t.t(`${key}cancelProposal`)}
        </ActionButton>
        <ActionButton variant={destructive ? 'destructive' : 'default'} onKeyDown={ignoreKeyRepeat}
          onClick={event => { if (event.detail < 2) confirm(true); }}>
          {destructiveText ? `${target} ${destructiveText.action}` : t.t(`${key}confirmAgain`)}
        </ActionButton>
      </div>
    </div> : <div key="review" className="navis-agent-controls__review" data-refresh={reproposed || undefined}>
      {!edit && <>
        {outboundKind && <p className="navis-card__strip"><Icon name="send" /><span>{`밖으로 나가요 · ${outboundKind}`}</span></p>}
        {preview?.reason ? <p>{preview.reason}</p> : nextMorning && <p>{`지금은 보낼 수 없어서 ${NIGHT_NOTICE_TIME_LABEL}에 보내도록 예약할 수 있어요`}</p>}
        {menu ? <MenuPreview key={proposal.id} menu={menu} t={t} invalid={receipt?.field} />
          : <ProposalRows preview={preview!} notice={command === 'notice.send'}
            immediate={command === 'notice.send' && !when || command === 'coupon.notifyEnding'} />}
      </>}
      <div className="navis-agent-controls__actions" data-navis-pending-action-row={pendingRow}>
        <ActionButton ref={approve} variant={destructive ? 'secondary' : 'default'} aria-disabled={!pending || !!edit || undefined} tabIndex={!pending || edit ? -1 : undefined}
          onKeyDown={ignoreKeyRepeat} onClick={event => { if (pending && !edit && event.detail < 2) confirm(); }}>
          {destructive && <Icon name="trash" />}{action}
        </ActionButton>
        {menu && <ActionButton ref={editButton} variant="secondary" aria-disabled={!canEdit || undefined} tabIndex={canEdit ? undefined : -1}
          onClick={() => { if (canEdit) session.edit(); }}>{t.t(`${key}edit`)}</ActionButton>}
        {pending && <ActionButton variant="outline" onKeyDown={ignoreKeyRepeat} onClick={() => settle(session.cancel())}>{t.t(`${key}cancelProposal`)}</ActionButton>}
      </div>
      {edit && !inactive && <MenuEditor edit={edit} priceOnly={editField === 'price'} t={t} returnFocusRef={editButton} onPreview={session.preview} onCancel={back} />}
    </div>}
    {waiting && <p className="navis-agent-controls__pending" role="status"><Icon name="clock" />{outboundKind ? chatCopy.sending : chatCopy.executing}</p>}
    {!edit && reason && <p className="navis-agent-controls__caution" role="status"><Icon name="warning" />{t.t('navis.executionFailed', { reason })}</p>}
    {retry && <ActionButton variant="outline" onKeyDown={ignoreKeyRepeat} onClick={event => {
      if (event.detail < 2) retry();
    }}>다시 제안 받기</ActionButton>}
    {!edit && status && !reason && <p>{t.t(`${key}${status}`)}</p>}
    {refreshFailed && !reason && <p>{t.t(`${key}manualRoute`)}</p>}
  </Card>;
}

/** M-10: a changed value reads "전 {before} → 후 {after}" — the words, not only the arrow — with the earlier value muted and the new one heavier. */
function ChangeValue({ before, after }: { readonly before: string; readonly after: string }) {
  return <span className="navis-change">
    <span className="navis-change__was"><b className="navis-change__tag">전</b> {before}</span>
    <span className="navis-change__arrow"> → </span>
    <span className="navis-change__now"><b className="navis-change__tag">후</b> {after}</span>
  </span>;
}

function ProposalRows({ preview, notice, immediate }: {
  readonly preview: AgentProposalPreview; readonly notice: boolean; readonly immediate: boolean;
}) {
  const fields = notice ? preview.fields.filter(field => !draftRevisionLabels.has(field.label)) : preview.fields;
  return <dl className="navis-agent-controls__rows">
    {immediate && <div><dt>발송 시각</dt><dd>지금</dd></div>}
    {fields.map(({ label, before, after }, index) => <div key={index} data-quote={notice && label === '공지 내용' || undefined}>
      <dt>{label}</dt><dd>{before === after || before === '—' ? after
        : <><span aria-hidden="true"><ChangeValue before={before} after={after} /></span>
          <span className="ui-sr-only">{`이전 값 ${before}, 바뀔 값 ${after}`}</span></>}</dd>
    </div>)}
  </dl>;
}

function ReceiptUndo({ run, store, identity, token, noticeId, focusRow, refresh }: {
  readonly run: RunStore; readonly store: WidgetDataStore; readonly identity: ChatReceiptIdentity;
  readonly token: string; readonly noticeId: string; readonly focusRow: () => void; readonly refresh: () => void;
}) {
  const hovered = useRef(false);
  const focused = useRef(false);
  const sync = () => {
    if (selectCommonNotice(run.getState())?.id !== noticeId) return;
    if (hovered.current || focused.current) run.actions.pauseUndo('toast-focus');
    else run.actions.resumeUndo('toast-focus');
  };
  useLayoutEffect(() => () => {
    if ((hovered.current || focused.current) && selectCommonNotice(run.getState())?.id === noticeId) run.actions.resumeUndo('toast-focus');
  }, [noticeId, run]);
  return <ActionButton variant="secondary" onPointerEnter={() => { hovered.current = true; sync(); }}
    onPointerLeave={() => { hovered.current = false; sync(); }} onFocus={() => { focused.current = true; sync(); }}
    onBlur={() => { focused.current = false; sync(); }} onKeyDown={ignoreKeyRepeat} onClick={event => {
      if (event.detail >= 2) return;
      if (applyAgentReceiptUndo(run, store, identity, token)) focusRow();
      else refresh();
    }}>되돌리기</ActionButton>;
}

export function ProposalReceipt({ run, visible, identity, receipt, summary, title, rowRef }: {
  readonly run?: RunStore; readonly visible: boolean; readonly identity: ChatReceiptIdentity; readonly receipt: AgentActionReceipt;
  readonly summary: string; readonly title?: string; readonly rowRef: RefObject<HTMLDivElement | null>;
}) {
  const store = useWidgetDataStore();
  const state = useSyncExternalStore(run?.subscribe ?? noSubscription, run?.getState ?? absent);
  const notice = state && selectCommonNotice(state);
  const token = notice?.chatReceipt === identity && notice.remainingMs > 0 ? notice.undo?.token : undefined;
  // A real undo is a server round trip: the row re-renders when it starts and when it settles.
  useSyncExternalStore(subscribeAgentReceiptUndo, agentReceiptUndoVersion, agentReceiptUndoVersion);
  const status = agentReceiptStatus(run, receipt, identity);
  const [, setUndoAttempt] = useState(0);
  const undoFailed = status !== 'undone' && agentReceiptUndoFailed(identity);
  useLayoutEffect(() => {
    if (!run || !visible || !token) return;
    setChatReceiptVisible(run, identity, true);
    return () => setChatReceiptVisible(run, identity, false);
  }, [run, visible, token, identity]);

  const scheduled = receipt.scheduledNotice;
  const available = useSyncExternalStore(store.subscribe, () => scheduled?.isCancellable() ?? false);
  const [cancelling, setCancelling] = useState<ReturnType<typeof store.getSnapshot>>();
  const [scheduleStatus, setScheduleStatus] = useState<'cancelled' | 'stale' | undefined>();
  const cancelButton = useRef<HTMLButtonElement>(null);
  const cancelBack = useRef<HTMLButtonElement>(null);
  const summaryId = useId();
  const finalizing = useRef(false);
  const shouldRestoreFocus = useRef(false);
  const goBack = () => {
    shouldRestoreFocus.current = true;
    setCancelling(undefined);
  };
  useLayoutEffect(() => {
    if (cancelling) cancelBack.current?.focus({ preventScroll: true });
    else if (shouldRestoreFocus.current) {
      shouldRestoreFocus.current = false;
      (cancelButton.current ?? rowRef.current)?.focus({ preventScroll: true });
    }
  }, [cancelling, rowRef]);
  if (cancelling && available) return <Card className="navis-card navis-agent-controls navis-agent-controls__swap"
    role="group" aria-label="예약 취소 확인" onMouseDownCapture={keepConfirmationFocus} onKeyDown={event => {
      if (event.key === 'Escape' && !event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        goBack();
      }
    }}>
    <span className="navis-card__highlight" aria-hidden="true" />
    <strong className="ui-status-badge"><Icon name="warning" />한 번 더 확인</strong>
    <p>{`‘${title ?? '공지'}’ 발송 예약을 취소할까요?`}</p>
    <div className="navis-agent-controls__actions" data-navis-pending-action-row>
      <ActionButton ref={cancelBack} variant="outline" onKeyDown={ignoreKeyRepeat} onClick={event => {
        if (event.detail < 2) goBack();
      }}>변경 취소하기</ActionButton>
      <ActionButton variant="destructive" onKeyDown={ignoreKeyRepeat} onClick={event => {
        if (event.detail > 1 || finalizing.current) return;
        finalizing.current = true;
        try {
          const ok = cancelling === store.getSnapshot() && scheduled?.cancel();
          setScheduleStatus(ok ? 'cancelled' : 'stale');
          goBack();
        } finally { finalizing.current = false; }
      }}>예약 취소하기</ActionButton>
    </div>
  </Card>;
  return <div ref={rowRef} tabIndex={-1} role="group" className="navis-agent-controls navis-receipt navis-agent-controls__swap"
    data-outcome="applied" data-receipt-status={status} aria-label={title ? `${title} 작업 결과` : undefined} aria-describedby={summaryId}>
    <Icon name={status === 'undone' || scheduleStatus === 'cancelled' ? 'undo' : status === 'expired' || status === 'undoing' ? 'clock' : 'status-ok'} />
    <span id={summaryId}>{status === 'undone' ? '되돌렸어요' : scheduleStatus === 'cancelled' ? '예약을 취소했어요' : summary}</span>
    {status === 'undoing' && <span className="navis-receipt__detail" role="status">{chatCopy.undoing}</span>}
    {undoFailed && <span className="navis-receipt__detail navis-agent-controls__caution" role="status"><Icon name="warning" />{chatCopy.undoFailed}</span>}
    {status === 'expired' && !undoFailed && <span className="navis-receipt__detail">{korean.t(`${key}undoExpired`)}</span>}
    {scheduleStatus === 'stale' && <span className="navis-receipt__detail">{korean.t(`${key}conflict`)}</span>}
    {available && <ActionButton ref={cancelButton} variant="secondary" onKeyDown={ignoreKeyRepeat} onClick={event => {
      if (event.detail > 1) return;
      setScheduleStatus(undefined);
      setCancelling(store.getSnapshot());
    }}>예약 취소하기</ActionButton>}
    {visible && run && notice && token && status !== 'undoing' && <ReceiptUndo run={run} store={store} identity={identity} token={token}
      noticeId={notice.id} focusRow={() => rowRef.current?.focus({ preventScroll: true })} refresh={() => setUndoAttempt(attempt => attempt + 1)} />}
  </div>;
}

export function PendingCardLocator({ transcript }: { readonly transcript: RefObject<HTMLDivElement | null> }) {
  const [hiddenRow, setHiddenRow] = useState<HTMLElement | null>(null);
  const [reserve, setReserve] = useState(false);
  const pulse = useRef<Animation | undefined>(undefined);
  useLayoutEffect(() => {
    const body = transcript.current;
    if (!body) return;
    let row: HTMLElement | null = null;
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => check());
    const check = () => {
      const next = body.querySelector<HTMLElement>('[data-navis-pending-action-row]');
      if (next !== row) {
        if (row) resize?.unobserve(row);
        row = next;
        if (row) resize?.observe(row);
      }
      const bounds = body.getBoundingClientRect();
      const action = row?.getBoundingClientRect();
      setHiddenRow(bounds.height && action?.height && (action.top < bounds.top || action.bottom > bounds.bottom) ? row : null);
      // M-19: the shared row is reserved while the transcript scrolls, so a new reply never resizes it.
      setReserve(body.scrollHeight > body.clientHeight + 1);
    };
    const observer = new MutationObserver(check);
    observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-navis-pending-action-row'] });
    resize?.observe(body);
    body.addEventListener('scroll', check, { passive: true });
    check();
    return () => { observer.disconnect(); resize?.disconnect(); body.removeEventListener('scroll', check); pulse.current?.cancel(); };
  }, [transcript]);
  const reveal = () => {
    if (!hiddenRow?.isConnected) return;
    const target = hiddenRow.querySelector<HTMLButtonElement>('button:not([disabled]):not([aria-disabled="true"])');
    if (!target) return;
    hiddenRow.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    target.focus({ preventScroll: true });
    const outline = hiddenRow.closest('.navis-card')?.querySelector<HTMLElement>('.navis-card__highlight');
    const reduced = hiddenRow.closest('[data-motion="reduced"]') || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const hold = timePolicy.existingHighlightMs, fade = motionTokens.duration.press, total = hold + fade * 2;
    pulse.current?.cancel();
    pulse.current = reduced
      ? outline?.animate?.([{ opacity: 1 }, { opacity: 1 }], hold)
      : outline?.animate?.([{ opacity: 0 }, { opacity: 1, offset: fade / total }, { opacity: 1, offset: (fade + hold) / total }, { opacity: 0 }], total);
  };
  return <div className="navis-pending-locator" data-reserve={reserve || undefined}>
    {hiddenRow && <><Icon name="clock" /><span>확인 대기 1건</span><ActionButton variant="secondary" onClick={reveal}>카드 보기<Icon name="chevron-down" /></ActionButton></>}
  </div>;
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
      <div><dt>{t.t(`${key}count`)}</dt><dd><ChangeValue before={t.format.number(menu.preview.countBefore)} after={t.format.number(menu.preview.countAfter)} /></dd></div>
    </dl>
    <ActionButton variant="ghost" className="navis-agent-controls__toggle" aria-expanded={expanded} aria-controls={detailsId}
      onClick={() => setExpanded(value => !value)}>{t.t(`${key}${expanded ? 'hideDetails' : 'showDetails'}`)}</ActionButton>
    <div id={detailsId} hidden={!expanded} className="navis-agent-controls__details" role="group"
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
    <div onInvalid={event => { event.preventDefault(); setAttempted(true); priceRef.current?.focus(); }}>
      <NumberField label={t.t(`${key}price`)} name="navis-menu-price" min={1} step={1} value={price} onValueChange={setPrice} inputRef={priceRef} error={attempted && !isMenuPrice(price) ? t.t(`${key}priceInvalid`) : undefined} />
    </div>
    {!priceOnly && <TextField name="navis-menu-memo" label={t.t(`${key}memo`)} value={memo} onValueChange={setMemo} inputRef={memoRef} error={attempted && memo.length > 1000 ? t.t(`${key}memoInvalid`) : undefined} />}
    {unavailable && <p role="alert">{t.t(`${key}manualRoute`)}</p>}
  </InlineForm>;
}
