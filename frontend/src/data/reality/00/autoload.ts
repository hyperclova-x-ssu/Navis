/**
 * Eager glob: every pair adds `src/data/reality/nn/register.ts` (which calls `registerDomain`) and is picked up here,
 * so cutting a pair over never edits a shared file. Imported only by the app composition (`app-port.ts`), never by `register.ts` files.
 */
import { registeredAdapters } from './registry';

import.meta.glob('../[0-9][0-9]/register.ts', { eager: true });

export const autoloadedAdapters = registeredAdapters;
