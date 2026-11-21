import { commonBundle } from './common';
import { widgetNamesBundle } from './widgets';

export { commonBundle, widgetNamesBundle };
export type { CommonBundleKey } from './common';
export type { WidgetNamesBundleKey } from './widgets';
/** Provider와 Translator 기본값에 들어가는 공통 묶음들 */
export const baseBundles = [commonBundle, widgetNamesBundle] as const;
export type CommonKey = import('./common').CommonBundleKey | import('./widgets').WidgetNamesBundleKey;
