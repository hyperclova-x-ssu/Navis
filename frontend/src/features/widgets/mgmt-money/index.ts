/** API-201: 브리핑·손익·마진·세무관리·정부지원. */
import type { WidgetModule } from '../../../contracts';
import './widget.css';
import { briefingModule } from './briefing';
import { grantsModule } from './grants';
import { ledgerModule } from './ledger';
import { marginModule } from './margin';
import { taxModule } from './tax';

export const widgets: readonly WidgetModule[] = Object.freeze([briefingModule, ledgerModule, marginModule, taxModule, grantsModule]);
export { mgmtMoneyBundle, r2Review } from './messages';
export type { MgmtMoneyKey } from './messages';
