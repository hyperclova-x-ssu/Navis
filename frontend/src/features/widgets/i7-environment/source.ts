import type { StoreEnvironmentModel } from '../../../data/iteration7/environment';
import type { EnvironmentView } from './widget';

/** Project the same selector used for briefing into the controlled UI view. */
export function environmentView(model: StoreEnvironmentModel): EnvironmentView {
  if (model.status === 'error') return { status: 'error' };
  if (model.status === 'empty' || !model.current || (model.source !== 'manual' && model.sensorStatus === 'none')) return { status: 'empty' };
  return {
    status: 'ready', sensorStatus: model.source === 'manual' ? 'manual' : model.sensorStatus === 'disconnected' ? 'disconnected' : 'connected',
    current: { temperature: model.current.temperatureC, humidity: model.current.humidityPct },
    lastMeasuredAt: (model.lastMeasuredAt ?? '').slice(-5), ranges: model.ranges,
    trend: model.trend.map(item => ({ time: item.measuredAt.slice(-5), temperature: item.temperatureC, humidity: item.humidityPct })),
    music: { deviceStatus: model.music.unavailableReason ? 'disconnected' : 'connected', playing: model.music.playing, volumePct: model.music.volumePct,
      track: model.music.track ? `${model.music.track.title} · ${model.music.track.artist}` : '', playlistId: model.music.playlistId ?? '',
      playlists: model.music.playlists.map(item => ({ playlistId: item.id, name: item.name })) },
  };
}

import type { DataCommandResult } from '../../../data/commands/types';
import type { EnvironmentCommand } from '../../../data/iteration7/environment';
import type { EnvironmentPort } from './widget';
export function createEnvironmentPort(dispatch: (command: EnvironmentCommand) => DataCommandResult, retry: () => void): EnvironmentPort {
  return { retry, setPlaying: playing => dispatch({ type: 'environment.setPlaying', playing }), skipTrack: direction => dispatch({ type: 'environment.skipTrack', direction }), setVolume: volumePct => dispatch({ type: 'environment.setVolume', volumePct }), selectPlaylist: playlistId => dispatch({ type: 'environment.selectPlaylist', playlistId }) };
}
