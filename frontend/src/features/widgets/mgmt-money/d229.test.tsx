import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { fitScore, runFit } from './fit';
import { ledgerOf, man } from './test-values';
import { LedgerPanel, useLedgerSummary } from './ledger';
import { MoneyPanel } from './shared';
import { PanelLayout } from '../mgmt-store/shared';
import { readFileSync } from 'node:fs';
const css = readFileSync('src/features/widgets/mgmt-money/widget.css', 'utf8');
import type { WidgetHost } from '../../../contracts';

const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it.each([100, 125] as const)('places money units correctly at scale %s', scale => {
  const { container } = renderWithKit(<MoneyPanel spec={{ slot: 'ledger', label: '매출', value: '128.4', unit: '만 원', rows: [] }} ctx={{ shape: 'Q', width: 1, height: 1, scale, preset: 'A' }} />, { textScale: scale });
  const metric = container.querySelector('.ui-metric-fit')!;
  if (scale === 125) expect(metric).toHaveAttribute('data-stacked', 'false');
  else expect(metric).not.toHaveAttribute('data-stacked');
});

it('removes the divider from the last visible tax row even when later rows are fit-hidden', () => {
  const selector = '.mm-row:not(:has(~ .mm-row:not([data-fit-hidden])))';
  expect(css).toContain(`${selector} { border-block-end: 0; }`);
  const list = document.createElement('ul');
  list.innerHTML = '<li class="mm-row"></li><li class="mm-row"></li><li class="mm-row" data-fit-hidden></li>';
  expect(Array.from(list.querySelectorAll(selector))).toEqual([list.children[1], list.children[2]]);
});

it('keeps one pixel of default fit slack and lets a caller request zero', () => {
  const content = document.createElement('div');
  content.innerHTML = '<p class="row">row</p>';
  const row = content.firstElementChild!;
  Object.defineProperties(content, {
    clientHeight: { value: 100 },
    scrollHeight: { get: () => row.hasAttribute('data-fit-hidden') ? 100 : 101 },
  });
  expect(fitScore(content)).toBe(0);
  expect(fitScore(content, 0)).toBe(1);
  expect(runFit(content, [{ selector: '.row' }])).toBe(0);
  expect(runFit(content, [{ selector: '.row' }], 0)).toBe(1);
});

it('makes the manuals panel drop a row for a one-pixel overflow', () => {
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') ? 100 : 0; });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('ui-panel-content') && this.querySelector('.mgmt-row:not([data-fit-hidden])') ? 101 : 100; });
  const { container } = renderWithKit(<div className="ui-panel-content"><PanelLayout id="manuals" shape="L" width={3} height={2} label="매뉴얼" value="8" list={<div className="mgmt-row">새 직원</div>} /></div>);
  expect(container.querySelector('.mgmt-row')).toHaveAttribute('data-fit-hidden');
});

function LedgerSummary() { return <span data-testid="summary">{useLedgerSummary({ featureId: 'ledger', condition: { kind: 'default' } })}</span>; }
it.each(['en', 'ko', 'zh-Hans', 'zh-Hant'] as const)('preserves ledger money and reading order in %s', locale => {
  const { container, getByTestId } = renderWithKit(<><LedgerPanel featureId="ledger" condition={{ kind: 'default' }} width={1} height={1} shape="Q" presetId="A" editing={false} host={host} /><LedgerSummary /></>, { locale, textScale: 125 });
  const metric = container.querySelector('.ui-metric-fit')!;
  const value = metric.querySelector('.ui-metric-fit__value')!;
  const unit = metric.querySelector('.ui-metric-fit__unit')!;
  const net = ledgerOf().sales.net, fullWon = net.toLocaleString('en-US');
  if (locale === 'en') {
    expect(value).toHaveTextContent(fullWon);
    expect(unit).toHaveTextContent('₩');
    expect(metric.textContent).toBe(`₩${fullWon}`);
    expect(metric).toHaveAccessibleName(`₩${fullWon}`);
    expect(getByTestId('summary')).toHaveTextContent(`₩${fullWon}`);
  } else {
    expect(value).toHaveTextContent(man(net));
    expect(unit.textContent).toMatch(locale === 'ko' ? /만 원/ : /万韩元|萬韓元/);
  }
});
