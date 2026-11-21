import type { Locale } from '../../../contracts';
import { IconButton } from '../../../ui/components/controls';
import { Icon } from '../../../ui/icons';
import type { VoiceInputState } from './use-voice-input';

const copy = {
  ko: { start: '말로 입력', stop: '듣기 멈추기', listening: '듣고 있어요', processing: '음성을 글로 바꾸고 있어요', error: '듣지 못했어요. 글로 입력해 주세요' },
  en: { start: 'Voice input', stop: 'Stop listening', listening: 'Listening', processing: 'Turning speech into text', error: "Couldn't hear you. Type it instead" },
  'zh-Hans': { start: '语音输入', stop: '停止收听', listening: '正在听', processing: '正在将语音转成文字', error: '没听清，请打字输入' },
  'zh-Hant': { start: '語音輸入', stop: '停止收聽', listening: '正在聽', processing: '正在將語音轉成文字', error: '沒聽清，請打字輸入' },
} satisfies Record<Locale, Record<string, string>>;

export function VoiceInputButton({ status, toggle, locale }: { status: VoiceInputState; toggle: () => Promise<void>; locale: Locale }) {
  const words = copy[locale];
  return <IconButton icon="voice-booking" label={status === 'listening' ? words.stop : words.start} className="ai-conversation__mic"
    variant="secondary" data-voice-state={status} aria-pressed={status === 'listening'} disabled={status === 'starting'}
    loading={status === 'processing'} onClick={() => void toggle()} />;
}

export function VoiceInputStatus({ status, locale }: { status: VoiceInputState; locale: Locale }) {
  const words = copy[locale];
  if (status === 'error') return <div className="ai-conversation__voice-status" data-voice-state={status} role="alert"><Icon name="warning" />{words.error}</div>;
  if (status === 'listening' || status === 'processing') return <div className="ai-conversation__voice-status" data-voice-state={status} role="status">
    {status === 'listening' ? <><Icon name="voice-booking" />{words.listening}</> : words.processing}
  </div>;
  return null;
}
