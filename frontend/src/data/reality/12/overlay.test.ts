// REAL-PLAN F12: over HTTP a section whose service source is not connected is withheld, never shown from rows the seed still holds.
import { describe, expect, it } from 'vitest';
import { selectWidget } from '../../models/select';
import { createWidgetDataStore } from '../../widget-data';
import type { BriefingModel } from '../../models/types';
import { sectionState, sectionWithheld } from './overlay';
import { briefingDay, briefingSession } from './testing';

const condition = { kind: 'default' } as const;
const read = (store: ReturnType<typeof createWidgetDataStore>): BriefingModel => {
  const view = selectWidget(store.getSnapshot(), 'briefing', condition, 'normal');
  if (view.status !== 'ready') throw new Error(`briefing view is ${view.status}`);
  return view.model;
};

describe('briefing over the service projection', () => {
  it('leaves the fixture model untouched', () => {
    const model = read(createWidgetDataStore());
    expect(model.real).toBeUndefined();
    expect(sectionState(model, 'tax')).toBe('ready');
    expect(sectionWithheld(model, 'reservations')).toBe(false);
  });

  it('carries the business day, the arrival day and the per-section state, and withholds sections whose source is not connected or unreadable', async () => {
    const { store, port } = briefingSession();
    await port.load('briefing');
    const model = read(store);
    expect(model.real).toMatchObject({ businessDay: briefingDay, arrivalDay: briefingDay, acknowledgement: null });
    expect(model.real!.sections.schedule.state).toBe('ready');
    expect(model.real!.sections.reservations.state).toBe('not-connected');
    expect(model.real!.sections.tax.state).toBe('not-connected');
    expect(model.real!.sections.purchasing.state).toBe('partial');
    expect(sectionWithheld(model, 'reservations')).toBe(true);
    expect(sectionWithheld(model, 'purchasing')).toBe(false);
    // The notes are exactly the sources a section depends on that are not ready, once each, in briefing order.
    expect(model.real!.notes.map(note => [note.key, note.state])).toEqual([
      ['reservations', 'not-connected'], ['purchasing', 'partial'], ['tax', 'not-connected'], ['notices', 'not-connected'], ['cctv', 'unavailable'],
    ]);
  });

  it('drops the alerts of a withheld source and recounts, so the panel, the detail and Navis agree', async () => {
    const { store, port, state } = briefingSession();
    const seeded = read(store);
    const seededIds = seeded.importantAlerts.groups.flatMap(group => group.items.map(item => item.id));
    expect(seededIds.some(id => id.startsWith('tax:'))).toBe(true); // the seed holds tax alerts a not-connected pair must not show
    await port.load('briefing');
    const withheld = read(store);
    const ids = withheld.importantAlerts.groups.flatMap(group => group.items.map(item => item.id));
    expect(ids.some(id => id.startsWith('tax:'))).toBe(false);
    expect(ids.some(id => id.startsWith('closure:'))).toBe(false);
    expect(withheld.importantAlerts.count).toBe(ids.length);
    expect(withheld.importantAlerts.groups.every(group => group.items.length > 0)).toBe(true);
    // Once the service reads the source, its alerts come back.
    state.sources.tax = { origin: 'pos', state: 'ready', period: null, data: [] };
    await port.retry('briefing');
    const connected = read(store);
    expect(connected.importantAlerts.groups.flatMap(group => group.items.map(item => item.id)).some(id => id.startsWith('tax:'))).toBe(true);
    expect(connected.real!.sections.tax.state).toBe('ready');
  });

  it('treats a source the service did not send as not connected', async () => {
    const { store, port, state } = briefingSession();
    delete state.sources.finance;
    await port.load('briefing');
    expect(read(store).real!.sections.closing.state).toBe('not-connected');
  });
});
