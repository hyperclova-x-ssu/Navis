import { useBundle } from '../../i18n';
import { shellBundle } from './messages';

/** Translator for the app shell: shell bundle plus the common bundle. */
export function useShellT() { return useBundle(shellBundle); }
