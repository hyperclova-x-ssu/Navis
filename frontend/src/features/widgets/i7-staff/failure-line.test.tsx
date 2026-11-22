import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetDetailProps } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { StaffDetail } from './widget';

afterEach(cleanup);
const props = {
  featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' },
  host: { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() },
} satisfies WidgetDetailProps;

// FIX leftover (gate r1a W14 K9): a refusal this widget has no sentence for reads "실행하지 못했어요 · {이유}. {다음}" instead of the bare "저장하지 못했어요. 다시 시도해 주세요".
it('shows the shared refusal line for a reason the form has no sentence for', () => {
  const store = createWidgetDataStore();
  vi.spyOn(store, 'dispatch').mockReturnValue({ ok: false, code: 'CONFLICT', reason: 'PROVIDER_REJECTED', messageKey: 'data.real.commandFailure.result.CONFLICT' });
  renderWithKit(<StaffDetail {...props} />, { store });
  fireEvent.click(screen.getByRole('button', { name: '직원 추가하기' }));
  fireEvent.change(screen.getByLabelText('직원 이름'), { target: { value: '새 직원' } });
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  expect(screen.getByRole('alert')).toHaveTextContent('실행하지 못했어요 · 현재 상태에선 진행할 수 없어요. 최신 내용을 확인해 주세요');
});
it('keeps the form sentence for a reason it knows', () => {
  const store = createWidgetDataStore();
  renderWithKit(<StaffDetail {...props} />, { store });
  fireEvent.click(screen.getByRole('button', { name: '직원 추가하기' }));
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  expect(screen.getByRole('alert')).toHaveTextContent('직원 이름을 넣어 주세요');
});
