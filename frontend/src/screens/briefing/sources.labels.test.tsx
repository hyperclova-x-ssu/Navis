// FIX-PKG-A T-26 (gate r1a W17): every source the service names reads in words in the "출처와 기준" card, never as its internal key.
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { createTranslator } from '../../i18n';
import type { BriefingRealView } from '../../data/reality/12/overlay';
import type { BriefingSource } from '../../data/reality/12/dto';
import { briefingBundle } from './messages';
import { SourcesCard, type BriefingCopy } from './real';

afterEach(cleanup);
const source = (key: string, over: Partial<BriefingSource> = {}): BriefingSource => ({ key, origin: 'marketing', provider: false, state: 'ready', period: null, asOf: null, sourceRevision: null, data: null, ...over });
const view = (...sources: BriefingSource[]): BriefingRealView => ({ businessDay: '2026-11-22', arrivalDay: null, asOf: '2026-11-22T02:00:00Z', acknowledgement: null, sources, sections: {} as never, notes: [] });
const copy = (locale: 'ko' | 'en' | 'zh-Hans' | 'zh-Hant'): BriefingCopy => {
  const { t } = createTranslator(locale, briefingBundle);
  return { t: (key, params) => t(key as never, params), date: iso => iso, time: hhmm => hhmm };
};

it.each([['marketingToday', '오늘 할 홍보'], ['coupons', '진행 중인 쿠폰']])('names the %s source "%s"', (key, label) => {
  render(<SourcesCard copy={copy('ko')} real={view(source(key))} />);
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.queryByText(key)).not.toBeInTheDocument();
});

it('never prints a source key the app has no name for', () => {
  render(<SourcesCard copy={copy('ko')} real={view(source('someFutureSource'))} />);
  expect(document.body.textContent).not.toContain('someFutureSource');
  expect(screen.getByText('그 밖의 자료')).toBeInTheDocument();
});

it.each(['en', 'zh-Hans', 'zh-Hant'] as const)('has the two new source names in %s', locale => {
  render(<SourcesCard copy={copy(locale)} real={view(source('marketingToday'), source('coupons'))} />);
  expect(document.body.textContent).not.toMatch(/marketingToday|coupons|briefing\.source/);
});
