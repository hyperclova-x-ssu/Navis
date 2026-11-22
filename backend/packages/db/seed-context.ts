import content from '../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import { businessDateAt, generate } from '../../../db/seed/ansungjalbu/generate.mjs';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';
import manifest from '../../../frontend/src/data/db/generated/manifest.json' with { type: 'json' };
import { disposableReplayClock } from '../contracts/replay-clock.ts';

/** Parse a fixture instant without accepting local timestamps or normalized invalid dates. */
function parseSeedInstant(value: string, setting: string) {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const now = new Date(value);
  const day = new Date(`${match?.[1]}T00:00:00Z`);
  if (!match || !Number.isFinite(+now) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== match[1]) {
    throw new Error(`${setting} must be a timezone-qualified ISO timestamp`);
  }
  return now;
}

type HostedClock = { now: Date; endDate?: string };

const seoulCalendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });

export function resolveHostedSeedClock({ instant, endDate }: { instant?: string; endDate?: string }): HostedClock {
  if (!instant) return { now: new Date(), endDate };

  const now = parseSeedInstant(instant, 'NAVIS_NAVER_VIRTUAL_SEED_INSTANT');
  if (endDate && endDate !== seoulCalendar.format(now)) {
    throw new Error('NAVIS_HOSTED_DEMO_SEED_END_DATE conflicts with the shared Persona seed instant');
  }
  return { now };
}

export function createSeedContext(hosted?: HostedClock) {
  const pinned = hosted?.endDate || undefined;
  const end = hosted ? pinned ?? seoulCalendar.format(hosted.now) : manifest.generator.end;
  const businessDate = hosted ? pinned ?? businessDateAt(hosted.now, content.store) : manifest.cutoff.businessDate;
  const { rows, summary: { config } } = generate(content, { ...manifest.generator, end, ...(hosted && { days: 90 }) });
  const cutoff = pinned ? new Date(`${pinned}T${manifest.cutoff.localTime}+09:00`).toISOString()
    : hosted?.now.toISOString() ?? manifest.cutoff.utc;
  return { rows, ...config, businessDate, cutoff, operatingHistory: true, archivedMenuIds: [] as string[] };
}

export type SeedContext = ReturnType<typeof createSeedContext>;

export function disposableReplaySeedContext(env: NodeJS.ProcessEnv = process.env): SeedContext | undefined {
  if (env.NAVIS_DISPOSABLE_REPLAY_SEED !== '1') return;
  const clock = disposableReplayClock(env);
  if (!clock) throw new Error('Replay seed requires an explicit disposable replay clock');
  return createSeedContext({ now: clock() });
}

const replayArchives = {
  'S8-176/1': { menuKey: 'm-coldbrew' },
  'S8-176/2': { menuKey: 'm-vanilla-latte' },
  'S8-176/3': { menuId: 'c105a6db-c3bf-5d19-ac78-903d680f5715', name: '휘낭시에', price: 3500 },
  'S8-176/4': { menuId: 'c5ff3692-e1aa-5c58-8822-b2236034f854', name: '크루아상', price: 4000 },
} as const;

type ReplayMenuRow = {
  store_id: string;
  menu_id: string;
  kind: string;
  category: string;
  name: string;
  price: number;
  sale_status: string;
  inventory_item_id: string | null;
  deleted_at: string | null;
};

/** One setup per fresh local database. The replay runner owns stack disposal. */
export function createReplaySeedContext({ instant, variant }: { instant: string; variant?: string }) {
  const now = parseSeedInstant(instant, 'Replay instant');
  const context = { ...createSeedContext({ now }), operatingHistory: false };
  if (!variant) return { ...context, now };

  if (!Object.hasOwn(replayArchives, variant)) throw new Error(`Unknown replay seed variant: ${variant}`);
  const archive = replayArchives[variant as keyof typeof replayArchives];
  const menuRows: ReplayMenuRow[] = context.rows.menu_item;
  const deletedAt = now.toISOString();
  if ('menuKey' in archive) {
    const menuId = seedCatalog.menu.find(menu => menu.menuId === archive.menuKey)?.dbId;
    const row = menuRows.find(menu => menu.menu_id === menuId);
    if (!row) throw new Error(`Missing seeded menu: ${archive.menuKey}`);
    row.deleted_at = deletedAt;
    context.archivedMenuIds.push(row.menu_id);
  } else {
    const store = context.rows.store[0] as { store_id: string };
    // Synthetic IDs are scoped to this archived row and never appear in the active POS catalog.
    menuRows.push({ store_id: store.store_id, menu_id: archive.menuId, kind: 'menu', category: 'dessert',
      name: archive.name, price: archive.price, sale_status: 'selling', inventory_item_id: null, deleted_at: deletedAt });
    context.archivedMenuIds.push(archive.menuId);
  }
  return { ...context, now };
}
