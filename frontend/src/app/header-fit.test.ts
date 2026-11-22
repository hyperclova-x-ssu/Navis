import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** TEXT-REVIEW-SHELL S-05: in English the 114px “Settings” button reached under the “마감 정산” button at 1920x1080 (18px overlap). */
describe('영어 헤더 단추가 겹치지 않는다', () => {
  const css = readFileSync('src/app/app.css', 'utf8');
  const lines = css.split('\n');
  const base = lines.find(line => line.startsWith('.app-closing-header '))!;
  const english = lines.find(line => line.startsWith(':root:lang(en) .app-closing-header'));

  it('영어에서만 닫는 헤더를 설정 단추 폭만큼 더 왼쪽에 둔다', () => {
    expect(english).toBeDefined();
    const offset = (rule: string) => rule.match(/right:calc\((.+?)\)\s*;/)![1];
    expect(offset(base)).toBe('var(--layout-margin) + var(--rail-width) + var(--rail-gap) + var(--space-16) + var(--space-8)');
    expect(offset(english!)).toBe('var(--layout-margin) + var(--rail-width) + var(--rail-gap) + var(--space-16) + var(--space-8) * 2');
  });

  it('다른 언어의 배치는 그대로다', () => {
    expect(lines.filter(line => /:root:lang\((?!en\))/.test(line) && line.includes('.app-closing-header'))).toEqual([]);
  });
});
