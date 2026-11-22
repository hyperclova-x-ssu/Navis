/** T-063: mkt-promo drop order when a panel does not fit (SCREENS 3.1, DS 11.9): the rows a large card adds (`.mp-extra`, D-333), notes, descriptions, extra lines, then list rows. Number, unit, title and the action stay.
 *  오늘 할 홍보 (SCR-37, D-65): the second sentence goes first, then the time tags (all together, see widget.css); the first sentence and the button always stay. D-231 keeps the tag in Korean wherever it fits. */
import { FitProbe as Probe, type FitPart } from '../mkt-local/fit';

export const PROMO_FIT: readonly FitPart[] = [{ selector: '.mp-extra', last: true }, { selector: '.mp-note' }, { selector: '.mp-desc' }, { selector: '.mp-block__sub' }, { selector: '.mp-block__note' }, { selector: '.mp-best-line' }, { selector: '.mp-strip__top' }, { selector: '.mp-best__label' }, { selector: '.mp-hint' }, { selector: '.mp-slot__second' }, { selector: '.mp-slot__tag' }, { selector: '.mp-slot__big' }, { selector: '.mp-trow, .mp-row, .mp-metric-rows li', last: true }];
export const FitProbe = Probe;
