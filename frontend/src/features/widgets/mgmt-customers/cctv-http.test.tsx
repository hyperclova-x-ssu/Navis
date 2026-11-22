import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { clearDetectionsCache } from '../../../data/cctv';
import { createWidgetDataStore } from '../../../data/widget-data';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { insightAdapter } from '../../../data/reality/10/adapter';
import { resetCctvModeForTest, setCctvMode } from '../../cctv/live/mode';
import { createStoreZonesApi } from '../../cctv/zones/real-api';
import { encodeRle, lassoCells } from '../../cctv/zones/mask';
import type { ZoneInput } from '../../../data/reality/10/dto';
import { renderWithKit } from '../../../ui/test-utils';
import { CustomerAnalysisDetail, CustomerAnalysisPanel } from './customer-analysis';

const asOf = '2026-11-17T06:45:00.000Z';
const cameraId = 'e79a88b6-e6a5-4d5b-b23a-78c7f72e2dcc';
const testPointerEvent = globalThis.PointerEvent;
const notify = vi.fn();
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify, acknowledgeBriefing: vi.fn() };

afterEach(() => { cleanup(); clearDetectionsCache(); resetCctvModeForTest(); notify.mockClear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function rig({ paired, roster = false }: { paired: boolean; roster?: boolean }) {
  const backend = fakeBackend();
  const page = (items: unknown[]) => ({ items, nextCursor: null, asOf, sourceRevision: 1 });
  backend.on('GET', '/insight/environment-summary', () => ({
    current: null, limits: { revision: 1, temperatureRange: [18, 25], humidityRange: [40, 60] }, alerts: [], asOf, sourceRevision: 1,
  }));
  backend.on('GET', '/insight/cameras', () => page([{
    cameraId, zoneSetRevision: 0, lastObservedAt: paired ? asOf : null,
    measurementStatus: paired ? 'ok' : 'none', deviceStatus: 'registered',
  }]));
  backend.on('GET', '/insight/cctv-buckets', () => page(paired ? [{
    cameraId, bucketStart: '2026-11-17T06:40:00.000Z', bucketMinutes: 5, zoneSetRevision: 0, observedUntil: asOf,
    status: 'ok', avgInStore: 2, maxInStore: 3, entries: [],
  }] : []));
  for (const path of ['/insight/zones', '/insight/table-links', '/insight/cctv-reviews', '/insight/environment-readings', '/pos/tables'])
    backend.on('GET', path, () => page([]));
  backend.on('POST', '/insight/cctv-reviews', () => ({ resourceId: 'review', revision: 1, receiptId: 'receipt', undoUntil: '2026-11-17T06:50:00.000Z', affectedSources: ['cctv.reviews'] }));
  const store = createWidgetDataStore();
  if (roster) {
    const { tables } = store.getSnapshot();
    store.hydrate({ staffCalendarAsOf: asOf, staffSchedule: [
      { scheduleId: 'working', staffId: tables.staff[0].staffId, date: '2026-11-17', kind: 'work', start: '15:30', end: '18:00', breakMinutes: 0 },
      { scheduleId: 'later', staffId: tables.staff[1].staffId, date: '2026-11-17', kind: 'work', start: '16:00', end: '18:00', breakMinutes: 0 },
    ] });
  }
  store.bindReal(createRealPort({ store, fetch: backend.fetch, source: domain => domain === 'cctv' ? 'http' : 'fixture', adapters: [insightAdapter], reconcileDelaysMs: [] }));
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  return { backend, store };
}

const detail = (store: ReturnType<typeof rig>['store']) => renderWithKit(
  <CustomerAnalysisDetail featureId="customer-analysis" condition={{ kind: 'default' }} detailRef={{ featureId: 'customer-analysis' }} host={host} />, { store });

const zonePath = `/insight/cameras/${cameraId}/zones`;
const savedZone = { zoneId: '163743ee-e751-4314-bf10-8e46db37ab96', cameraId, zoneSetRevision: 0, linkRevision: 0, label: '구역 1',
  polygon: [{ x: .10, y: .10 }, { x: .20, y: .10 }, { x: .20, y: .20 }, { x: .10, y: .20 }] };

async function openZoneEditor(polygon: ZoneInput['polygon'] | null = savedZone.polygon) {
  const { backend, store } = rig({ paired: false });
  backend.on('GET', '/insight/zones', () => ({ items: [{ ...savedZone, polygon }], nextCursor: null, asOf, sourceRevision: 1 }));
  await store.real!.load('cctv');
  setCctvMode('live');
  renderWithKit(<CustomerAnalysisDetail featureId="customer-analysis" condition={{ kind: 'default' }} detailRef={{ featureId: 'customer-analysis', view: 'zones' }} host={host} />, { store });
  await waitFor(() => expect(screen.getByRole('button', { name: '완료' })).toBeEnabled());
  return backend;
}

it.each([
  [400, { code: 'INVALID_REQUEST' }, '실행하지 못했어요 · 구역 정보에 문제가 있어요. 그린 구역을 확인해 주세요'],
  [400, { code: 'VALIDATION' }, '실행하지 못했어요 · 구역 정보에 문제가 있어요. 그린 구역을 확인해 주세요'],
  [422, { code: 'VALIDATION', reason: 'INVALID_ZONES' }, '실행하지 못했어요 · 구역 정보에 문제가 있어요. 그린 구역을 확인해 주세요'],
  [404, { code: 'CAMERA_NOT_FOUND' }, '실행하지 못했어요 · 카메라를 찾을 수 없어요. 카메라 연결을 확인해 주세요'],
  [404, { code: 'ZONE_NOT_FOUND' }, '실행하지 못했어요 · 저장된 구역을 찾을 수 없어요. 최신 구역을 불러와 주세요'],
  [409, { code: 'CONFLICT', reason: 'STALE_REVISION' }, '실행하지 못했어요 · 그사이 구역이 바뀌었어요. 최신 구역을 불러와 주세요'],
  [400, { code: 'CONFIRMATION_REQUIRED' }, '실행하지 못했어요 · 구역을 지우려면 확인이 필요해요. 삭제를 확인한 뒤 저장해 주세요'],
  [400, { code: 'IDEMPOTENCY_KEY_REQUIRED' }, '실행하지 못했어요 · 저장 요청을 확인할 수 없어요. 잠시 뒤 다시 시도해 주세요'],
  [409, { code: 'IDEMPOTENCY_MISMATCH' }, '실행하지 못했어요 · 같은 요청이 다른 내용으로 들어왔어요. 처음부터 다시 해 주세요'],
  [403, { code: 'STORE_FORBIDDEN' }, '실행하지 못했어요 · 로그인이 끝났어요. 다시 들어와 주세요'],
  [503, { code: 'SERVICE_UNAVAILABLE' }, '구역 저장 결과를 확인하지 못했어요. 다시 시도해 주세요'],
  [409, { code: 'CONFLICT', reason: 'UNRECOGNIZED_REASON' }, '실행하지 못했어요 · 현재 상태에선 진행할 수 없어요. 최신 내용을 확인해 주세요'],
])('shows the %j / %j failure once in W10 and leaves the draft open', async (status, error, message) => {
  const backend = await openZoneEditor();
  backend.on('PATCH', zonePath, () => reply(status, error));
  expect(backend.callsTo('PATCH', zonePath)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  expect((await screen.findByText(message)).closest('[role="alert"]')).toBeVisible();
  expect(screen.getAllByText(message)).toHaveLength(1);
  expect(screen.getByTestId('zone-announce')).toBeEmptyDOMElement();
  expect(screen.getByTestId('zone-stage').querySelector(`[data-zone="${savedZone.zoneId}"]`)).toBeInTheDocument();
  expect(backend.callsTo('PATCH', zonePath)).toHaveLength(1);
  expect(notify).not.toHaveBeenCalled();
});

it('explains why a legacy zone without an outline cannot be saved', async () => {
  const backend = await openZoneEditor(null);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('실행하지 못했어요 · 윤곽이 없는 기존 구역이 있어요. 목록에서 지우고 다시 그려 주세요');
  expect(backend.callsTo('PATCH', zonePath)).toHaveLength(0);
});

function dragZone(points: [number, number][]) {
  vi.stubGlobal('PointerEvent', testPointerEvent);
  const stage = screen.getByTestId('zone-stage');
  vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
  const pointer = (clientX: number, clientY: number) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX, clientY });
  fireEvent.pointerDown(stage, pointer(...points[0]));
  for (const point of points.slice(1)) fireEvent.pointerMove(stage, pointer(...point));
  fireEvent.pointerUp(stage, pointer(...points[points.length - 1]));
  return stage;
}

it('explains how to redraw a disconnected outline before sending a request', async () => {
  const backend = await openZoneEditor();
  fireEvent.click(screen.getByRole('button', { name: '지우개' }));
  dragZone([[150, 40], [150, 130]]);
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('실행하지 못했어요 · 구역 윤곽이 끊어져 있거나 너무 복잡해요. 한 구역을 한 번에 둘러 그려 주세요');
  expect(backend.callsTo('PATCH', zonePath)).toHaveLength(0);
});

it('retains newly drawn zones and retries the same edit from the failure alert', async () => {
  const backend = await openZoneEditor();
  const stage = dragZone([[400, 260], [600, 260], [600, 400], [400, 400]]);
  expect(stage.querySelectorAll('[data-adopted="true"]')).toHaveLength(2);

  backend.on('PATCH', zonePath, () => reply(400, { code: 'INVALID_REQUEST' }));
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('그린 구역을 확인해 주세요');
  expect(stage.querySelectorAll('[data-adopted="true"]')).toHaveLength(2);
  fireEvent.click(within(alert).getByRole('button', { name: '다시 시도하기' }));
  await screen.findByRole('alert');
  const [first, second] = backend.callsTo('PATCH', zonePath);
  expect(first.body).toMatchObject({ expectedRevision: 0, zones: [expect.objectContaining({ zoneId: savedZone.zoneId }), expect.objectContaining({ label: '구역 2' })] });
  expect(second.body).toEqual(first.body);
});

it('offers to reload when a save receipt arrived but the latest areas could not be read', async () => {
  const backend = await openZoneEditor();
  backend.on('PATCH', zonePath, () => ({ resourceId: cameraId, revision: 1, receiptId: 'receipt', affectedSources: ['cctv.zones'] }));
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('구역을 저장했어요. 저장 결과를 다시 불러와 확인해 주세요');
  expect(within(alert).getByRole('button', { name: '최신 구역 불러오기' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '완료' })).toBeDisabled();
  expect(backend.callsTo('PATCH', zonePath)).toHaveLength(1);
});

it('requires another press before saving a removed zone in the HTTP editor', async () => {
  const backend = await openZoneEditor();
  backend.on('PATCH', zonePath, () => reply(400, { code: 'CONFIRMATION_REQUIRED' }));
  fireEvent.click(screen.getByText('테이블 목록'));
  fireEvent.click(screen.getByRole('button', { name: '테이블 1 지우기' }));
  fireEvent.click(screen.getByRole('button', { name: '완료' }));
  expect(backend.callsTo('PATCH', zonePath)).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: '구역 삭제하고 저장하기' }));
  await screen.findByRole('alert');
  expect(backend.callsTo('PATCH', zonePath).map(call => call.body)).toEqual([{ expectedRevision: 0, confirmed: true, zones: [] }]);
});

