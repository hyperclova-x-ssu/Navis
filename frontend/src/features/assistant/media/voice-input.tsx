import type { Locale } from '../../../contracts';
import { ActionButton } from '../../../ui/components/controls';
import { Icon } from '../../../ui/icons';
import { ChatGlyph } from '../chat-glyphs';
import type { VoiceInputState } from './use-voice-input';
import { voiceCopy, voiceNoteText } from './voice-copy';

const copy = voiceCopy;

/** C-16 / M-23: the one short caption under the field after a dictation, until the first edit or send. */
export function VoiceInputNote({ locale }: { locale: Locale }) {
  // Not a live region of its own: the chat's polite announcer says it once (C-21).
  return <p className="ai-conversation__voice-status" data-voice-state="captured"><Icon name="voice-booking" />{voiceNoteText(locale)}</p>;
}

export function VoiceInputButton({ status, toggle, locale }: { status: VoiceInputState; toggle: () => Promise<void>; locale: Locale }) {
  const words = copy[locale];
  // M-23: listening swaps the mic for the stop glyph; the accessible name already says "듣기 멈추기".
  return <ActionButton size="icon" aria-label={status === 'listening' ? words.stop : words.start} className="ai-conversation__mic"
    variant="secondary" data-voice-state={status} aria-pressed={status === 'listening'} disabled={status === 'starting'}
    loading={status === 'processing'} onClick={() => void toggle()}>{status === 'listening' ? <ChatGlyph name="stop" /> : <Icon name="voice-booking" />}</ActionButton>;
}

export function VoiceInputStatus({ status, locale }: { status: VoiceInputState; locale: Locale }) {
  const words = copy[locale];
  if (status === 'error') return <div className="ai-conversation__voice-status" data-voice-state={status} role="alert"><Icon name="warning" />{words.error}</div>;
  if (status === 'listening' || status === 'processing') return <div className="ai-conversation__voice-status" data-voice-state={status} role="status">
    {status === 'listening' ? <><Icon name="voice-booking" />{words.listening}</> : words.processing}
  </div>;
  return null;
}
