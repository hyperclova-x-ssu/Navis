import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { dbConfig, services, type DbRole } from './index.ts';

describe.each(services)('%s database', (service) => {
  it.each(['runtime', 'migrate'] satisfies DbRole[])(
    'allows the %s role only into its own database',
    async (role) => {
      const config = dbConfig(service, role, 'test');
      const owner = new Client(config);
      await owner.connect();
      try {
        const { rows } = await owner.query('SELECT current_database() AS db, current_user AS role');
        expect(rows).toEqual([{ db: service, role: `${service}_${role}` }]);
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
        `SET ROLE ${service}_migrate`,
      ]) {
        await expect(runtime.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      }
    } finally {
      await Promise.all([runtime.end(), migrate.end()]);
    }
  });
});
