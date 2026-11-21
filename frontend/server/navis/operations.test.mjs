import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';
import { operationAdapters } from './operations.mjs';

const today = '2026-11-17';
const refs = { date: { slot: 'date' }, hour: { slot: 'hour' } };
const fact = ([key, value]) => ({ key, value, unit: '', label: key, display: String(value) });
const reading = (tool, args, values) => ({ tool, args, facts: Object.entries(values).map(fact) });
const display = values => reading('get_ui_state', { section: 'display' }, values);
const review = (date, status, hour = 14, args = refs) => reading('get_cctv_review', args, {
  'cctv.review.date': date, 'cctv.review.hour': hour, 'cctv.review.status': status,
});
const adapter = command => operationAdapters.find(entry => entry.command === command);
function input(command, args, readings, searches = [], layer = 'management') {
  return { businessDate: today, layer, intent: { command, args }, readings, searches,
    slots: ['date', 'hour', 'volumePct', ...searches.map(search => search.querySlot)] };
}
const refused = reason => ({ outcome: 'refused', reason });
const ready = args => ({ outcome: 'ready', args });

test('the CCTV preflight matches the proposal slots and only prepares a visible, unmarked observation today', () => {
  const command = 'cctv.markPeakForReview';
  const { prepare, lookups } = adapter(command);
  const check = (...readings) => prepare({ input: input(command, refs, readings), reads: [] });
  assert.equal(validateAgentToolArgs('get_cctv_review', refs), true);
  assert.equal(validateAgentToolArgs('get_cctv_review', { date: today, hour: 14 }), false);
  assert.deepEqual(lookups?.(input(command, refs, [review(today, 'open')])) ?? [], []);
  assert.deepEqual(check(review(today, 'open')), ready(refs));
  assert.deepEqual(check(), refused('unavailable'));
  assert.deepEqual(check(review(today, 'open', 14, { ...refs, hour: { slot: 'other' } })), refused('unavailable'));
  assert.deepEqual(check(review(today, 'marked')), refused('duplicate'));
  for (const status of ['missing', 'unobserved', 'outside_hours']) {
    assert.deepEqual(check(review(today, status)), refused('invalid_target'));
  }
  assert.deepEqual(check(review('2026-11-16', 'open')), refused('invalid_target'));
  assert.deepEqual(check(review('2026-11-18', 'open')), refused('invalid_target'));
  assert.deepEqual(check(review(today, 'open', 25)), refused('invalid_target'));
});

test('simulation preflight requires a connected device and checks the current track only for play/skip', () => {
  const command = 'environment.setPlaying';
  const args = { playing: false };
  const connected = { 'music.device.status': 'connected', 'music.track.ready': 1 };
  assert.deepEqual(adapter(command).prepare({ input: input(command, args, [display(connected)]) }), ready(args));
  assert.deepEqual(adapter(command).prepare({ input: input(command, args, [display({ ...connected, 'music.track.ready': 0 })]) }), refused('unavailable'));
  assert.deepEqual(adapter(command).prepare({ input: input(command, { playing: 'false' }, [display(connected)]) }), refused('invalid_target'));
  const volume = 'environment.setVolume';
  const volumeArgs = { volumePct: { slot: 'volumePct' } };
  assert.deepEqual(adapter(volume).prepare({ input: input(volume, volumeArgs, [display({ 'music.device.status': 'connected' })]) }), ready(volumeArgs));
  assert.deepEqual(adapter(volume).prepare({ input: input(volume, volumeArgs, [display({ 'music.device.status': 'none' })]) }), refused('unavailable'));
});

test('selecting a playlist or track needs the exact handle from each scoped search', () => {
  const command = 'environment.selectTrack';
  const playlist = { handle: 'playlist-1', match: 'exact', fields: { hasTracks: true } };
  const track = { handle: 'track-1', match: 'exact' };
  const args = { trackId: { handle: track.handle }, playlistId: { handle: playlist.handle } };
  const search = (kind, id, match) => ({ kind, querySlot: `${kind}Query`, matches: [{ ...match, handle: id }] });
  const request = input(command, args, [display({ 'music.device.status': 'connected' })], [
    search('playlist', playlist.handle, playlist), search('track', track.handle, track),
  ]);
  const result = (match, found) => ({ status: 'ready', matches: found ?? [match] });
  const { prepare, lookups } = adapter(command);
  assert.deepEqual(lookups(request), [
    { name: 'search_records', args: { kind: 'track', querySlot: 'trackQuery' } },
    { name: 'search_records', args: { kind: 'playlist', querySlot: 'playlistQuery' } },
  ]);
  assert.deepEqual(prepare({ input: request, reads: [result(track), result(playlist)] }), ready(args));
  assert.deepEqual(prepare({ input: request, reads: [result({ ...track, handle: 'other' }), result(playlist)] }), refused('invalid_target'));
  assert.deepEqual(prepare({ input: request, reads: [result({ ...track, match: 'similar' }), result(playlist)] }),
    { outcome: 'ambiguous', lookupIndex: 0, field: 'trackId' });
  assert.deepEqual(prepare({ input: request, reads: [result(track), result({ ...playlist, fields: { hasTracks: false } })] }), refused('unavailable'));
});

test('live CCTV needs local connection evidence and briefing acknowledgement is a proposal', () => {
  const command = 'ui.setCctvMode';
  const check = (mode, available, layer) => adapter(command).prepare({ input: input(command, { mode }, [display({
    'cctv.mode': mode === 'mock' ? 'live' : 'mock', 'cctv.mode.liveAvailable': available,
  })], [], layer) });
  assert.deepEqual(check('live', 0), refused('unavailable'));
  assert.deepEqual(check('live', 1), ready({ mode: 'live' }));
  assert.deepEqual(check('mock', 0), ready({ mode: 'mock' }));
  assert.deepEqual(check('live', 1, 'pos'), refused('out_of_scope'));
  const acknowledgement = 'ui.acknowledgeBriefing';
  assert.deepEqual(adapter(acknowledgement).prepare({ input: input(acknowledgement, {}, []) }), ready({}));
});
