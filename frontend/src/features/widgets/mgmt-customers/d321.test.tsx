import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { cctvBundle } from '../../cctv/messages';
import { CustomerAnalysisDetail } from './customer-analysis';
import { customersBundle } from './messages';

/** D-321 (owner, 2026-11-20): CCTV 현황 says no '추정', and its detail no longer has the '최근 8일 방문' block. */
const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const common = { featureId: 'customer-analysis' as const, condition: { kind: 'default' as const }, host };
afterEach(cleanup);

const LANGS = ['ko', 'en', 'zh-Hans', 'zh-Hant'] as const;

it('writes the example unit line, the now-numbers title and the analysis note without 추정 / Estimate / 估算 in all four locales', () => {
  for (const key of ['cctv.unit.mock', 'cctv.nowNumbers.mock', 'cctv.estimateNote'] as const) {
    for (const l of LANGS) expect((cctvBundle[l] as Record<string, string>)[key], `${l} ${key}`).not.toMatch(/추정|Estimate|估算|[·]\s*$/u);
  }
  expect(cctvBundle.ko['cctv.unit.mock']).toBe('매장 안 손님');
  expect(cctvBundle.ko['cctv.nowNumbers.mock']).toBe('지금 숫자');
  expect(cctvBundle.ko['cctv.estimateNote']).toBe('카메라 영상을 미리 분석한 숫자예요');
  // the live wording keeps 실시간
  expect(cctvBundle.ko['cctv.unit.live']).toBe('매장 안 손님 · 실시간');
  expect(cctvBundle.ko['cctv.nowNumbers.live']).toBe('지금 숫자 · 실시간');
});

it('does not show 추정 anywhere in the example detail and shows no 최근 8일 방문 block', () => {
  const { container } = renderWithKit(<CustomerAnalysisDetail {...common} detailRef={{ featureId: 'customer-analysis' }} />);
  expect(container.textContent).not.toMatch(/추정/);
  expect(screen.getByRole('heading', { name: '지금 숫자' })).toBeInTheDocument();
  expect(container.textContent).not.toMatch(/최근 8일 방문/);
  // the rest of the detail is unchanged: hourly chart table and the today-visits KPI still render
  expect(screen.getAllByText('방문 감지').length).toBeGreaterThan(0);
});

it('has no 최근 8일 방문 message left in any locale', () => {
  for (const l of LANGS) expect(Object.keys(customersBundle[l] as Record<string, string>)).not.toContain('widget.customer-analysis.trendTitle');
});
