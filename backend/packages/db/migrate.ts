import { runner } from 'node-pg-migrate';
import { dbConfig, type DbMode, type Service } from './index.ts';

export async function runMigrations(
  service: Service,
  dir: string,
  mode: DbMode = 'local',
  direction: 'up' | 'down' = 'up',
): Promise<void> {
  await runner({
    databaseUrl: dbConfig(service, 'migrate', mode),
    dir,
    schema: service,
    migrationsSchema: service,
    migrationsTable: 'schema_migrations',
    direction,
    verbose: false,
    log: (message) => process.stdout.write(`[${service}] ${message}\n`),
  });
}
