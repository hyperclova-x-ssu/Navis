import {useMemo} from 'react';
import type {CctvView} from '../../../data/cctv';
import {useCctvMode, useLiveCctvView} from '../live';
import {snapshotView} from '../playback/snapshotView';

/**
 * API-19.2: the one screen model, mock or live. `video:false` holds no JPEG subscription and loads no mock data.
 * Mock here is the fixed scene (t=160, loads nothing); the playing mock view lives in `CctvPlayback` / `PanelVideo`.
 */
export function useCctvView(opts: {video: boolean; enabled?: boolean}): CctvView {
  const mode = useCctvMode();
  const live = useLiveCctvView({video: opts.video, enabled: opts.enabled !== false && mode === 'live'});
  const mock = useMemo(() => snapshotView(), []);
  return mode === 'live' ? live : mock;
}
