import navisSymbol from '../../assets/brand/navis-symbol.svg';
import '../../assets/brand/brand.css';
import { Fragment, useContext, useId, useRef, useLayoutEffect, useState, type ReactNode, type KeyboardEvent } from 'react';
import type { BatchResult, DetailRef, FeatureId, PanelSpec, QueryCondition } from '../../contracts';
import { ActionButton, IconButton } from '../../ui/components/controls';
import { getRegistration } from '../../catalog';
import { useBundle, type Translator } from '../../i18n';
import { widgetFacts } from '../../data/widget-data';
import { groupStyle } from '../../ui/tones';
import { Icon } from '../../ui/icons';
import { UiContext } from '../../ui/context';
import { ChatGlyph } from './chat-glyphs';
import type { AnalysisAnswer } from './analysis';
import { navisBundle, navisTranslator, navisStreamMessages as copy } from './messages';
import { localizeFact } from './snapshot';
import { selectVerifiedEvidence, type EvidenceRow } from './evidence';
import type { PromptSuggestion } from './prompt-suggestions';
import type { AssistantReply, Candidate } from './types';
import { NAVIS_INPUT_LIMIT } from './navis-conversation';
import { PendingCardLocator } from './proposal-card';
import { useVoiceInput } from './media/use-voice-input';
import { renderAnswerText } from './answer-text';
import { VoiceInputButton, VoiceInputNote, VoiceInputStatus } from './media/voice-input';
import { voiceNoteText } from './media/voice-copy';
import { useChatReceiptFlow, type ChatReceiptContext } from './media/chat-receipt';
import './conversation.css';

/** Where a candidate's widget already is (from `findPlacement`); the host decides, the card only shows it. */
export interface CandidatePlacement { readonly pageIndex: number; readonly onViewedPage: boolean }
export interface CandidateCardProps {
  readonly candidate: Candidate; readonly onSelect?: () => void;
  readonly placed?: CandidatePlacement | null; readonly onViewOnBoard?: () => void;
}
export function CandidateCard({ candidate, onSelect, placed = null, onViewOnBoard }: CandidateCardProps) {
  const t: Translator = useBundle(navisBundle);
  const registration = getRegistration(candidate.featureId);
  if (!registration) return null;
  const name = t.t(registration.nameKey);
  const group = t.t(`group.${registration.groupId}`);
  const condition = candidate.condition;
  const period = condition.kind === 'dateRange' ? t.format.dateRange(condition.start, condition.end) : condition.kind === 'snapshot' ? t.format.date(condition.asOf, 'monthDay') : '';
  const first = candidate.preview.status === 'ready' ? widgetFacts(candidate.preview)[0] : undefined;
  const fact = candidate.summary === undefined
    ? first && !(candidate.featureId === 'voice-booking' && first.key.startsWith('pickup.')) ? localizeFact(first, t.locale) : undefined
    : candidate.summary;
  const size = t.t('navis.card.size', { w: candidate.size.width, h: candidate.size.height });
  if (t.locale === 'ko') {
    const note = candidate.placement === 'other-layer' ? t.t('page.inOtherLayer', { name, layer: t.t(`app.layer.${registration.layer}`) }) : placed ? (placed.onViewedPage ? t.t('navis.card.placed', { name }) : t.t('page.alreadyOn', { n: placed.pageIndex + 1 })) : null;
    const factLabel = fact?.label === '순매출' || fact?.label === '총매출' ? '오늘 매출' : fact?.label;
    return <div className="ai-candidate" role="group" aria-label={note?`${name}. ${note}`:name} style={groupStyle(registration.groupId)}><strong>{name}</strong>{fact && <span>{factLabel} {fact.display}</span>}{note && <span>{note}</span>}{candidate.placement !== 'other-layer' && (placed ? onViewOnBoard && <ActionButton variant="secondary" onClick={onViewOnBoard}>{t.t('navis.card.viewOnBoard')}</ActionButton> : <ActionButton variant="secondary" onClick={onSelect}>{t.t('navis.card.action')}</ActionButton>)}</div>;
  }
  const body = <>
    <strong>{name}</strong>{group !== name && <span className="ai-candidate__group">{group}</span>}
    <span>{period && `${period} · `}{size}</span>
    {fact && <span>{fact.label}: {fact.display}</span>}
    {!placed && <span>{candidate.reason}</span>}
  </>;
  if (candidate.placement === 'other-layer') {
    const note = t.t('page.inOtherLayer', { name, layer: t.t(`app.layer.${registration.layer}`) });
    return <div className="ai-candidate" data-readonly="other-layer" role="group" aria-label={`${name}. ${note}`} style={groupStyle(registration.groupId)}>{body}<span>{note}</span></div>;
  }
  if (placed) {
    const note = placed.onViewedPage ? t.t('navis.card.placed', { name }) : t.t('page.alreadyOn', { n: placed.pageIndex + 1 });
    return <div className="ai-candidate" data-readonly="placed" role="group" aria-label={`${name}. ${note}`} style={groupStyle(registration.groupId)}>{body}<span>{note}</span>{onViewOnBoard && <ActionButton variant="secondary" onClick={onViewOnBoard}>{t.t('navis.card.viewOnBoard')}</ActionButton>}</div>;
  }
  return <button type="button" className="ai-candidate" style={groupStyle(registration.groupId)} onClick={onSelect}>{body}<span>{t.t('navis.card.action')}</span></button>;
}

