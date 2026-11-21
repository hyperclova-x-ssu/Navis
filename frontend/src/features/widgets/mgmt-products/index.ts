/** API-201: menu is implemented by T-204; this entry belongs to the registry migration. */
import type { WidgetModule } from '../../../contracts';
import { MenuDetail, MenuPanel, useMenuSummary } from './menu';

export const widgets: readonly WidgetModule[] = Object.freeze([
  { id: 'menu', Panel: MenuPanel, Detail: MenuDetail, useSummary: useMenuSummary },
]);
