import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { resolveVariant, previewVariants } from '../../../data/preview/variants';
import { CustomerAnalysisDetail, CustomerAnalysisPanel } from './customer-analysis';

/** K-E 13: the 비어 있음 sample of CCTV 현황 is the camera-less state ('카메라 연결이 필요해요', LOCALES 11 / AC-1075); 0건 stays its own sample. */
const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const common = { featureId: 'customer-analysis' as const, condition: { kind: 'default' as const }, host };
afterEach(cleanup);

it('picks no-cameras for the 비어 있음 family and keeps no-entries as a separate sample', () => {
  expect(resolveVariant('customer-analysis', { family: 'empty', overrides: {} })).toBe('no-cameras');
  const ids = previewVariants('customer-analysis').map((v) => v.id);
  expect(ids).toContain('no-cameras');
  expect(ids).toContain('no-entries');
  expect(resolveVariant('customer-analysis', { family: 'normal', overrides: { 'customer-analysis': 'no-entries' } })).toBe('no-entries');
});

it('says 카메라 연결이 필요해요 on the panel and in the detail, with a next step', () => {
  const panel = renderWithKit(<CustomerAnalysisPanel {...common} width={2} height={2} shape="S" presetId="A" editing={false} />, { preview: { family: 'empty', overrides: {} } });
  expect(panel.container).toHaveTextContent('카메라 연결이 필요해요');
  expect(screen.getByRole('button', { name: /연결하기/ })).toBeInTheDocument();
  cleanup();
  const detail = renderWithKit(<CustomerAnalysisDetail {...common} detailRef={{ featureId: 'customer-analysis' }} />, { preview: { family: 'empty', overrides: {} } });
  expect(detail.container).toHaveTextContent('카메라 연결이 필요해요');
  expect(screen.getByRole('button', { name: /연결하기/ })).toBeInTheDocument();
});
