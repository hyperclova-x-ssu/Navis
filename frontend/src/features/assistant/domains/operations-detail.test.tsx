import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import type { DetailRef, WidgetHost } from '../../../contracts';
import { BriefingDetail } from '../../widgets/mgmt-money/briefing';
import { CustomerAnalysisDetail } from '../../widgets/mgmt-customers/customer-analysis';
import { EnvironmentDetail } from '../../widgets/i7-environment/widget';

afterEach(cleanup);
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const condition = { kind: 'default' } as const;

// N19 hand-offs: a validated DetailRef opens the widget in the state the owner asked for. They never write.
it('opens the briefing on the 퇴근 tab for view closing and on 출근 for alerts', () => {
  const open = (detailRef: DetailRef) => renderWithKit(<BriefingDetail featureId="briefing" condition={condition} detailRef={detailRef} host={host} />);
  const closing = open({ featureId: 'briefing', view: 'closing' });
  expect(screen.getByRole('region', { name: '퇴근' })).toBeInTheDocument();
  closing.unmount();
  open({ featureId: 'briefing', view: 'alerts' });
  expect(screen.getByRole('region', { name: '출근' })).toBeInTheDocument();
  expect(host.acknowledgeBriefing).not.toHaveBeenCalled();
});

it('selects the requested CCTV hour from the hand-off and marks nothing', () => {
  renderWithKit(<CustomerAnalysisDetail featureId="customer-analysis" condition={condition} host={host} detailRef={{ featureId: 'customer-analysis', hour: 14 }} />);
  const rows = document.querySelectorAll('tr[data-row-id]');
  const selected = [...rows].filter(row => row.getAttribute('data-selected') === 'true');
  expect(selected.map(row => row.getAttribute('data-row-id'))).toEqual(['h14']);
});

it('scrolls the requested environment section into view and leaves the player alone', () => {
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const view = { status: 'ready' as const, sensorStatus: 'connected' as const, current: { temperature: 22.4, humidity: 47 }, lastMeasuredAt: '15:45',
    ranges: { temperature: [18, 25] as const, humidity: [40, 60] as const }, trend: [{ time: '15:45', temperature: 22.4, humidity: 47 }],
    music: { deviceStatus: 'connected' as const, playing: true, volumePct: 28, track: '오후의 재즈 피아노', playlistId: 'afternoon', playlists: [{ playlistId: 'afternoon', name: '오후의 재즈' }] } };
  const port = { setPlaying: vi.fn(), skipTrack: vi.fn(), setVolume: vi.fn(), selectPlaylist: vi.fn(), retry: vi.fn() };
  const plain = render(<EnvironmentDetail view={view} port={port} />);
  expect(scroll).not.toHaveBeenCalled();
  plain.unmount();
  render(<EnvironmentDetail view={view} port={port} focus="player" />);
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('group', { name: '매장 음악' })).toHaveAttribute('data-focus', 'true');
  expect(within(screen.getByRole('group', { name: '온도와 습도' })).queryByText('재생 중')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '일시정지' }));
  expect(port.setPlaying).toHaveBeenCalledWith(false);
});
