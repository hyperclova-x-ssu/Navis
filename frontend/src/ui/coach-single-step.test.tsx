import './test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from './test-utils';
import { CoachMark, WidgetCoach } from './index';

afterEach(cleanup);
/** The note renders hidden without jsdom geometry, so buttons are looked up by their accessible name directly. */
const note = () => document.querySelector<HTMLElement>('.ui-popover--coach')!;
const button = (name: string) => Array.from(note().querySelectorAll('button')).find(button => (button.getAttribute('aria-label') ?? button.textContent) === name) ?? null;
const anchor = () => { const node = document.createElement('div'); document.body.append(node); return { current: node }; };
/** D-326 Q14: the last-step word (common.ok) in every locale. */
const OK = { ko: '확인', en: 'OK', 'zh-Hans': '确认', 'zh-Hant': '確認' } as const;
const CLOSE_TIP = { ko: '안내 닫기', en: 'Close tip', 'zh-Hans': '关闭提示', 'zh-Hant': '關閉提示' } as const;

describe('D-326 Q14: a single-step help or guide closes with 확인', () => {
  it.each(Object.keys(OK) as (keyof typeof OK)[])('names the close button of a widget help (no queue) after the last-step word in %s', locale => {
    const onClose = vi.fn();
    renderWithKit(<WidgetCoach open anchorRef={anchor()} onClose={onClose} title="Ledger">Shows money in and out</WidgetCoach>, { locale });
    const close = button(OK[locale])!;
    expect(close).not.toBeNull();
    expect(close).toHaveTextContent(OK[locale]);
    expect(button(CLOSE_TIP[locale])).toBeNull();
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledWith('button', expect.anything());
  });

  it('treats a queue of one as a single step', () => {
    renderWithKit(<WidgetCoach open anchorRef={anchor()} onClose={() => {}} title="손익" queue={{ current: 1, total: 1, onSkipAll: () => {} }}>오늘 매출</WidgetCoach>);
    expect(button('확인')).not.toBeNull();
    expect(button('안내 닫기')).toBeNull();
    expect(document.querySelector('.ui-coach-footer')).toBeNull();
  });

  it('shows 확인 on a one-step CoachMark, and honours a caller label', () => {
    const { rerender } = renderWithKit(<CoachMark open anchorRef={anchor()} onClose={() => {}}>필요한 기능을 여기서 눌러 추가해요</CoachMark>);
    expect(button('확인')).toHaveTextContent('확인');
    rerender(<CoachMark open anchorRef={anchor()} onClose={() => {}} closeLabel="Close tip">tip</CoachMark>);
    expect(button('Close tip')).toHaveTextContent('Close tip');
  });

  it('keeps 안내 닫기 on the close X while a sequence of two or more tips has its own footer', () => {
    renderWithKit(<WidgetCoach open anchorRef={anchor()} onClose={() => {}} title="손익" queue={{ current: 1, total: 3, onSkipAll: () => {}, onNext: () => {}, nextLabel: '다음' }}>오늘 매출</WidgetCoach>);
    expect(button('안내 닫기')).not.toBeNull();
    expect(within(note()).getByText('다음')).toBeInTheDocument();
    expect(button('확인')).toBeNull();
  });
});
