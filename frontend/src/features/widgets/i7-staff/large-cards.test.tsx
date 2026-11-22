// D-333 (LARGE-CARDS-2): the large 직원 스케줄표 card also shows the handoff time, the break of each shift, the week total and the latest change when the data has them.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StaffPanel } from './index';
import { panelShape } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import { TODAY } from '../../../data/widget-data';
import type { CellSpan, WidgetPanelProps } from '../../../contracts';
import { periodFor } from './model';

const data = vi.hoisted(() => ({ handoff: '17:30' as string | null, breakMinutes: 60, changes: [] as unknown[] }));
vi.mock('../../../data/react', async importOriginal => ({
  ...await importOriginal<typeof import('../../../data/react')>(),
  useDataDispatch: () => vi.fn(),
  useStaffSchedule: () => {
    const week = periodFor(TODAY, 'week');
    return { status: 'ready', model: {
      staff: [{ staffId: 's1', name: '박민수', archivedAt: null }, { staffId: 's2', name: '이서연', archivedAt: null }],
      rows: [
        { scheduleId: 'r1', staffId: 's1', date: TODAY, kind: 'work', start: '08:00', end: '17:30', breakMinutes: data.breakMinutes },
        { scheduleId: 'r2', staffId: 's2', date: TODAY, kind: 'off', start: null, end: null, breakMinutes: 0 },
      ],
      changes: data.changes, today: { workingCount: 1, offCount: 1, nextHandoffAt: data.handoff }, hourly: [], period: { start: week.startDate, end: week.endDate },
    } };
  },
}));
afterEach(() => { cleanup(); data.handoff = '17:30'; data.breakMinutes = 60; data.changes = []; });
const host = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() } as const;
const panel = (width: CellSpan, height: CellSpan) => ({ featureId: 'staff-schedule', condition: { kind: 'default' }, width, height, shape: panelShape(width, height), presetId: 'A', editing: false, host }) as unknown as WidgetPanelProps;
const render = (width: CellSpan, height: CellSpan) => renderWithKit(<div className="ui-feature-panel"><StaffPanel {...panel(width, height)} /></div>);
const latest = { shiftId: 'c1', after: { staffId: 's1', date: TODAY, kind: 'work', start: '09:00', end: '18:00', breakMinutes: 30 }, before: null };

describe('직원 스케줄표 on large cards (D-333)', () => {
  it('4x4 shows the next handoff beside the head count, the break of a shift, the week total and the latest change', () => {
    data.changes = [latest];
    const { container } = render(4, 4);
    expect(container.querySelectorAll('.staff-metrics .staff-primary')).toHaveLength(2);
    expect(container.querySelector('.staff-metrics')).toHaveTextContent('교대');
    expect(container.querySelector('.staff-metrics')).toHaveTextContent('17:30');
    expect(container.querySelector('.staff-break')).toHaveTextContent('휴게 60분');
    expect(container.querySelector('.staff-week-total')).toHaveTextContent('주간 총 1건 · 휴무 1건');
    expect(container.querySelector('.staff-recent')).toHaveTextContent('최근 변경 · 박민수 · ');
    expect(container.querySelector('.staff-recent')).toHaveTextContent('09:00~18:00 · 휴게 30분');
  });
  it('3x3 and 4x3 show them too', () => {
    for (const [width, height] of [[3, 3], [4, 3]] as const) {
      const { container } = render(width, height);
      expect(container.querySelector('.staff-week-total')).not.toBeNull();
      expect(container.querySelector('.staff-break')).not.toBeNull();
      cleanup();
    }
  });
  it('writes only what the data has: no handoff, no break and no change give no such line', () => {
    data.handoff = null; data.breakMinutes = 0;
    const { container } = render(4, 4);
    expect(container.querySelectorAll('.staff-metrics .staff-primary')).toHaveLength(1);
    expect(container.querySelector('.staff-break')).toBeNull();
    expect(container.querySelector('.staff-recent')).toBeNull();
  });
  it('keeps the shorter cards as before: no break line, no recent change in the wide card of two rows', () => {
    data.changes = [latest];
    for (const [width, height] of [[4, 2], [3, 2]] as const) {
      const { container } = render(width, height);
      expect(container.querySelector('.staff-break')).toBeNull();
      expect(container.querySelector('.staff-week-total')).toBeNull();
      expect(container.querySelector('.staff-recent')).toBeNull();
      expect(container.querySelectorAll('.staff-metrics .staff-primary')).toHaveLength(1);
      cleanup();
    }
  });
});
