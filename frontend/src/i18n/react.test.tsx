import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { I18nProvider, useBundle, useI18n, koreanScreenText } from './react';
import { defineBundle } from './bundles';
import type { Translator } from './types';

const own = defineBundle({
  id: 'own-react',
  ko: { 'own.hello': '안녕' },
  en: { 'own.hello': 'Hello' },
  'zh-Hans': { 'own.hello': '你好' },
  'zh-Hant': {},
});

function Probe() {
  const { t, locale } = useI18n();
  const mine = useBundle(own);
  return <p data-testid="p">{`${locale}|${t('common.close')}|${t('widget.inventory-booking.title')}|${mine.t('own.hello')}|${mine.t('common.undo')}`}</p>;
}

afterEach(cleanup);
describe('React', () => {
  it('Provider 밖에서는 한국어 번역기', () => {
    render(<Probe />);
    expect(screen.getByTestId('p').textContent).toBe('ko|닫기|재고|안녕|되돌리기');
  });
  it('Provider의 언어와 공통 묶음, 번체는 한국어로 대체', () => {
    const { rerender } = render(<I18nProvider locale="en"><Probe /></I18nProvider>);
    expect(screen.getByTestId('p').textContent).toBe('en|Close|재고|Hello|Undo');
    rerender(<I18nProvider locale="zh-Hans"><Probe /></I18nProvider>);
    expect(screen.getByTestId('p').textContent).toBe('zh-Hans|关闭|재고|你好|撤销');
    rerender(<I18nProvider locale="zh-Hant"><Probe /></I18nProvider>);
    expect(screen.getByTestId('p').textContent).toBe('zh-Hant|關閉|재고|안녕|復原');
  });
  it('protects separators and auxiliaries only when explicitly applied to visible copy', () => {
    const source='원두 입고 · B로스터리에서 팔아야 해요. 문자를 보낼 수 없어요';
    expect(koreanScreenText(source)).toBe('원두 입고\u00a0·\u00a0B로스터리에서 팔아야\u00a0해요. 문자를 보낼\u00a0수\u00a0없어요');
    expect(source).toBe('원두 입고 · B로스터리에서 팔아야 해요. 문자를 보낼 수 없어요');
  });
  it('useBundle 번역기는 렌더마다 같은 객체', () => {
    const seen: Translator[] = [];
    function Grab() { seen.push(useBundle(own) as Translator); return null; }
    const { rerender } = render(<I18nProvider locale="en"><Grab /></I18nProvider>);
    rerender(<I18nProvider locale="en"><Grab /></I18nProvider>);
    expect(seen[0]).toBe(seen[seen.length - 1]);
  });
  it('useBundle은 그 묶음 키와 공통 키로 타입이 좁혀진다', () => {
    function Types() {
      const tr = useBundle(own);
      expectTypeOf(tr.t).parameter(0).toEqualTypeOf<'own.hello' | import('./messages').CommonKey>();
      // @ts-expect-error 없는 키
      tr.t('own.nope');
      return null;
    }
    render(<Types />);
  });
});
