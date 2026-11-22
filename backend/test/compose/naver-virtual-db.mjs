import assert from 'node:assert/strict';
import { Client } from 'pg';
import { dbConfig, readSecret, services } from '../../packages/db/index.ts';

const host = process.env.NAVIS_DB_HOST ?? 'test-db';
const database = 'naver_virtual';

async function connect(config, inspect) {
  const client = new Client(config);
  try {
    await client.connect();
    return await inspect(client);
  } finally {
    await client.end();
  }
}

for (const user of ['nvirtual_run', 'nvirtual_mig']) {
  const config = { user, host, database, password: readSecret(`/run/navis-test-db/${user}_password`), connectionTimeoutMillis: 2000 };
  await connect(config, async client => {
    const { rows } = await client.query(`
      SELECT current_user AS role, current_database() AS database, current_schema() AS schema,
        pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = current_schema()
    `);
    assert.deepEqual(rows, [{ role: user, database, schema: database, owner: 'nvirtual_mig' }]);
    const probe = 'CREATE TABLE naver_virtual.compose_persona_privilege_probe (id integer PRIMARY KEY)';
    if (user === 'nvirtual_run') {
      await assert.rejects(client.query(probe), { code: '42501' });
      await assert.rejects(client.query('SET ROLE nvirtual_mig'), { code: '42501' });
    } else {
      await client.query('BEGIN');
      await client.query(probe);
      await client.query('ROLLBACK');
    }
    const extension = await client.query(`
      SELECT nspname AS schema FROM pg_extension JOIN pg_namespace ON extnamespace = pg_namespace.oid WHERE extname = 'pgcrypto'
    `);
    assert.deepEqual(extension.rows, [{ schema: database }]);
  });
  for (const foreignDatabase of [...services, 'postgres', 'template1']) {
    await assert.rejects(connect({ ...config, database: foreignDatabase }, () => {}), { code: '42501' });
  }
}

for (const service of services) {
  for (const role of ['migrate', 'runtime']) {
    await assert.rejects(connect({ ...dbConfig(service, role, 'test'), database }, () => {}), { code: '42501' });
  }
}
console.info('PASS Persona migration and runtime roles are isolated in both directions; pgcrypto is available in the Persona schema');