type EvidenceAction = Required<Pick<EvidenceRow, 'destination' | 'openLabel'>>;

function evidenceGroups(rows: readonly EvidenceRow[], canOpen: boolean) {
  const groups = new Map<string, { source: string; periodLabel: string; actions: EvidenceAction[] }>();
  const seen = new Set<string>();
  for (const { source, periodLabel, destination, openLabel } of rows) {
    const key = JSON.stringify([source, periodLabel]);
    const group = groups.get(key) ?? { source, periodLabel, actions: [] };
    groups.set(key, group);
    if (!canOpen || !destination || !openLabel) continue;
    const target = JSON.stringify(destination);
    if (seen.has(target)) continue;
    seen.add(target);
    group.actions.push({ destination, openLabel });
  }
  return [...groups.entries()];
}

function matchesCandidateScope(destination: EvidenceAction['destination'], candidate: Candidate) {
  if (destination.featureId !== candidate.featureId) return false;
  const condition: QueryCondition = destination.condition ?? (destination.date
    ? { kind: 'dateRange', start: destination.date, end: destination.date } : { kind: 'default' });
  const preview = candidate.condition;
  if (condition.kind === 'dateRange') return preview.kind === 'dateRange' && condition.start === preview.start && condition.end === preview.end;
  if (condition.kind === 'snapshot') return preview.kind === 'snapshot' && condition.asOf === preview.asOf;
  return preview.kind === 'default';
}

