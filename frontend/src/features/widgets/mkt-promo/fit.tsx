/** T-063: mkt-promo drop order when a panel does not fit (SCREENS 3.1, DS 11.9): notes, descriptions, extra lines, then list rows. Number, unit, title and the action stay.
 *  오늘 할 홍보 (SCR-37, D-65): the second sentence goes first, then the time tags (all together, see widget.css); the first sentence and the button always stay. D-231 keeps the tag in Korean wherever it fits. */
import { FitProbe as Probe, type FitPart } from '../mkt-local/fit';

export const PROMO_FIT: readonly FitPart[] = [{ selector: '.mp-note' }, { selector: '.mp-desc' }, { selector: '.mp-block__sub' }, { selector: '.mp-block__note' }, { selector: '.mp-best-line' }, { selector: '.mp-strip__top' }, { selector: '.mp-best__label' }, { selector: '.mp-hint' }, { selector: '.mp-slot__second' }, { selector: '.mp-slot__tag' }, { selector: '.mp-slot__big' }, { selector: '.mp-trow, .mp-row, .mp-metric-rows li', last: true }];
/** The first key metric always remains; additional blocks can yield to its edit-mode budget. */
export const PERFORMANCE_FIT: readonly FitPart[] = [...PROMO_FIT, { selector: '.mp-block ~ .mp-block', last: true }];
export const FitProbe = Probe;

/** D-229: strip supporting line, note, and all change lines precede other fit steps. */
export const PERFORMANCE_STRIP_FIT: readonly FitPart[] = [
  { selector: '.mp-block__sub' }, { selector: '.mp-block__note' }, { selector: '.mp-strip__deltas' },
  ...PERFORMANCE_FIT.filter(part => part.selector !== '.mp-block__sub' && part.selector !== '.mp-block__note'),
];
