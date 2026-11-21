import navisSymbol from '../../assets/brand/navis-symbol.svg';
import navisLogo from '../../assets/brand/navis-logo.svg';
import '../../assets/brand/brand.css';
import { useContext, useEffect, useId, useMemo, useRef, useLayoutEffect, useState, type ReactNode, type KeyboardEvent } from 'react';
import type { BatchResult, FeatureId, PanelSpec } from '../../contracts';
import { ActionButton, IconButton } from '../../ui/components/controls';
import { getRegistration } from '../../catalog';
import { koreanScreenText, useBundle, type Translator } from '../../i18n';
import { widgetFacts } from '../../data/widget-data';
import { groupStyle } from '../../ui/tones';
import { UiContext } from '../../ui/context';
import type { AnalysisAnswer } from './analysis';
import { navisBundle, navisTranslator, navisStreamMessages as copy } from './messages';
import { localizeFact, questionContext } from './snapshot';
import type { AssistantReply, Candidate } from './types';
import { NAVIS_INPUT_LIMIT } from './navis-conversation';
import { useVoiceInput } from './media/use-voice-input';
import { VoiceInputButton, VoiceInputStatus } from './media/voice-input';
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
  const fact = first ? localizeFact(first, t.locale) : undefined;
  const size = t.t('navis.card.size', { w: candidate.size.width, h: candidate.size.height });
  if (t.locale === 'ko') {
    const note = candidate.placement === 'other-layer' ? t.t('page.inOtherLayer', { name, layer: t.t(`app.layer.${registration.layer}`) }) : placed ? (placed.onViewedPage ? t.t('navis.card.placed', { name }) : t.t('page.alreadyOn', { n: placed.pageIndex + 1 })) : null;
    const factLabel = fact?.label === '순매출' || fact?.label === '총매출' ? '오늘 매출' : fact?.label;
    return <div className="ai-candidate" role="group" aria-label={note?`${name}. ${note}`:name} style={groupStyle(registration.groupId)}><strong>{name}</strong>{fact && <span>{factLabel} {fact.display}</span>}{note && <span>{note}</span>}{candidate.placement !== 'other-layer' && (placed ? onViewOnBoard && <ActionButton variant="secondary" onClick={onViewOnBoard}>{t.t('navis.card.viewOnBoard')}</ActionButton> : <ActionButton variant="secondary" onClick={onSelect}>{t.t('navis.card.action')}</ActionButton>)}</div>;
  }
  const body = <>
    <strong>{name}</strong><span className="ai-candidate__group">{group}</span>
    <span>{period && `${period} · `}{size}</span>
    {fact && <span>{fact.label}: {fact.display}</span>}
    <span>{candidate.reason}</span>
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

