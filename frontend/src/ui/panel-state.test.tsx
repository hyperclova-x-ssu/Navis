import './test-setup';
import '@testing-library/jest-dom/vitest';
import { StrictMode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Locale } from '../contracts';
import { I18nProvider } from '../i18n';
import { screenPresets } from '../layout/presets';
import { UiProvider } from './UiProvider';
import { FeaturePanel } from './components/card';
import { PanelState } from './components/metric-fit';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const full = 'There are no active coupons. Check today’s marketing tasks.';
const short = '진행 중인 쿠폰이 없어요.';
const fullByLocale = {
  ko: '진행 중인 쿠폰이 없어요. 오늘 할 홍보를 확인해 보세요.',
  en: full,
  'zh-Hans': '目前没有进行中的优惠券。看看今日推广吧。',
  'zh-Hant': '目前沒有進行中的優惠券。看看今日推廣吧。',
};
const message = () => document.querySelector('.ui-panel-state__message')!;

describe('DS 12.14.1 PanelState', () => {
  it.each([
    [1, 1, true], [2, 1, true], [3, 1, false], [4, 1, false],
    [1, 2, false], [2, 2, false], [3, 2, false], [4, 2, false],
    [1, 3, false], [2, 3, false], [3, 3, false], [4, 3, false],
    [1, 4, false], [2, 4, false], [3, 4, false], [4, 4, false],
  ] as const)('chooses by the actual %ix%i span (short: %s), without caller shape changes', (width, height, compact) => {
    render(<FeaturePanel featureId="coupon-status" groupId="customers" label="쿠폰 현황" width={width} height={height}>
      <PanelState message={full} shortMessage={short}/>
    </FeaturePanel>);
    expect(message()).toHaveTextContent(compact ? short : full);
    if (compact) expect(message()).not.toHaveTextContent(full);
    else expect(screen.queryByText(short)).not.toBeInTheDocument();
  });

  it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] satisfies Locale[])('keeps the same choice across text scale, edit mode and presets in %s', locale => {
    const tree = (width: number, scale: 100 | 125, editing: boolean, preset: 'A' | 'B') =>
      <I18nProvider locale={locale}><UiProvider screenPreset={screenPresets[preset]} textScale={scale} reducedMotion>
        <FeaturePanel featureId="coupon-status" groupId="customers" label="쿠폰 현황" width={width} height={1} editing={editing}>
          <PanelState shape="W" message={fullByLocale[locale]} shortMessage={<span>{short}</span>}/>
        </FeaturePanel>
      </UiProvider></I18nProvider>;
    const view = render(tree(2, 100, false, 'A'));
    for (const preset of ['A', 'B'] as const) for (const scale of [100, 125] as const) for (const editing of [false, true]) {
      view.rerender(tree(2, scale, editing, preset));
      expect(message()).toHaveTextContent(short);
      if (locale !== 'ko') expect(message()).toHaveAttribute('lang', 'ko');
      expect(document.querySelector('.ui-panel-state__description')).toHaveAttribute('lang', locale);
      expect(screen.getByRole('button', { name: /쿠폰 현황/ })).toHaveAccessibleDescription(new RegExp(fullByLocale[locale].replaceAll('.', '\\.')));
      view.rerender(tree(3, scale, editing, preset));
      expect(message()).toHaveTextContent(fullByLocale[locale]);
      expect(message()).not.toHaveAttribute('lang', 'ko');
    }
  });

  it('selects compact copy without measuring a box or observing its size', () => {
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    render(<FeaturePanel featureId="coupon-status" groupId="customers" label="쿠폰 현황" width={2} height={1}>
      <PanelState shape="W" message={full} shortMessage={short}/>
    </FeaturePanel>);
    expect(message()).toHaveTextContent(short);
    expect(measure).not.toHaveBeenCalled();
  });

  it('describes the panel with the full screen-language message and preserves its help through resize, updates and unmount', () => {
    const tree = (width: number, text: string, state = true) => <StrictMode><I18nProvider locale="en">
      <FeaturePanel featureId="coupon-status" groupId="customers" label="Coupons" width={width} height={1}>
        {state ? <PanelState message={text} shortMessage={short}/> : <p>Normal content</p>}
      </FeaturePanel>
    </I18nProvider></StrictMode>;
    const view = render(tree(1, full));
    const panel = screen.getByRole('button', { name: /Coupons/ });
    expect(panel).toHaveAccessibleDescription(new RegExp(full.replaceAll('.', '\\.')));
    expect(panel).toHaveAccessibleDescription(/Press and hold to change the layout/);
    const description = document.querySelector('.ui-panel-state__description')!;
    expect(description).toHaveTextContent(full);
    expect(description).toHaveAttribute('lang', 'en');
    view.rerender(tree(1, 'Updated full message.'));
    expect(panel).toHaveAccessibleDescription(/Updated full message\./);
    expect(panel).not.toHaveAccessibleDescription(/There are no active/);
    view.rerender(tree(3, full));
    expect(panel).not.toHaveAccessibleDescription(/There are no active/);
    expect(document.querySelector('.ui-panel-state__description')).toBeNull();
    view.rerender(tree(2, full));
    expect(panel).toHaveAccessibleDescription(/There are no active/);
    view.rerender(tree(2, full, false));
    expect(panel).toHaveAccessibleDescription(/Press and hold to change the layout/);
    expect(panel).not.toHaveAccessibleDescription(/There are no active/);
    expect(panel.getAttribute('aria-describedby')!.split(' ')).toHaveLength(1);
  });

  it('keeps the legacy message, alert, children and action when no short message is supplied', async () => {
    const retry = vi.fn();
    render(<PanelState tone="error" shape="Q" message="불러오지 못했어요" action={{ label: '다시 시도', widgetName: '메뉴', onPress: retry }}><span>추가 안내</span></PanelState>);
    expect(screen.getByRole('alert')).toHaveTextContent('불러오지 못했어요');
    expect(screen.getByText('추가 안내')).toBeVisible();
    await userEvent.setup().click(screen.getByRole('button', { name: /다시 시도/ }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ui-panel-state__description')).toBeNull();
  });

  it('only infers 1x1 from a standalone Q; an ambiguous standalone W keeps the full message', () => {
    const view = render(<PanelState shape="Q" message={full} shortMessage={short}/>);
    expect(message()).toHaveTextContent(short);
    view.rerender(<PanelState shape="W" message={full} shortMessage={short}/>);
    expect(message()).toHaveTextContent(full);
    view.rerender(<PanelState message={full} shortMessage={short}/>);
    expect(message()).toHaveTextContent(full);
  });

  it('does not clip or shrink state text boxes, and keeps normal title and padding tokens', () => {
    // jsdom has no geometry. Apply the kit cascade here; the dev check measures natural heights and line counts.
    const css = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = [...css.matchAll(/([^{}]*(?:\.ui-panel-state|\.ui-panel-title|\.ui-panel-surface|\.ui-root|\[data-text-scale)[^{}]*)\{([^{}]*)\}/g)]
      .map(match => `${match[1]}{${match[2]}}`).join('\n');
    document.head.append(style);
    try {
      const tree = (scale: 100 | 125, state: boolean) => <UiProvider screenPreset={screenPresets.A} textScale={scale} reducedMotion>
        <FeaturePanel featureId="coupon-status" groupId="customers" label="쿠폰 현황" width={1} height={1} flow>
          {state ? <PanelState message={full}/> : <p>정상</p>}
        </FeaturePanel>
      </UiProvider>;
      const view = render(tree(100, false));
      const titleStyle = () => {
        const s = getComputedStyle(screen.getByRole('heading'));
        return [s.fontSize, s.lineHeight, s.fontWeight, s.position, s.margin];
      };
      const normalTitle = titleStyle();
      view.rerender(tree(100, true));
      expect(titleStyle()).toEqual(normalTitle);
      expect(normalTitle.slice(0, 2)).toEqual(['var(--type-panel-title)', 'var(--leading-panel-title)']);
      for (const scale of [100, 125] as const) {
        view.rerender(tree(scale, true));
        expect(getComputedStyle(document.querySelector('.ui-root')!).getPropertyValue('--panel-padding').trim()).toBe(scale === 100 ? '20px' : '16px');
        for (const node of document.querySelectorAll('.ui-panel-state,.ui-panel-state__text,.ui-panel-state__message')) {
          const s = getComputedStyle(node);
          expect(s.flexShrink).toBe('0');
          expect(['', 'none']).toContain(s.maxHeight);
          expect(['', 'auto']).toContain(s.height);
          expect(['', 'visible']).toContain(s.overflow);
          expect(['', 'visible']).toContain(s.overflowX);
          expect(['', 'visible']).toContain(s.overflowY);
          expect(s.textOverflow).toBe('');
          expect(['', 'none']).toContain(s.getPropertyValue('-webkit-line-clamp'));
          expect(['', 'none']).toContain(s.getPropertyValue('line-clamp'));
        }
      }
    } finally { style.remove(); }
  });
});