/** Reduced motion: the app's own setting when a UiProvider is mounted, else the system preference. */
function usePrefersReducedMotion(): boolean {
  const ui = useContext(UiContext);
  return ui ? ui.reducedMotion : typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function WaitingIndicator({ label, delayed, reduced }: { readonly label: string; readonly delayed?: boolean; readonly reduced: boolean }) {
  return <>
    <div className="ai-wait" data-motion={reduced ? 'reduced' : 'full'}>
      <span className="ai-wait__dots" aria-hidden="true"><span /><span /><span /></span>
      <p className="ai-wait__step" key={label}>{label}</p>
    </div>
    {delayed && <p className="ai-conversation__caption">{copy.delayed}</p>}
  </>;
}

const inProgress = (message: ConversationMessage) => message.delivery === 'waiting' || message.delivery === 'streaming';
const failed = (message: ConversationMessage) => message.result?.status === 'error'
  || (message.reply?.turn?.kind === 'refusal' && message.reply.turn.reason === 'request_failed');
const hasContent = (message: ConversationMessage) => !(
  message.role === 'assistant' && message.reply?.protocol === 'agent-v1' && !message.text && !message.reply.clarification
  && !message.reply.proposalSession && !message.reply.turn && !message.reply.panels.length
);
const waitingLabel = (message: ConversationMessage) => message.waitingStatus ?? copy.thinking;
const atEnd = (element: HTMLDivElement) => element.scrollHeight - element.scrollTop - element.clientHeight <= 8;

function positionReply(transcript: HTMLDivElement, reply: HTMLElement) {
  transcript.scrollTop = reply.offsetHeight > transcript.clientHeight ? reply.offsetTop : transcript.scrollHeight;
}

export interface ConversationMessage { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string; readonly result?: BatchResult; readonly analysis?: AnalysisAnswer; readonly examples?: readonly string[]; readonly reply?: AssistantReply; readonly requestText?: string; readonly delivery?: 'waiting' | 'streaming' | 'stopped'; readonly waitingVisible?: boolean; readonly delayed?: boolean; readonly waitingStatus?: string; readonly retryDismissed?: boolean; readonly placementPrompt?: string; readonly placementResults?: readonly string[] }
export interface AiConversationProps {
  readonly draft: string; readonly onDraftChange: (value: string) => void; readonly messages: readonly ConversationMessage[];
  readonly phase: 'idle' | 'interpreting' | 'placing'; readonly onSubmit: () => void; readonly onCancel: () => void; readonly onClose: () => void;
  readonly onShowPanel?: (id: FeatureId) => void; readonly featureName?: (id: FeatureId) => string; readonly onRetry?: (text?: string, messageId?: string) => void;
  readonly renderCandidate?: (candidate: Candidate) => ReactNode; readonly onSelectCandidate?: (candidate: Candidate) => void; readonly inputError?: boolean; readonly onPlaceSuggestion?: (specs: readonly PanelSpec[]) => void;
  readonly renderAgentReply?: (reply: AssistantReply, message: ConversationMessage) => ReactNode;
  /** `findPlacement` for a candidate's widget (null when not placed). Without it no card shows "already placed". */
  readonly placedOf?: (candidate: Candidate) => CandidatePlacement | null;
  readonly onViewCandidateOnBoard?: (candidate: Candidate) => void;
  readonly prompts?: readonly PromptSuggestion[];
  readonly surfaceVisible?: boolean;
  readonly onOpenEvidence?: (destination: DetailRef, opener: HTMLButtonElement) => void;
  readonly receiptContext?: ChatReceiptContext;
}
export function AiConversation({ draft, onDraftChange, messages, phase, onSubmit, onCancel, onClose, onShowPanel, featureName, onRetry, onPlaceSuggestion, renderCandidate, renderAgentReply, onSelectCandidate, inputError = false, placedOf, onViewCandidateOnBoard, prompts = [], surfaceVisible = true, onOpenEvidence, receiptContext }: AiConversationProps) {
  const t: Translator = useBundle(navisBundle);
  const name = featureName ?? ((id: FeatureId) => { const r = getRegistration(id); return r ? t.t(r.nameKey) : id; });
  const reducedMotion = usePrefersReducedMotion();
  const [initialIds] = useState(() => new Set(messages.filter(message => !inProgress(message)).map(message => message.id)));
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const previous = useRef<{ last?: ConversationMessage; owner?: string }>({});
  const [newAnswer, setNewAnswer] = useState<string>();
  const focusTranscript = useRef(false);
  const voiceSession = useRef<string | undefined>(undefined);
  const voiceArmed = useRef(false);
  const composing = useRef(false);
  const tooLong = draft.length > NAVIS_INPUT_LIMIT;
  const inputMessage = tooLong ? copy.inputLimit : inputError ? copy.inputRequired : '';
  const last = messages.at(-1);
  const photo = useChatReceiptFlow(receiptContext, last?.id, surfaceVisible, phase !== 'idle', body, nearBottom);
  const owner = messages.reduce<string | undefined>((ownerId, message) => message.role === 'user' ? message.id : ownerId, undefined);
  const voiceTurn = messages.reduce<string | undefined>((id, message) => message.role === 'user' || message.requestText ? message.id : id, undefined);
  const visibleWaiting = last && inProgress(last) && last.waitingVisible;
  const placing = phase === 'placing' ? t.t('navis.placing') : undefined;
  const freshReply = last?.role === 'assistant' && !initialIds.has(last.id) && !inProgress(last) && hasContent(last);
  const replyNotice = freshReply && !failed(last)
    ? last.delivery === 'stopped' ? copy.stoppedNotice : copy.replyReady
    : '';
  const alert = surfaceVisible ? inputMessage || (freshReply && failed(last) ? last.text : '') : '';
  // C-16 / M-23: the draft exactly as the dictation left it. The caption lives until the owner edits or sends it.
  const [dictated, setDictated] = useState<string>();
  const voice = useVoiceInput(text => {
    if (!voiceArmed.current || voiceSession.current !== voiceTurn || !surfaceVisible) return;
    voiceArmed.current = false;
    const separator = draft && !/\s$/u.test(draft) ? ' ' : '';
    const next = `${draft}${separator}${text}`;
    focusTranscript.current = true;
    setDictated(next);
    onDraftChange(next);
  }, () => { if (surfaceVisible) input.current?.focus({ preventScroll: true }); });
  const voiceNote = voice.status === 'idle' && dictated !== undefined && dictated === draft && draft.trim() !== '';
  const polite = surfaceVisible ? visibleWaiting ? last.delayed ? copy.delayed : waitingLabel(last) : placing ?? (replyNotice || (voiceNote ? voiceNoteText('ko') : '')) : '';
  useLayoutEffect(() => {
    if (voiceArmed.current && (!surfaceVisible || voiceSession.current !== voiceTurn)) {
      voiceArmed.current = false;
      voice.cancel();
    }
  });
  useLayoutEffect(() => {
    if (!focusTranscript.current) return;
    focusTranscript.current = false;
    input.current?.focus();
    input.current?.setSelectionRange(draft.length, draft.length);
  }, [draft]);
  useLayoutEffect(() => {
    const transcript = body.current;
    if (!transcript || !last || !surfaceVisible) return;
    const { last: prior, owner: priorOwner } = previous.current;
    previous.current = { last, owner };
    if (prior === last) return;

    const sent = owner !== undefined && owner !== priorOwner && !initialIds.has(owner);
    const completed = last.role === 'assistant' && hasContent(last) && !last.delivery && !failed(last)
      && (last.id !== prior?.id || inProgress(prior));
    if (completed && !initialIds.has(last.id)) {
      const reply = document.getElementById(`${id}-${last.id}`);
      if (reply && (nearBottom.current || sent)) {
        positionReply(transcript, reply);
        nearBottom.current = atEnd(transcript);
        setNewAnswer(undefined);
      } else if (reply) {
        // Pick the pill before paint using the scroll position from before the reply arrived.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setNewAnswer(last.id);
      }
    } else if (sent || nearBottom.current) {
      transcript.scrollTop = transcript.scrollHeight;
      nearBottom.current = true;
      if (sent) setNewAnswer(undefined);
    }
  }, [id, initialIds, last, owner, surfaceVisible]);

  function cancelVoice() {
    voiceArmed.current = false;
    voice.cancel();
  }
  function toggleVoice() {
    if (voice.status === 'idle' || voice.status === 'error') {
      voiceArmed.current = true;
      voiceSession.current = voiceTurn;
    }
    return voice.toggle();
  }
  function submit() {
    if (tooLong) return;
    cancelVoice();
    setDictated(undefined);
    if (draft.trim()) photo.cancelReading();
    if (!draft.trim()) input.current?.focus();
    onSubmit();
  }
  function stop() {
    cancelVoice();
    photo.cancelReading();
    if (phase !== 'idle') onCancel();
    input.current?.focus({ preventScroll: true });
  }
  function close() { cancelVoice(); photo.cancelReading(); onClose(); }
  function isComposing(event: KeyboardEvent) {
    return composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
  }
  function inputKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter') return;
    event.stopPropagation();
    if (event.shiftKey || isComposing(event)) return;
    event.preventDefault();
    submit();
  }
  function showNewAnswer() {
    const transcript = body.current;
    const reply = newAnswer && document.getElementById(`${id}-${newAnswer}`);
    if (transcript && reply) {
      positionReply(transcript, reply);
      nearBottom.current = atEnd(transcript);
      reply.focus({ preventScroll: true });
    }
    setNewAnswer(undefined);
  }
  function fillSuggestion(question: string) {
    if (!draft) onDraftChange(question);
    input.current?.focus({ preventScroll: true });
  }
  const exampleButton = (example: string) => <ActionButton key={example} variant="outline" onClick={() => fillSuggestion(example)}>{example}</ActionButton>;
  function renderMessage(message: ConversationMessage, index: number) {
    // An earlier answer keeps the language it was written in (AC-224).
    const bubble = message.reply?.locale ? navisTranslator(message.reply.locale) : t;
    const pending = inProgress(message);
    const fade = message.role === 'assistant' && !initialIds.has(message.id);
    const author = message.role === 'user' ? copy.owner : copy.assistant;
    const showAuthor = message.role === 'assistant' && messages[index - 1]?.role !== 'assistant';
    const text = message.text;
    const reads = message.reply?.turn?.kind === 'read' ? message.reply.turn.evidence : undefined;
    // The app's grounded read formatter emits the ready facts from these producing reads.
    const evidence = reads && text ? evidenceGroups(selectVerifiedEvidence(reads, reads.flatMap(read =>
      read.status === 'ready' && read.tool !== 'search_records' ? read.facts.map(fact => ({ fact })) : []), bubble), Boolean(onOpenEvidence)) : [];
    const sources = evidence.flatMap(([, group]) => group.actions.map(action => action.destination));
    const candidates = (message.reply?.panels ?? []).filter(candidate => !sources.some(source => matchesCandidateScope(source, candidate)))
      .map(candidate => candidate.summary && text.includes(`${candidate.summary.label} ${candidate.summary.display}`)
        ? { ...candidate, summary: null } : candidate);
    if (!pending && !hasContent(message)) return null;
    // M-17: a stopped or failed reply is one notice (icon + sentence + at most one action); the retry keeps its behaviour.
    const retry = !message.retryDismissed && onRetry && (message.reply?.mode === 'simple' || message.delivery === 'stopped' || failed(message))
      ? <ActionButton variant="outline" onClick={() => { cancelVoice(); photo.cancelReading(); onRetry(message.requestText, message.id); input.current?.focus({ preventScroll: true }); }}>{failed(message) ? copy.retryFailed : copy.retry}</ActionButton> : null;
    // M-05 / M-06: the assistant's key figures stay on one line in bold and its numbered or bulleted lines are real lists; the owner's words stay as typed.
    const answer = text ? <div className="ai-conversation__answer" lang={message.reply?.locale}>{renderAnswerText(text, { structured: message.role === 'assistant', korean: bubble.locale === 'ko' })}</div> : null;
    return <div className="ai-conversation__message" id={`${id}-${message.id}`} data-role={message.role} key={message.id}
      hidden={pending && !message.waitingVisible} tabIndex={message.role === 'assistant' && !pending ? -1 : undefined}
      aria-labelledby={`${id}-${message.id}-author`}>
      <h3 id={`${id}-${message.id}-author`} className={showAuthor ? 'ai-conversation__author' : 'ui-sr-only'}>{author}</h3>
      {pending && message.waitingVisible && <WaitingIndicator label={waitingLabel(message)} delayed={message.delayed} reduced={reducedMotion} />}
      {/* One element for everything the reply brings, so the answer and the cards appear in the same render with one fade (C-1). */}
      {!pending && <div className="ai-conversation__reveal" data-fade={fade || undefined}>
      {failed(message) ? <div className="ai-notice" data-tone="error"><Icon name="warning" />{answer}{retry}</div> : answer}
      {evidence.length > 0 && <ul className="ai-conversation__evidence">{evidence.map(([basis, { source, periodLabel, actions }]) => <li key={basis}>
        <span className="ai-conversation__basis">{actions.length === 0 && <Icon name="info" />}<span>{`근거 · ${source} · ${periodLabel}`}</span></span>
        {onOpenEvidence && actions.map(({ destination, openLabel }) => {
          const registration = getRegistration(destination.featureId);
          return <ActionButton key={JSON.stringify(destination)} className="ai-conversation__chip" variant="outline"
            style={registration ? groupStyle(registration.groupId) : undefined} onClick={event => onOpenEvidence(destination, event.currentTarget)}>
            {registration && <Icon name={registration.id} />}{openLabel}<ChatGlyph name="open" />
          </ActionButton>;
        })}
      </li>)}</ul>}
      {message.delivery === 'stopped' && <div className="ai-notice" data-tone="info"><Icon name="info" /><p>{copy.stopped}</p>{retry}</div>}
      {message.reply?.mode === 'simple' && !message.reply.outOfScope && !message.retryDismissed && <p className="ai-conversation__caption ai-conversation__simple"><Icon name="info" />{copy.simple}</p>}
      {!failed(message) && message.delivery !== 'stopped' && retry}
      {message.placementResults?.map((line,index)=><p key={index}>{line}</p>)}
      {message.placementPrompt && <p>{message.placementPrompt}</p>}
      {candidates.length ? <div className="ai-conversation__candidates">{candidates.some(candidate => !placedOf?.(candidate)) && <strong>{t.t('navis.candidates')}</strong>}{candidates.map((candidate, index) => <div key={`${candidate.featureId}-${index}`}>{renderCandidate ? renderCandidate(candidate) : <CandidateCard candidate={candidate} onSelect={() => onSelectCandidate?.(candidate)} placed={placedOf?.(candidate) ?? null} onViewOnBoard={onViewCandidateOnBoard ? () => onViewCandidateOnBoard(candidate) : undefined} />}</div>)}</div> : null}
      {message.reply && renderAgentReply?.(message.reply, message)}
      {message.reply?.examples?.map(exampleButton)}
      {message.analysis && <div className="ai-conversation__analysis"><strong>{t.t('navis.analysis.title', { name: name(message.analysis.suggestions[0].featureId) })}</strong><p>{message.analysis.periodLabel}</p>{message.analysis.metrics.map((metric) => <p key={metric.label}>{metric.label}: <strong>{metric.display}</strong></p>)}<p>{message.analysis.interpretation}</p>{message.analysis.suggestions.map((spec) => <ActionButton key={spec.featureId} variant="secondary" aria-label={t.t('navis.placeActionLabel', { name: name(spec.featureId) })} disabled={phase !== 'idle'} onClick={() => onPlaceSuggestion?.(message.analysis!.suggestions)}>{t.t('navis.placeAction')}</ActionButton>)}</div>}
      {message.examples?.map(exampleButton)}
      {message.result?.items.map((item, index) => <div key={`${item.spec.featureId}-${index}`}><span>{name(item.spec.featureId)}: {item.status === 'added' ? t.t('navis.item.added') : item.reason}</span>{item.data?.facts[0] && <p>{item.data.facts[0].key}: {item.data.facts[0].value}</p>}{item.status === 'duplicate' && onShowPanel && <ActionButton variant="secondary" onClick={() => onShowPanel(item.spec.featureId)}>{t.t('navis.card.viewOnBoard')}</ActionButton>}</div>)}
      {message.result?.examples?.map(exampleButton)}
      </div>}
    </div>;
  }
  return <section className="ai-conversation" lang="ko" aria-label={copy.assistant} data-motion={reducedMotion ? 'reduced' : 'full'}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDownCapture={(event) => {
      if (event.key === 'Escape' && isComposing(event)) event.stopPropagation();
    }}
    onKeyDown={(event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.stopPropagation();
      event.preventDefault();
      if (event.repeat) return;
      if (phase !== 'idle' || photo.reading) stop();
      else close();
    }}>
    <header className="ai-conversation__header"><h2><img src={navisSymbol} alt="" />{copy.assistant}</h2><IconButton icon="close" label={copy.close} variant="ghost" onClick={close} /></header>
    <div className="ai-conversation__body" role="region" aria-label={copy.transcript} tabIndex={0} ref={body}
      onScroll={(event) => {
        nearBottom.current = atEnd(event.currentTarget);
        if (nearBottom.current) setNewAnswer(undefined);
      }}>
      {messages.length === 0 && !photo.hasThread && <div className="ai-conversation__empty">
        <p className="ai-conversation__greeting">{copy.greeting}</p>
        {prompts.length > 0 && <div className="ai-conversation__prompts">{prompts.map(prompt => {
          const registration = getRegistration(prompt.readTemplate.featureId);
          return <ActionButton key={prompt.templateId} variant="outline" style={registration ? groupStyle(registration.groupId) : undefined}
            aria-label={`${prompt.readTemplate.text} 지금 ${prompt.countLabel}`} onClick={() => fillSuggestion(prompt.readTemplate.text)}>
            {registration && <Icon name={registration.id} />}
            <span>{prompt.readTemplate.text}</span><span className="ai-conversation__caption">{prompt.countLabel}</span>
          </ActionButton>;
        })}</div>}
      </div>}
      {photo.threadAt(undefined)}
      {messages.map((message, index) => <Fragment key={message.id}>{renderMessage(message, index)}{photo.threadAt(message.id)}</Fragment>)}
      {placing && <p>{placing}</p>}
      {phase === 'interpreting' && !messages.some(inProgress) && <p>{copy.thinking}</p>}
    </div>
    {/* M-19: one shared reserved row — locator on the left, the new-reply pill on the right. */}
    <div className="ai-conversation__rowbar">
      <PendingCardLocator transcript={body} />
      {newAnswer && <ActionButton className="ai-conversation__new-answer" variant="secondary" onClick={showNewAnswer}><ChatGlyph name="arrow-down" />{copy.newAnswer}</ActionButton>}
    </div>
    <div className="ai-conversation__composer">
      <VoiceInputStatus status={voice.status} locale="ko" />
      {photo.attachment}
      {/* M-20: one box holding the field and the toolbar. */}
      <div className="ai-conversation__box">
        <label className="ui-sr-only" htmlFor={id}>{copy.prompt}</label>
        <textarea name="navis-question" autoComplete="off" ref={input} id={id} rows={1} placeholder={copy.prompt} value={draft}
          onChange={(event) => { setDictated(undefined); onDraftChange(event.currentTarget.value); }} onKeyDown={inputKey}
          aria-invalid={Boolean(inputMessage) || undefined} aria-describedby={inputMessage ? `${id}-error` : undefined} />
        <div className="ai-conversation__actions">
          <div className="ai-conversation__tools">
            {photo.toolbar}
            <VoiceInputButton status={voice.status} toggle={toggleVoice} locale="ko" />
          </div>
          {draft.length > 3500 && <span className="ai-conversation__counter" data-over-limit={tooLong}>
            {draft.length.toLocaleString('ko')} / {NAVIS_INPUT_LIMIT.toLocaleString('ko')}
          </span>}
          {(phase !== 'idle' || photo.reading) && <ActionButton variant="outline" aria-label={photo.reading ? copy.receiptStop : copy.stopLabel} onClick={stop}><ChatGlyph name="stop" />{copy.stop}</ActionButton>}
          <ActionButton className="ai-conversation__send" disabled={tooLong} onClick={submit}><Icon name="send" />{copy.send}</ActionButton>
        </div>
      </div>
      {voiceNote && <VoiceInputNote locale="ko" />}
      {inputMessage && <p className="ai-conversation__input-error" id={`${id}-error`}><Icon name="warning" />{inputMessage}</p>}
    </div>
    <div className="ui-sr-only ai-conversation__announcer" aria-live="polite" aria-atomic="true">{polite}</div>
    <div className="ui-sr-only ai-conversation__announcer" aria-live="assertive" aria-atomic="true">{alert}</div>
  </section>;
}
