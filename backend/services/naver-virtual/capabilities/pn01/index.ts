import { createHash } from 'node:crypto';
import content from '../../../../../db/seed/ansungjalbu/content.json' with { type: 'json' };
import type { PersonaCapability } from '../../app.ts';
import { menuPatch, placePath, record, validHours, venuePatch, weekdays } from '../../../../packages/naver/contracts/pn01/wire.ts';
import type { MenuItem, PlaceHours, Venue } from '../../../../packages/naver/contracts/pn01/wire.ts';

const columns = ['venue', 'menu', 'hours'] as const;
type Projection = Venue | PlaceHours | MenuItem[];
const scope = "(SELECT current_setting('app.persona_account_id', true))";
const migration = {
  id: 'pn01_001_place',
  up: `
    CREATE TABLE naver_virtual.pn01_place (
      account_id text PRIMARY KEY,
      generation text NOT NULL,
      venue jsonb NOT NULL,
      menu jsonb NOT NULL,
      hours jsonb NOT NULL
    );
    ALTER TABLE naver_virtual.pn01_place ENABLE ROW LEVEL SECURITY;
    CREATE POLICY pn01_account ON naver_virtual.pn01_place USING (account_id = ${scope}) WITH CHECK (account_id = ${scope});
    GRANT SELECT, UPDATE ON naver_virtual.pn01_place TO nvirtual_run;
  `,
  down: 'DROP TABLE naver_virtual.pn01_place;',
};

const invalid = { code: 'INVALID_REQUEST' };
const notFound = { code: 'NOT_FOUND' };
class PlaceProblem extends Error {
  readonly statusCode = 404;

}

export const personaCapability: PersonaCapability = {
  id: 'pn01',
  migrations: [migration],
  async seed(client, { accountId, generation, cafe }) {
    const venue: Venue = {
      name: content.store.name, address: content.store.area.split(' (')[0],
      keywords: ['카페', '커피', '소금빵'], phone: '02-0000-0000',
      photos: ['cafe-storefront', 'cafe-interior-01', 'cafe-interior-02'],
    };
    const menu = cafe.rows.menu_item.map(({ name, price }) => ({ name, price }));
    const hours: PlaceHours = {
      businessHours: weekdays.map(day => ({ day, open: content.store.hours[day][0], close: content.store.hours[day][1] })),
      holidayHours: [],
    };
    await client.query(`
      INSERT INTO naver_virtual.pn01_place(account_id,generation,venue,menu,hours) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT(account_id) DO UPDATE SET generation=EXCLUDED.generation, venue=EXCLUDED.venue,
      menu=EXCLUDED.menu, hours=EXCLUDED.hours WHERE pn01_place.generation<>EXCLUDED.generation
    `, [accountId, generation, JSON.stringify(venue), JSON.stringify(menu), JSON.stringify(hours)]);
  },
  register(app, context) {
    for (const column of columns) {
      const url = column === 'venue' ? placePath : `${placePath}/${column}`;
      const operation = column === 'venue' ? 'place' : column;
      // Owner details and photos: https://help.naver.com/service/30026/contents/20366?lang=ko
      // Menu and operations: https://new.smartplace.naver.com/introduction/solution-market/payNPos
      // Owner hours: https://help.naver.com/service/30026/contents/20380?osType=MOBILE
      app.get(url, { config: { personaOperation: `pn01.${operation}.read` } }, async (request, reply) => {
        if (!record(request.query) || Object.keys(request.query).length) return reply.code(400).send(invalid);
        const result = await context.transaction(request, async client => {
          const { rows } = await client.query<{ projection: Projection }>(`
            SELECT ${column} AS projection FROM naver_virtual.pn01_place WHERE account_id=$1
          `, [context.accountId(request)]);
          return rows[0]?.projection;
        });
        return result ?? reply.code(404).send(notFound);
      });
      // Scoped owner edit and saved owner read-back. Search visibility is not part of this contract.
      // https://help.naver.com/service/30026/contents/20379?lang=ko
      // https://help.naver.com/service/30026/contents/20394?lang=ko
      app.patch(url, {
        config: { personaOperation: `pn01.${operation}.update` },
        errorHandler(error, _request, reply) {
          if (!(error instanceof PlaceProblem)) throw error;
          return reply.code(error.statusCode).send(notFound);
        },
      }, async (request, reply) => {
        const patch = request.body;
        const query = request.query;
        if (!record(query) || Object.keys(query).some(key => column !== 'menu' || key !== 'name')
          || ('name' in query && (typeof query.name !== 'string' || !query.name.trim() || query.name.length > 100))) {
          return reply.code(400).send(invalid);
        }
        const key = typeof query.name === 'string' ? query.name : undefined;
        if (!(column === 'venue' ? venuePatch(patch) : column === 'menu' ? menuPatch(patch) : validHours(patch))) {
          return reply.code(400).send(invalid);
        }
        const changes = patch as Partial<Venue & PlaceHours & MenuItem>;
        if (column === 'menu' && key === undefined && (changes.name === undefined || changes.price === undefined)) {
          return reply.code(400).send(invalid);
        }
        const accountId = context.accountId(request);
        const fingerprint = createHash('sha256').update(JSON.stringify([key, Object.entries(changes).sort()])).digest('hex');
        await context.effect(request, fingerprint, async client => {
          const { rows } = await client.query<{ projection: Projection }>(`
            SELECT ${column} AS projection FROM naver_virtual.pn01_place WHERE account_id=$1 FOR UPDATE
          `, [accountId]);
          const previous = rows[0]?.projection;
          if (previous === undefined) return null;
          let next: Projection;
          if (Array.isArray(previous)) {
            const existing = previous.find(item => item.name === (key ?? changes.name));
            if (key !== undefined && !existing) throw new PlaceProblem();
            next = existing
              ? previous.map(item => item === existing ? { ...item, ...changes } : item)
              : [...previous, { name: changes.name!, price: changes.price! }];
          } else if ('businessHours' in previous) {
            const changedDays = new Map(changes.businessHours?.map(entry => [entry.day, entry]));
            const businessHours = previous.businessHours.map(entry => changedDays.get(entry.day) ?? entry);
            next = { ...previous, ...changes, businessHours };
          } else {
            // The account adapter authorizes ownership and rights of uploaded photo selectors before publication.
            next = { ...previous, ...changes };
          }
          await client.query(`UPDATE naver_virtual.pn01_place SET ${column}=$2 WHERE account_id=$1`, [accountId, JSON.stringify(next)]);
          return column;
        });
        const projection = await context.transaction(request, async client => {
          const { rows } = await client.query<{ projection: Projection }>(`
            SELECT ${column} AS projection FROM naver_virtual.pn01_place WHERE account_id=$1
          `, [accountId]);
          return rows[0]?.projection;
        });
        return projection ?? reply.code(404).send(notFound);
      });
    }
  },
};
