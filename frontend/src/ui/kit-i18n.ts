import { useBundle } from '../i18n';
import { uiBundle } from './messages';
import { managementUiBundle } from './management-messages';
/** Translator for kit components: ui.* plus the common bundle. Falls back to Korean outside a provider. */
export function useKitT(){return useBundle(uiBundle,managementUiBundle);}
