import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StaffDetail, StaffPanel } from './index';
import { panelShape } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { TODAY } from '../../../data/widget-data';
import type { CellSpan, WidgetPanelProps } from '../../../contracts';
import { PanelRemainder } from './panel-remainder';
import { periodFor } from './model';

const mocked = vi.hoisted(() => ({ status: 'ready' as 'ready' | 'error' }));
const dispatch = vi.fn(() => ({ ok: true, revision: 1, value: 's1' }));
vi.mock('../../../data/react', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/react')>(),
  useDataDispatch: () => dispatch,
  useStaffSchedule: () => {
    if (mocked.status === 'error') return { status: 'error' };
    const week = periodFor(TODAY, 'week');
    return { status: 'ready', model: {
      staff: [{ staffId: 's1', name: '박민수', archivedAt: null }],
      rows: [{ scheduleId: 'r1', staffId: 's1', date: TODAY, kind: 'work', start: '08:00', end: '17:30', breakMinutes: 60 }],
      changes: [], today: { workingCount: 1, offCount: 0, nextHandoffAt: '17:30' }, hourly: [], period: { start: week.startDate, end: week.endDate },
    } };
  },
}));
afterEach(cleanup);
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const props = { featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' }, host } as unknown as React.ComponentProps<typeof StaffDetail>;

describe('staff detail', () => {
  it('keeps the remainder accurate as the panel fit guard hides and restores rows', async () => {
    const { container } = renderWithKit(<div><div className="row">박민수</div><div className="row">이서연</div><PanelRemainder total={3} rowSelector=".row" unit="명" /></div>);
    expect(screen.getByText('외 1명')).toBeTruthy();
    await act(async () => { container.querySelector('.row')!.setAttribute('data-fit-hidden', ''); });
    expect(screen.getByText('외 2명')).toBeTruthy();
    await act(async () => { container.querySelector('.row')!.removeAttribute('data-fit-hidden'); });
    expect(screen.getByText('외 1명')).toBeTruthy();
  });
  beforeEach(() => { dispatch.mockClear(); mocked.status = 'ready'; });
  it('validates a blank employee name before dispatching', () => {
    renderWithKit(<StaffDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '직원 추가하기' }));
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByText('직원 이름을 넣어 주세요')).toBeTruthy();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('sends a work schedule through the shared command', () => {
    renderWithKit(<StaffDetail {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '근무 추가하기' }));
    fireEvent.change(screen.getByLabelText('출근 시각'), { target: { value: '14:00' } });
    fireEvent.change(screen.getByLabelText('퇴근 시각'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'staff.saveSchedule', staffId: 's1', date: TODAY, start: '14:00', end: '18:00' }));
  });
  it.each([
    ['add', '근무 추가하기'],
    ['edit', '근무 고치기'],
  ])('refuses a shift that ends after midnight with the same-day wording in the %s form', (_name, title) => {
    renderWithKit(<StaffDetail {...props} />);
    if (title === '근무 추가하기') fireEvent.click(screen.getByRole('button', { name: title }));
    else fireEvent.click(screen.getByRole('button', { name: /박민수.*08:00~17:30 · 휴게 60분 고치기/ }));
    expect(screen.getByRole('form', { name: title })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('출근 시각'), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('퇴근 시각'), { target: { value: '02:00' } });
    fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(screen.getByRole('alert')).toHaveTextContent('근무는 같은 날 안에서만 정할 수 있어요');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('shows the failed state with a default 48 retry button in the detail, and the kit panel action on the card', () => {
    mocked.status = 'error';
    const { unmount } = renderWithKit(<StaffDetail {...props} />);
    const retry = screen.getByRole('button', { name: '다시 시도하기' });
    expect(retry).toHaveClass('ui-button--default');
    expect(retry).not.toHaveClass('ui-panel-action');
    fireEvent.click(retry);
    expect(host.resetPreview).toHaveBeenCalledTimes(1);
    unmount();
    const panel = { ...props, width: 2, height: 2, shape: panelShape(2, 2), presetId: 'A', editing: false } as WidgetPanelProps;
    renderWithKit(<StaffPanel {...panel} />);
    expect(screen.getByRole('button', { name: /다시 시도하기/ })).toHaveClass('ui-panel-action');
  });
  it('renders the current staffing count in all sixteen panel sizes', () => {
    for (const width of [1, 2, 3, 4] as CellSpan[]) for (const height of [1, 2, 3, 4] as CellSpan[]) {
      const panel = { ...props, width, height, shape: panelShape(width, height), presetId: 'A', editing: false } as WidgetPanelProps;
      renderWithKit(<StaffPanel {...panel} />);
      expect(screen.getByText('오늘 근무')).toBeTruthy();
      expect(screen.getByText('1')).toBeTruthy();
      cleanup();
    }
  });
  it('keeps the compact metric to two lines and aligns wide row names and values separately', () => {
    const panel = { ...props, width: 1, height: 1, shape: 'Q', presetId: 'A', editing: false } as WidgetPanelProps;
    const { container, rerender } = renderWithKit(<StaffPanel {...panel} />);
    expect(screen.queryByText('17:30 교대')).toBeNull();
    expect(container.querySelector('[data-slot="staff-schedule.metric.value"]')).toBeTruthy();
    rerender(<StaffPanel {...panel} width={2} shape="W" />);
    const row = screen.getByText('오전·낮').closest('.staff-value-row');
    expect(row?.querySelector('strong')?.textContent).toBe('0명');
    rerender(<StaffPanel {...panel} width={2} height={2} shape="S" />);
    expect(screen.getByText('교대')).toBeTruthy();
    expect(screen.getByText('박민수').closest('.staff-value-row')?.textContent).toContain('08:00~17:30');
  });

});