/** Reduced motion: the app's own setting when a UiProvider is mounted, else the system preference. */
function usePrefersReducedMotion(): boolean {
  const ui = useContext(UiContext);
  return ui ? ui.reducedMotion : typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Dwell time per waiting step (ms): each stays inside 1.2-1.8 s, uneven so it reads as work and not as a metronome. */
const STEP_MS = [1500, 1300, 1700, 1400] as const;
/**
 * C-1: while a request runs, shows calm moving dots plus ONE step line that follows what the question touches
 * (`questionContext` topics -> widget names), then checks numbers, then composes. The line advances on a timer, jumps to the
 * last step once the first text has started (`composing`), holds the last step and never loops back. The bubble is a polite
 * live region, so a screen reader hears one sentence per step change and never a per-tick update; the dots are hidden from it.
 */
function WaitingIndicator({ requestText, composing, delayed, status, name }: {
  readonly requestText: string; readonly composing: boolean; readonly delayed?: boolean;
  readonly status?: string; readonly name: (id: FeatureId) => string;
}) {
  const t: Translator = useBundle(navisBundle);
  const reduced = usePrefersReducedMotion();
  const topics = useMemo(() => [...questionContext(requestText).topics].filter((id) => getRegistration(id)).slice(0, 2), [requestText]);
  const steps = topics.length
    ? [...topics.map((id) => t.t('navis.wait.topic', { name: name(id) })), t.t('navis.wait.numbers'), t.t('navis.wait.compose')]
    : [t.t('navis.wait.look'), t.t('navis.wait.find'), t.t('navis.wait.compose')];
  const last = steps.length - 1;
  const [index, setIndex] = useState(0);
  // Every step change is scheduled up front from the mount time, so a slow render never stretches a step.
  useEffect(() => {
    if (composing || delayed || status) return;
    let elapsed = 0;
    const timers = Array.from({ length: last }, (_, i) => setTimeout(() => setIndex(i + 1), elapsed += STEP_MS[i % STEP_MS.length]));
    return () => timers.forEach(clearTimeout);
  }, [composing, delayed, status, last]);
  const label = delayed ? copy.delayed : composing ? steps[last] : status ?? steps[Math.min(index, last)];
  return <div className="ai-wait" data-motion={reduced ? 'reduced' : 'full'}>
    <span className="ai-wait__dots" aria-hidden="true"><span /><span /><span /></span>
    <p className="ai-wait__step" key={label}>{label}</p>
  </div>;
}

export interface ConversationMessage { readonly id: string; readonly role: 'user' | 'assistant'; readonly text: string; readonly result?: BatchResult; readonly analysis?: AnalysisAnswer; readonly examples?: readonly string[]; readonly reply?: AssistantReply; readonly requestText?: string; readonly delivery?: 'waiting' | 'streaming' | 'stopped'; readonly delayed?: boolean; readonly waitingStatus?: string; readonly retryDismissed?: boolean; readonly placementPrompt?: string; readonly placementResults?: readonly string[] }
export interface AiConversationProps {
  readonly draft: string; readonly onDraftChange: (value: string) => void; readonly messages: readonly ConversationMessage[];
  readonly phase: 'idle' | 'interpreting' | 'placing'; readonly onSubmit: () => void; readonly onCancel: () => void; readonly onClose: () => void;
  readonly onShowPanel?: (id: FeatureId) => void; readonly featureName?: (id: FeatureId) => string; readonly onRetry?: (text?: string, messageId?: string) => void;
  readonly renderCandidate?: (candidate: Candidate) => ReactNode; readonly onSelectCandidate?: (candidate: Candidate) => void; readonly inputError?: boolean; readonly onPlaceSuggestion?: (specs: readonly PanelSpec[]) => void;
  readonly renderAgentReply?: (reply: AssistantReply, message: ConversationMessage) => ReactNode;
  /** `findPlacement` for a candidate's widget (null when not placed). Without it no card shows "already placed". */
  readonly placedOf?: (candidate: Candidate) => CandidatePlacement | null;
  readonly onViewCandidateOnBoard?: (candidate: Candidate) => void;
}
const EXAMPLES = [1, 2, 3, 4, 5, 6] as const;
export function AiConversation({ draft, onDraftChange, messages, phase, onSubmit, onCancel, onClose, onShowPanel, featureName, onRetry, onPlaceSuggestion, renderCandidate, renderAgentReply, onSelectCandidate, inputError = false, placedOf, onViewCandidateOnBoard }: AiConversationProps) {
  const t: Translator = useBundle(navisBundle);
  const name = featureName ?? ((id: FeatureId) => { const r = getRegistration(id); return r ? t.t(r.nameKey) : id; });
  const reducedMotion = usePrefersReducedMotion();
  // Replies already finished when the conversation opens never fade; a reply that finishes while it is open fades in once (C-1).
  const [initialIds] = useState(() => new Set(messages.filter((message) => message.delivery !== 'waiting' && message.delivery !== 'streaming').map((message) => message.id)));
  const id = useId(); const input = useRef<HTMLTextAreaElement>(null); const body = useRef<HTMLDivElement>(null); const nearBottom = useRef(true); const [newAnswer, setNewAnswer] = useState(false);
  const focusTranscript = useRef(false);
  const voice = useVoiceInput(text => {
    const typed = draft.trimEnd();
    focusTranscript.current = true;
    onDraftChange(typed ? `${typed} ${text}` : text);
  }, () => input.current?.focus());
  useLayoutEffect(() => {
    if (!focusTranscript.current) return;
    focusTranscript.current = false;
    input.current?.focus();
    input.current?.setSelectionRange(draft.length, draft.length);
  }, [draft]);
  useLayoutEffect(() => { const el = body.current; if (!el) return; const last = messages.at(-1); if (nearBottom.current || last?.role === 'user') { el.scrollTop = el.scrollHeight; nearBottom.current = true; setNewAnswer(false); } else if (last?.role === 'assistant') setNewAnswer(true); }, [messages]);
  const examples = EXAMPLES.map((n) => t.t(`navis.example.${n}`));
  function submit() { if (!draft.trim()) { input.current?.focus(); onSubmit(); return; } onSubmit(); }
  function close() { voice.cancel(); onCancel(); onClose(); }
  function key(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }
  const exampleButton = (example: string) => <ActionButton key={example} variant="outline" onClick={() => { onDraftChange(example); input.current?.focus(); }}>{example}</ActionButton>;
  const pinned = [...messages].reverse().find(({ reply }) => reply?.proposalSession?.isPending() || reply?.clarification?.isCurrent()
    || ((reply?.turn?.kind === 'clarification' || reply?.turn?.kind === 'ambiguity') && reply.turn.choices.length > 0 && reply.turn.isCurrent()));
  function renderMessage(message: ConversationMessage) {
    // The bubble's own sentences keep the language they were written in (AC-224).
    const bubble = message.reply?.locale ? navisTranslator(message.reply.locale) : t;
    // The streamed text stays off screen until the provider has resolved the whole reply (answer + cards), so nothing attaches late.
    const inProgress = message.delivery === 'waiting' || message.delivery === 'streaming';
    const fade = !reducedMotion && message.role === 'assistant' && !initialIds.has(message.id);
    const text = message.role === 'user' && message.text.length > NAVIS_INPUT_LIMIT
      ? `${message.text.slice(0, NAVIS_INPUT_LIMIT)}…` : message.text;
    if (!inProgress && message.role === 'assistant' && message.reply?.protocol === 'agent-v1' && !text && !message.reply.clarification
      && !message.reply.proposalSession && !message.reply.turn && !message.reply.panels.length) return null;
    return <div className="ai-conversation__message" data-role={message.role} key={message.id} role={message.role === 'assistant' ? (message.result?.status === 'error' ? 'alert' : 'status') : undefined}>
      <strong className="ai-conversation__author">{message.role === 'assistant' && <img src={navisSymbol} alt="" />}{t.t(message.role === 'user' ? 'common.speaker.user' : 'common.speaker.navis')}</strong>
      {inProgress && <WaitingIndicator requestText={message.requestText ?? ''} composing={message.delivery === 'streaming'} delayed={message.delayed} status={message.waitingStatus} name={name} />}
      {/* One element for everything the reply brings, so the answer and the cards appear in the same render with one fade (C-1). */}
      {!inProgress && <div className="ai-conversation__reveal" data-fade={fade || undefined}>
      {text && <div className="ai-conversation__answer">{text.split(/\n\n/u).map((paragraph,index)=><p key={index} style={{whiteSpace:'pre-line'}}>{message.role==='assistant'&&bubble.locale==='ko'?koreanScreenText(paragraph):paragraph}</p>)}</div>}
      {message.delivery === 'stopped' && <p>{copy.stopped}</p>}
      {message.reply?.mode === 'simple' && !message.retryDismissed && onRetry && <ActionButton variant="outline" onClick={()=>onRetry(message.requestText, message.id)}>{copy.retry}</ActionButton>}
      {message.placementResults?.map((line,index)=><p key={index}>{line}</p>)}
      {message.placementPrompt && <p>{message.placementPrompt}</p>}
      {message.reply?.panels.length ? <div className="ai-conversation__candidates"><strong>{t.t('navis.candidates')}</strong>{message.reply.panels.map((candidate, index) => <div key={`${candidate.featureId}-${index}`}>{renderCandidate ? renderCandidate(candidate) : <CandidateCard candidate={candidate} onSelect={() => onSelectCandidate?.(candidate)} placed={placedOf?.(candidate) ?? null} onViewOnBoard={onViewCandidateOnBoard ? () => onViewCandidateOnBoard(candidate) : undefined} />}</div>)}</div> : null}
      {message.reply && renderAgentReply?.(message.reply, message)}
      {message.reply?.examples?.map(exampleButton)}
      {message.analysis && <div className="ai-conversation__analysis"><strong>{t.t('navis.analysis.title', { name: name(message.analysis.suggestions[0].featureId) })}</strong><p>{message.analysis.periodLabel}</p>{message.analysis.metrics.map((metric) => <p key={metric.label}>{metric.label}: <strong>{metric.display}</strong></p>)}<p>{message.analysis.interpretation}</p>{message.analysis.suggestions.map((spec) => <ActionButton key={spec.featureId} variant="secondary" aria-label={t.t('navis.placeActionLabel', { name: name(spec.featureId) })} disabled={phase !== 'idle'} onClick={() => onPlaceSuggestion?.(message.analysis!.suggestions)}>{t.t('navis.placeAction')}</ActionButton>)}</div>}
      {message.examples?.map(exampleButton)}
      {message.result?.items.map((item, index) => <div key={`${item.spec.featureId}-${index}`}><span>{name(item.spec.featureId)}: {item.status === 'added' ? t.t('navis.item.added') : item.reason}</span>{item.data?.facts[0] && <p>{item.data.facts[0].key}: {item.data.facts[0].value}</p>}{item.status === 'duplicate' && onShowPanel && <ActionButton variant="secondary" onClick={() => onShowPanel(item.spec.featureId)}>{t.t('navis.card.viewOnBoard')}</ActionButton>}</div>)}
      {message.result?.examples?.map(exampleButton)}
      {message.result?.status === 'error' && onRetry && <ActionButton variant="outline" onClick={()=>onRetry(message.requestText)}>{t.t('common.retry')}</ActionButton>}
      </div>}
    </div>;
  }
  return <section className="ai-conversation" aria-label="Navis" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <header className="ai-conversation__header"><h2><img className="navis-logo" src={navisLogo} alt="Navis" /></h2><IconButton icon="close" label={t.t('common.close')} variant="ghost" onClick={close} /></header>
    <div className="ai-conversation__body" ref={body} onScroll={(event) => { const el = event.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8; if (nearBottom.current) setNewAnswer(false); }}>
      <p>{t.t('navis.greeting')}</p>
      {messages.length === 0 && <div className="ai-conversation__examples">{examples.map(exampleButton)}</div>}
      {messages.filter(message => message.id !== pinned?.id).map(renderMessage)}
      {phase !== 'idle' && !messages.some(message => message.delivery === 'waiting' || message.delivery === 'streaming') && <p role="status">{phase === 'interpreting' ? copy.thinking : t.t('navis.placing')}</p>}
    </div>
    {pinned && <div className="ai-conversation__pending">{renderMessage(pinned)}</div>}
    {newAnswer && <ActionButton variant="secondary" onClick={() => { if (body.current) body.current.scrollTop = body.current.scrollHeight; nearBottom.current = true; setNewAnswer(false); }}>{t.t('navis.newAnswer')}</ActionButton>}
    <div className="ai-conversation__input">
      {phase !== 'idle' && <div className="ai-conversation__actions"><ActionButton variant="outline" aria-label={copy.stopLabel} onClick={onCancel}>{copy.stop}</ActionButton></div>}
      <VoiceInputStatus status={voice.status} locale={t.locale} />
      <div className="ai-conversation__composer">
        <label className="ui-sr-only" htmlFor={id}>{t.t('common.navis.prompt')}</label>
        <textarea name="navis-question" autoComplete="off" ref={input} id={id} placeholder={t.t('common.navis.prompt')} value={draft} onChange={(event) => onDraftChange(event.currentTarget.value)} onKeyDown={key} aria-invalid={inputError || undefined} aria-describedby={inputError ? `${id}-error` : undefined} />
        <VoiceInputButton status={voice.status} toggle={voice.toggle} locale={t.locale} />
        <ActionButton onClick={submit}>{t.t('navis.send')}</ActionButton>
      </div>
      {inputError && <p id={`${id}-error`} role="alert">{t.t('navis.inputRequired')}</p>}
    </div>
  </section>;
}
