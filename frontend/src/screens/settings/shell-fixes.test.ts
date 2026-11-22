import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createKitTranslator } from '../../ui';
import { posBundle } from '../../i18n/messages/pos';
import { dataBundles } from '../../data/messages';
import { createTranslator } from '../../i18n/translator';

/** FIX-SHELL: small copy and layout fixes from UX-REVIEW-SHELL / TEXT-REVIEW-SHELL that stay inside the settings and shared kit text. */
describe('설정·공통 문구 정리 (TEXT-REVIEW-SHELL G-04·G-06·N-06)', () => {
  it('G-06: 주문 탭 안내는 “늘 보여요”를 한 번만 말한다', () => {
    const text = (posBundle.ko as Record<string, string>)['pos.orderAlways'];
    expect(text).toBe('주문 화면은 모든 흐름의 시작이라 늘 보여요');
    expect(text.match(/늘 보여요/g)).toHaveLength(1);
  });

  it('G-04: 영어 화면 모드는 보이는 이름과 읽히는 이름이 같다', () => {
    expect(createKitTranslator('en').t('ui.theme.mode')).toBe('Display mode');
  });

  it('N-06: 한국어 화면 글자에 “위젯”을 쓰지 않는다', () => {
    expect(createTranslator('ko', ...dataBundles).t('data.error.unknownWidget')).toBe('없는 패널이에요');
  });
});

describe('UXS-12: 화면 모드 두 칸이 트랙을 나눈다', () => {
  const css = readFileSync('src/screens/settings/settings.css', 'utf8');
  it('라이트·다크 칸이 같은 폭으로 늘어난다', () => {
    expect(css).toMatch(/\.ui-theme-tabs-list>\.ui-button\s*\{[^}]*flex:\s*1 1 0/);
  });
});
