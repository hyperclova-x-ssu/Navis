import type { Locale } from '../../../contracts';

/** Voice input words. Fixed chat strings are Korean in every setting (D-329); the other languages stay filled so the table keeps its shape. */
export const voiceCopy = {
  ko: { start: '말로 입력', stop: '듣기 멈추기', listening: '듣고 있어요', processing: '음성을 글로 바꾸고 있어요', error: '듣지 못했어요. 글로 입력해 주세요', captured: '음성으로 받아 적었어요' },
  en: { start: 'Voice input', stop: 'Stop listening', listening: 'Listening', processing: 'Turning speech into text', error: "Couldn't hear you. Type it instead", captured: 'Typed from your voice' },
  'zh-Hans': { start: '语音输入', stop: '停止收听', listening: '正在听', processing: '正在将语音转成文字', error: '没听清，请打字输入', captured: '已按语音记下来了' },
  'zh-Hant': { start: '語音輸入', stop: '停止收聽', listening: '正在聽', processing: '正在將語音轉成文字', error: '沒聽清，請打字輸入', captured: '已按語音記下來了' },
} satisfies Record<Locale, Record<string, string>>;

/** C-16 / M-23: the caption under the field after a dictation, until the first edit or send. */
export const voiceNoteText = (locale: Locale) => voiceCopy[locale].captured;
