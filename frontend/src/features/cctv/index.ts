/** API-19: the only surface the `mgmt-customers` widget group reads (ARCHITECTURE 14.6 exception). Names only; no logic. */
export {useCctvMode, setCctvMode, useLiveConnection, requestPairing} from './live';
export type {PairError} from './live';
export {useCctvView} from './setup/useCctvView';
export {CctvStage} from './setup/CctvStage';
export {CctvSetup} from './setup/CctvSetup';
export {ZoneEditor} from './zones';
export {cctvBundle} from './messages';
export {CctvPlayback} from './playback';
export {PanelVideo} from './playback';
export type {CctvView, CctvMode, LiveConnection, ServerDownReason} from '../../data/cctv';
export type {PairResult} from './live';
export type {ZoneSet} from './zones';
