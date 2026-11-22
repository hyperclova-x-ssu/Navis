export interface EnvironmentReading {
  readonly measuredAt: string;
  readonly temperatureC: number;
  readonly humidityPct: number;
}
export type EnvironmentRange = readonly [number, number];
export interface EnvironmentPlaylist {
  readonly id: string;
  readonly name: string;
  readonly tracks: readonly { readonly id: string; readonly title: string; readonly artist: string }[];
}
export interface StoreEnvironment {
  readonly source?: 'manual';
  readonly manualAlert?: boolean;
  readonly limitsRevision?: number;
  readonly sensor: 'connected' | 'disconnected' | 'none';
  readonly current: EnvironmentReading | null;
  readonly readings: readonly EnvironmentReading[];
  readonly temperatureRange: readonly [number, number];
  readonly humidityRange: readonly [number, number];
  readonly musicDevice: 'connected' | 'none';
  readonly playlistId: string | null;
  readonly trackId: string | null;
  readonly playing: boolean;
  readonly volumePct: number;
  readonly playlists: readonly EnvironmentPlaylist[];
}
export interface EnvironmentTables {
  readonly storeEnvironment: StoreEnvironment;
  readonly realInsight?: import('../../reality/10/dto').RealInsight;
}
export type EnvironmentVariant = 'normal' | 'empty' | 'error' | 'out_of_range' | 'sensor_disconnected';
export interface EnvironmentAlert {
  readonly reason: 'OUT_OF_RANGE' | 'SENSOR_DISCONNECTED';
  readonly group: 'tasks';
  readonly messageKey: string;
  readonly sourceFeatureId: 'store-environment';
}
export interface StoreEnvironmentModel {
  readonly source?: 'manual';
  readonly status: 'ready' | 'empty' | 'error';
  readonly retryable: boolean;
  readonly messageKey?: string;
  readonly sensorStatus: StoreEnvironment['sensor'];
  readonly current: EnvironmentReading | null;
  readonly lastMeasuredAt: string | null;
  readonly ranges: { readonly temperature: readonly [number, number]; readonly humidity: readonly [number, number] };
  readonly trend: readonly EnvironmentReading[];
  readonly music: {
    readonly deviceStatus: StoreEnvironment['musicDevice'];
    readonly playlists: readonly EnvironmentPlaylist[];
    readonly playlistId: string | null;
    readonly track: EnvironmentPlaylist['tracks'][number] | null;
    readonly playing: boolean;
    readonly volumePct: number;
    readonly unavailableReason: 'DEVICE_UNAVAILABLE' | null;
  };
  readonly alerts: readonly EnvironmentAlert[];
}
export type EnvironmentPlayerCommand = (
  | { readonly type: 'environment.setPlaying'; readonly playing: boolean }
  | { readonly type: 'environment.skipTrack'; readonly direction: 'previous' | 'next' }
  | { readonly type: 'environment.selectPlaylist'; readonly playlistId: string }
  | { readonly type: 'environment.selectTrack'; readonly trackId: string; readonly playlistId?: string }
  | { readonly type: 'environment.setVolume'; readonly volumePct: number }
) & { readonly baseRevision?: number };

export type ObservationCommand = (
  | ({ readonly type: 'environment.recordReading' } & EnvironmentReading)
  | { readonly type: 'environment.updateLimits'; readonly expectedRevision: number; readonly temperatureRange: EnvironmentRange; readonly humidityRange: EnvironmentRange }
  | { readonly type: 'cctv.saveZones'; readonly cameraId: string; readonly expectedRevision: number; readonly zones: readonly import('../../reality/10/dto').ZoneInput[]; readonly confirmed?: boolean }
  | { readonly type: 'cctv.setTableLink'; readonly zoneId: string; readonly tableId: string | null; readonly expectedRevision: number; readonly confirmed?: boolean }
) & { readonly baseRevision?: number };

export type EnvironmentCommand = EnvironmentPlayerCommand | ObservationCommand;
