/** T-073 zones module: SCR-349 editor and its pure helpers (re-exported by features/cctv/index.ts, T-074). */
export { ZoneEditor, type ZoneEditorProps } from './ZoneEditor';
export { createZonesApi, ZonesApiError, SUGGEST_TIMEOUT_MS, type ZonesApi } from './api';
export { zoneOutline, smoothRing, ringsToPath, decodeRle, encodeRle } from './mask';
export type { MaskRle, Zone, ZoneSet } from './types';
