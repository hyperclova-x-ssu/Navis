/** LARGE-CARDS-2 (D-333): the big sizes show more of the real readings; nothing is invented when the data has none. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import '../../../ui/test-setup';
import { cleanup, render, screen, within } from '@testing-library/react';
import { EnvironmentPanel, type EnvironmentView } from './widget';

afterEach(cleanup);
const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
const base = {
  status: 'ready' as const, sensorStatus: 'connected' as const, current: { temperature: 22.5, humidity: 48 }, lastMeasuredAt: '15:40',
  ranges: { temperature: [18, 25] as const, humidity: [40, 60] as const },
  trend: hours.map((time, i) => ({ time, temperature: 21 + i / 2, humidity: 44 + i })),
  music: { deviceStatus: 'connected' as const, playing: true, volumePct: 30, track: '오후의 재즈 · 카페 연주곡', playlistId: 'p1', playlists: [{ playlistId: 'p1', name: '오후의 재즈' }] },
};
const view: EnvironmentView = base;
const port = { setPlaying: vi.fn(), skipTrack: vi.fn(), setVolume: vi.fn(), selectPlaylist: vi.fn(), retry: vi.fn() };
const rowsOf = (container: HTMLElement) => Array.from(container.querySelectorAll('.i7-environment-large-rows .i7-environment-value-row'));

describe('environment panel at large sizes (D-333)', () => {
  it('4x4 lists every reading of the trend, newest first, and the allowed range under each value', () => {
    const { container } = render(<EnvironmentPanel view={view} port={port} width={4} height={4} />);
    const rows = rowsOf(container);
    expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual([...hours].reverse());
    expect(rows[0]).toHaveTextContent('24.0°C · 50%');
    expect(rows.at(-1)).toHaveTextContent('21.0°C · 44%');
    expect(screen.getByText('적정 18.0~25.0°C')).toBeInTheDocument();
    expect(screen.getByText('적정 40~60%')).toBeInTheDocument();
  });
  it('3x3, 3x4 and 4x3 show the rows too; the smaller sizes keep the old content', () => {
    for (const [width, height] of [[3, 3], [3, 4], [4, 3]] as const) {
      const { container } = render(<EnvironmentPanel view={view} port={port} width={width} height={height} />);
      expect(rowsOf(container)).toHaveLength(hours.length);
      cleanup();
    }
    for (const [width, height] of [[1, 1], [2, 2], [2, 3], [2, 4], [3, 2], [4, 1], [4, 2]] as const) {
      const { container } = render(<EnvironmentPanel view={view} port={port} width={width} height={height} />);
      expect(rowsOf(container)).toHaveLength(0);
      expect(screen.queryByText('적정 18.0~25.0°C')).not.toBeInTheDocument();
      cleanup();
    }
  });
  it('shows exactly the readings the sensor has: one reading gives one row, no readings give none', () => {
    const one = render(<EnvironmentPanel view={{ ...base, trend: base.trend.slice(0, 1) }} port={port} width={4} height={4} />);
    expect(rowsOf(one.container)).toHaveLength(1);
    cleanup();
    const none = render(<EnvironmentPanel view={{ ...base, trend: [] }} port={port} width={4} height={4} />);
    expect(rowsOf(none.container)).toHaveLength(0);
    expect(none.container.querySelector('.i7-environment-large-rows')).toBeNull();
  });
  it('does not add a block to the empty and failed states', () => {
    const empty = render(<EnvironmentPanel view={{ status: 'empty' }} port={port} width={4} height={4} />);
    expect(empty.container.querySelector('.i7-environment-large-rows')).toBeNull();
    expect(within(empty.container).queryByText(/^적정/)).toBeNull();
    cleanup();
    render(<EnvironmentPanel view={{ status: 'error' }} port={port} width={4} height={4} />);
    expect(screen.queryByText(/^적정/)).toBeNull();
  });
});