it('D-355 renders the original example detail over the service data: same toggle, hour table and review mark', async () => {
  const { store, backend } = rig({ paired: true });
  const { container } = detail(store);
  expect(await screen.findByRole('radio', { name: '예시' })).toBeVisible();
  expect(container.querySelector('.mc-real-cctv')).toBeNull();
  const table = await screen.findByRole('table', { name: '시간대별 방문과 근무 인원' });
  const row = table.querySelector('[data-row-id="h15"]');
  expect(row).not.toBeNull();
  expect(row).toHaveTextContent('3');
  expect(screen.getByText(/최대 관측 인원이에요/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '다음 근무표에서 살펴보기' }));
  await waitFor(() => expect(backend.callsTo('POST', '/insight/cctv-reviews')).toHaveLength(1));
  expect(backend.callsTo('POST', '/insight/cctv-reviews')[0]?.body).toEqual({ date: '2026-11-17', hour: 15 });
  await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success', messageKey: 'data.notice.peakMarked', undoUntil: '2026-11-17T06:50:00.000Z' })));
});

it('D-355 shows the original live detail (day record under the setup/live area) over the service data', async () => {
  const { store } = rig({ paired: true });
  const { container } = detail(store);
  fireEvent.click(await screen.findByRole('radio', { name: '실시간' }));
  const record = await screen.findByTestId('cctv-day-record');
  expect(container.querySelector('.cc-detail')).not.toBeNull();
  expect(container.querySelector('.mc-real-cctv')).toBeNull();
  expect(record.querySelector('[data-row-id="h15"]')).not.toBeNull();
});

