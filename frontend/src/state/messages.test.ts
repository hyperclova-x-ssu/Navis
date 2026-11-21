import { describe, expect, it } from 'vitest';
import { createTranslator } from '../i18n/translator';
import { runMessages } from './messages';

describe('RunStore 안내 한국어 fallback',()=>{
  it.each(['ko','en','zh-Hans','zh-Hant'] as const)('%s에서 템플릿 완료 이름과 거절 안내를 한국어로 읽는다',locale=>{
    const t=createTranslator(locale,runMessages);
    expect(t.t('run.template.A.completed')).toBe('하루 운영 중심으로 시작했어요');
    expect(t.t('run.template.B.completed')).toBe('재고·발주 중심으로 시작했어요');
    expect(t.t('run.template.C.completed')).toBe('손님·예약 중심으로 시작했어요');
    expect(t.t('run.session.conflict')).toBe('화면이 바뀌었어요. 다시 시도해 주세요');
    expect(t.t('run.session.validation')).toBe('입력한 내용을 다시 확인해 주세요');
  });
});
