import type {ReactNode} from 'react';
import type {Box, CctvTableView, CctvView} from '../../../data/cctv';
import type {CctvMessageKey} from '../messages';
import {labelSpot, placeLabels} from './overlayLayout';
import type {OverlayOptions, OverlayRect} from './overlayLayout';
import {tableStateText, type TableStateTranslator} from './tableStateText';

const box = (b: Box) => ({x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1]});
const pts = (poly: readonly (readonly [number, number])[]) => poly.map(p => p.join(',')).join(' ');
const rings = (t: CctvTableView): readonly (readonly (readonly [number, number])[])[] => t.polygon ? [t.polygon] : t.rings ?? [];

/**
 * The one drawing function for boxes and table areas, shared by mock playback and live (T-074 imports it).
 * Draws a `CctvView` over the picture rectangle `rect`; it never knows the mode. Boxes swap instantly (M-22).
 * Zone chips need the translator function `t` (from `useBundle(cctvBundle)`) (names are message keys); without it only outlines are drawn.
 */
export function drawBoxes(view: CctvView, rect: OverlayRect, overlay: OverlayOptions, t?: TableStateTranslator): ReactNode {
  const zones = overlay.zones ? view.tables.filter(z => rings(z).length > 0) : [];
  const text = (z: CctvTableView) => t ? t('cctv.table.row', {name: t(z.label.key as CctvMessageKey, z.label.params), state: tableStateText(z, t)}) : '';
  const labels = t ? placeLabels(zones.map(z => {
    const w = text(z).length * 14 + 14;
    return {id: z.id, w, ...labelSpot(rings(z), rect.width, rect.height, w)}; // inside the zone (T-076), not at its bounding box corner
  })).map(l => ({...l, y: Math.max(0, Math.min(l.y, rect.height - 22))})) : [];
  return <div className="cctv-overlay" style={{left: rect.x, top: rect.y, width: rect.width, height: rect.height}} data-testid="cctv-overlay" data-stale={view.stale || undefined}>
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      {zones.map(z => <g key={z.id} data-zone={z.id} data-state={z.state}>
        {rings(z).map((r, i) => <g key={i}><polygon points={pts(r)} className="cctv-zone-halo"/><polygon points={pts(r)} className={`cctv-zone cctv-zone--${z.state}`}/></g>)}
      </g>)}
      {overlay.cups || overlay.persons ? <g data-testid="cctv-boxes">
        {overlay.cups ? view.cups.map((c, i) => <g key={`c${i}`}><rect {...box(c)} className="cctv-box-halo"/><rect {...box(c)} className="cctv-box cctv-box--cup"/></g>) : null}
        {overlay.persons ? view.persons.map((p, i) => <g key={`p${i}`}><rect {...box(p)} className="cctv-box-halo"/><rect {...box(p)} className="cctv-box cctv-box--person"/></g>) : null}
      </g> : null}
    </svg>
    {labels.map(l => <span key={l.id} className="cctv-zone-label" style={{left: l.x, top: l.y}}>{text(zones.find(z => z.id === l.id)!)}</span>)}
  </div>;
}