it('D-354 keeps the sample video available after switching back from live setup without observations', async () => {
  const { store } = rig({ paired: false });
  const { container } = detail(store);
  expect(await screen.findByRole('radio', { name: '예시' })).toBeVisible();
  fireEvent.click(screen.getByRole('radio', { name: '실시간' }));
  expect(container.querySelector('.cc-detail')).not.toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: '예시' }));
  await waitFor(() => expect(container.querySelector('.cc-detail')).toBeNull());
  expect(container.querySelector('[data-widget="customer-analysis"]')).not.toBeNull();
  expect(container.querySelector('video')).toHaveAttribute('src', '/cnn/store-sample.mp4');
});

it('D-355 draws the original 2×2 panel with the service rows', async () => {
  const { store } = rig({ paired: true });
  const { container } = renderWithKit(<CustomerAnalysisPanel featureId="customer-analysis" condition={{ kind: 'default' }} width={2} height={2} shape="Q" presetId="A" editing={false} host={host} />, { store });
  await waitFor(() => expect(container.querySelector('[data-widget="customer-analysis"]')).not.toBeNull());
  expect(container.querySelector('.mc-real-cctv-panel')).toBeNull();
});

it('shows roster staffing at the observation time even when there is no measured peak', async () => {
  const { store } = rig({ paired: false, roster: true });
  detail(store);
  const label = await screen.findByText('근무 인원', { selector: 'dt' });
  expect(label.nextElementSibling).toHaveTextContent('1명');
});

