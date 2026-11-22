// D-333 (LARGE-CARDS-2): the large 정부지원 and 브리핑 cards show more of the real data they hold, and never write a line the data does not have.
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CellSpan, ContentShape, FeatureId, PreviewSelection, WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { dataBundle, selectWidget } from '../../../data/widget-data';
import { createTranslator } from '../../../i18n';
import { renderWithKit } from '../../../ui/test-utils';
import { widgets } from './index';
import { briefingOf } from './test-values';

afterEach(cleanup);
const shapeOf = (w: number, h: number): ContentShape => (w === 1 && h === 1 ? 'Q' : h === 1 ? 'W' : w === 1 ? 'T' : w === 2 && h === 2 ? 'S' : 'L');
const host: WidgetHost = { layer: 'management', resetPreview: () => {}, openClosing: () => true, openLinked: () => {}, openDetail: () => {}, notify: () => {}, acknowledgeBriefing: () => {} };
function panel(id: FeatureId, w: CellSpan, h: CellSpan, preview?: PreviewSelection) {
  const Panel = widgets.find((m) => m.id === id)!.Panel;
  return renderWithKit(<div data-testid="p"><Panel featureId={id} condition={{ kind: 'default' }} width={w} height={h} shape={shapeOf(w, h)} presetId="A" editing={false} host={host} /></div>, { preview });
}
const rows = () => [...document.querySelectorAll<HTMLElement>('.mm-row')];
const subs = (row: Element) => [...row.querySelectorAll('.mm-row__sub')].map((el) => (el.textContent ?? '').replace(/ /g, ' '));
const ko = createTranslator<string>('ko', dataBundle);
const grantsModel = () => {
  const view = selectWidget(createWidgetDataStore().getSnapshot(), 'grants', { kind: 'default' }, 'normal');
  if (view.status !== 'ready') throw new Error('grants is not ready');
  return view.model;
};

describe('정부지원 on large cards (D-333)', () => {
  const model = grantsModel();
  const candidates = model.notices.filter((n) => n.isCandidate);
  it('names the agency and region, the deadline and the days left, and the conditions of each program at 4x4', () => {
    expect(candidates.length).toBeGreaterThan(0);
    panel('grants', 4, 4);
    for (const notice of candidates) {
      const row = document.querySelector(`[data-row-id="${notice.noticeId}"]`)!;
      expect(row).not.toBeNull();
      const [line, conditions] = subs(row);
      expect(line).toContain(ko.t(notice.agencyKey));
      expect(line).toContain(ko.t(notice.regionKey));
      expect(line).toMatch(/마감: .+ \d{2}:\d{2}/);
      expect(line).toContain(`${notice.daysLeft}일 남음`);
      expect(conditions).toBe(`확인이 필요한 조건: ${notice.conditionKeys.map((key) => ko.t(key)).join(' · ')}`);
    }
  });
  it('lists every open notice at 4x4, the reviewed or applied ones with their state', () => {
    panel('grants', 4, 4);
    expect(rows()).toHaveLength(model.notices.length);
    expect(rows().map((row) => row.getAttribute('data-row-id'))).toEqual(model.notices.map((n) => n.noticeId));
  });
  it('keeps the smaller cards as before: candidates only, one caption line, no conditions', () => {
    for (const [w, h] of [[2, 2], [4, 2], [2, 4]] as const) {
      panel('grants', w, h);
      expect(rows()).toHaveLength(candidates.length);
      for (const row of rows()) expect(subs(row)).toHaveLength(1);
      expect(document.body.textContent).not.toContain('확인이 필요한 조건');
      cleanup();
    }
  });
  it('adds nothing when the data has no program', () => {
    panel('grants', 4, 4, { family: 'empty', overrides: {} });
    expect(rows()).toHaveLength(0);
    expect(document.querySelectorAll('.mm-row__sub')).toHaveLength(0);
  });
});

describe('브리핑 on large cards (D-333)', () => {
  const model = briefingOf();
  it('lists what each summary row counts at 4x4: today\'s entries, the reservation times', () => {
    panel('briefing', 4, 4);
    const schedule = document.querySelector('[data-row-id="schedules"]')!;
    expect(model.schedules.todayEntries.length).toBeGreaterThan(0);
    const [entries] = subs(schedule);
    for (const entry of model.schedules.todayEntries) expect(entries).toContain(typeof entry.title === 'object' && 'raw' in entry.title ? entry.title.raw : '');
    const reservation = document.querySelector('[data-row-id="reservations"]')!;
    expect(model.reservations.timeGroups.length).toBeGreaterThan(0);
    const [times] = subs(reservation);
    for (const group of model.reservations.timeGroups) expect(times).toContain(`${group.time} ${group.count}건 · ${group.partyTotal}명`);
  });
  it('writes a line only for a row that has something to list', () => {
    panel('briefing', 4, 4);
    for (const row of rows()) {
      const id = row.getAttribute('data-row-id');
      if (id === 'schedules' || id === 'reservations' || id === 'pickups') continue;
      expect(row.querySelectorAll('.mm-row__sub')).toHaveLength(0);
    }
    const { approvalPending, todayNotComplete } = model.custom.summary;
    const pickups = document.querySelector('[data-row-id="pickups"]')!;
    expect(subs(pickups)).toEqual(approvalPending > 0 || todayNotComplete > 0 ? [`주문제작 승인 대기 ${approvalPending}건 · 오늘 미완료 ${todayNotComplete}건`] : []);
  });
  it('keeps the 2x2 and 4x2 cards as before: the same rows without the second line', () => {
    for (const [w, h] of [[2, 2], [4, 2]] as const) {
      panel('briefing', w, h);
      expect(document.querySelectorAll('.mm-row__sub')).toHaveLength(0);
      cleanup();
    }
  });
});
