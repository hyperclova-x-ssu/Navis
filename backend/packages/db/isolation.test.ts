import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { dbConfig, dbRoleName, services } from './index.ts';

it('derives distinct NCP-compatible login names for all deployed roles', () => {
  const names = services.flatMap(service => [
    dbRoleName(service, 'migrate'), dbRoleName(service, 'runtime'),
    ...(service === 'account' ? [] : [dbRoleName(service, 'relay')]),
  ]).concat(dbRoleName('inventory', 'worker'), dbRoleName('marketing', 'worker'), dbRoleName('pos', 'worker'));
  expect(new Set(names).size).toBe(20);
  expect(names.every(name => /^[a-z][a-z0-9_]{3,15}$/.test(name))).toBe(true);
  expect(names).toContain('marketing_wrk');
  expect(names).toContain('inventory_rly');
  expect(names).toContain('inventory_wrk');
  expect(names).toContain('pos_wrk');
});

it.each(['inventory', 'pos'] as const)('connects the %s worker only to its database with no inherited runtime grants', async (service) => {
  const config = dbConfig(service, 'worker', 'test');
  const worker = new Client(config);
  await worker.connect();
  try {
    const { rows } = await worker.query(
      'SELECT current_user AS role, pg_has_role(current_user, $1, $2) AS inherits',
      [`${service}_run`, 'MEMBER'],
    );
    expect(rows).toEqual([{ role: `${service}_wrk`, inherits: false }]);
    for (const database of [...services.filter(name => name !== service), 'postgres', 'template1']) {
      const other = new Client({ ...config, database });
      try {
        await expect(other.connect(), database).rejects.toMatchObject({ code: '42501' });
      } finally {
        await other.end();
      }
    }
  } finally {
    await worker.end();
  }
});

describe.each(services)('%s database', (service) => {
  it.each([['runtime', 'run'], ['migrate', 'mig']] as const)(
    'allows the %s role (%s) only into its own database',
    async (role, suffix) => {
      const config = dbConfig(service, role, 'test');
      const owner = new Client(config);
      await owner.connect();
      try {
        const { rows } = await owner.query('SELECT current_database() AS db, current_user AS role');
        expect(rows).toEqual([{ db: service, role: `${service}_${suffix}` }]);
      } finally {
        await owner.end();
      }

      const otherDatabases = [
        ...services.filter((other) => other !== service), 'postgres', 'template1',
      ];
      for (const database of otherDatabases) {
        const other = new Client({ ...config, database });
        try {
          await expect(other.connect(), database).rejects.toMatchObject({ code: '42501' });
        } finally {
          await other.end();
        }
      }
    },
  );

  it('restricts runtime DDL and role membership while allowing migration DDL', async () => {
    const runtime = new Client(dbConfig(service, 'runtime', 'test'));
    const migrate = new Client(dbConfig(service, 'migrate', 'test'));
    try {
      await runtime.connect();
      await migrate.connect();
      await migrate.query('BEGIN');
      await migrate.query(`CREATE TABLE ${service}.t302_privilege_probe (id integer PRIMARY KEY)`);
      await migrate.query('ROLLBACK');

      const { rows } = await runtime.query(
        'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user',
      );
      expect(rows).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }]);
      for (const sql of [
        `CREATE TABLE ${service}.t302_privilege_probe (id integer)`,
        'CREATE TABLE public.t302_privilege_probe (id integer)',
        'CREATE SCHEMA t302_privilege_probe',
        'CREATE TEMP TABLE t302_privilege_probe (id integer)',
        `SET ROLE ${service}_mig`,
      ]) {
        await expect(runtime.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await Promise.all([runtime.end(), migrate.end()]);
    }
  });
});