it('saves a rounded zone for a registered camera without a video stream and reads it in a fresh session', async () => {
  const { backend, store } = rig({ paired: false });
  const path = `/insight/cameras/${cameraId}/zones`;
  let revision = 1;
  const existing: ZoneInput = { zoneId: '163743ee-e751-4314-bf10-8e46db37ab96', label: '구역 1',
    polygon: [{ x: .10, y: .10 }, { x: .20, y: .10 }, { x: .20, y: .20 }, { x: .10, y: .20 }] };
  let zones = [existing];
  const page = (items: unknown[]) => ({ items, nextCursor: null, asOf, sourceRevision: revision });
  backend.on('GET', '/insight/cameras', () => page([{ cameraId, zoneSetRevision: revision, lastObservedAt: null,
    measurementStatus: 'none', deviceStatus: 'registered' }]));
  backend.on('GET', '/insight/zones', () => page(zones.map(zone => ({ ...zone, cameraId, zoneSetRevision: revision }))));
  backend.on('GET', '/insight/table-links', () => page([]));
  backend.on('PATCH', path, call => {
    const input = call.body as { zones: ZoneInput[]; expectedRevision: number };
    expect(input.expectedRevision).toBe(revision);
    expect(input.zones[0]).toEqual(existing);
    zones = input.zones.map(zone => ({ ...zone, zoneId: zone.zoneId ?? 'c15557f7-0626-4171-96ca-8568a6f4ddca' }));
    return { resourceId: cameraId, revision: ++revision, receiptId: 'receipt', affectedSources: ['cctv.zones'] };
  });
  const api = createStoreZonesApi(store, cameraId);
  const base = await api.get();
  const outline = Array.from({ length: 24 }, (_, index) => {
    const angle = index * Math.PI / 12;
    return [.79 + .075 * Math.cos(angle), .76 + .09 * Math.sin(angle)] as const;
  });
  expect(backend.callsTo('PATCH', path)).toHaveLength(0);
  await expect(api.put({ baseRevision: base.revision, frameAspect: null, zones: [...base.zones,
    { id: 'new', number: 2, source: 'drawn', mask: encodeRle(lassoCells(outline)) },
  ] })).resolves.toMatchObject({ revision: 2 });
  expect(backend.callsTo('PATCH', path)).toHaveLength(1);
  const next = createWidgetDataStore();
  next.bindReal(createRealPort({ store: next, fetch: backend.fetch, source: domain => domain === 'cctv' ? 'http' : 'fixture', adapters: [insightAdapter] }));
  await expect(createStoreZonesApi(next, cameraId).get()).resolves.toMatchObject({ revision: 2, zones: [
    { id: existing.zoneId }, { id: 'c15557f7-0626-4171-96ca-8568a6f4ddca' },
  ] });
});
