import type { Pool } from 'pg';
import { seedCatalog } from '../../../../../frontend/src/data/db/generated/catalog.ts';
import official from './data/sangdo-official.json' with { type: 'json' };
import { importOfficialLocalSnapshot } from './official.ts';

type OfficialSnapshot = Parameters<typeof importOfficialLocalSnapshot>[2];

/** The reviewed Seoul public-data snapshot for the café's area (see data/README.md). */
export const officialSnapshot: OfficialSnapshot = {
  ...official.snapshot as OfficialSnapshot,
  fetchedAt: [...official.meta.events.files, ...official.meta.licenses.files]
    .map(file => file.retrievedAt).sort().at(-1),
};

/**
 * Load the reviewed official rows for the café store with the marketing migrator pool.
 * Safe to rerun: rows keep stable IDs, unchanged rows are not rewritten and the source revision moves only on change.
 * The snapshot keeps its real dates; it is not shifted to the demo clock.
 */
export async function seedOfficialLocal(pool: Pool, storeId: string = seedCatalog.store.storeId) {
  await importOfficialLocalSnapshot(pool, storeId, officialSnapshot);
}
