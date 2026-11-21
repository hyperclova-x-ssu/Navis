/** T-072 live module surface (used by `features/cctv/index.ts`, T-074, and setup/zones). */
export {cnnBaseUrl, parseBaseUrl, socketUrl} from './config';
export {getCctvMode, setCctvMode, useCctvMode} from './mode';
export {
  ERROR_KEYS,
  HTTP_TIMEOUT_MS,
  fetchHealth,
  getZones,
  postPair,
  putZones,
  suggestZones,
  type CameraState,
  type CnnError,
  type CnnErrorCode,
  type CnnResult,
  type Health,
  type MaskRle,
  type PairResult,
  type SuggestedZone,
  type Zone,
  type ZoneSet,
} from './api';
export {parseFrameMessage, encodeFrameMessage, type FrameResult, type LivePersonBox, type ParsedFrame} from './frame';
export {ClockSync} from './clock';
export {LiveClient, LOST_MS, RECONNECTING_MS, SERVER_RETRY_MS, PING_MS, type LiveClientDeps, type LiveSnapshot} from './client';
export {liveCctvView, maskOutline, noOutline, type ZoneOutlineFn} from './liveView';
export {getLiveClient, requestPairing, useLiveCctvView, useLiveConnection, type PairError} from './hooks';
