/** API-201: 매뉴얼 작성. */
import type { WidgetModule } from '../../../contracts';
import { manualsModule } from './manuals';

export const widgets: readonly WidgetModule[] = Object.freeze([manualsModule]);
export { mgmtStoreBundle } from './messages';
export type { MgmtStoreKey } from './messages';
