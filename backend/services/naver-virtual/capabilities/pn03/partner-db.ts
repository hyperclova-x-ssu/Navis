import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { partnerPrefix } from '../../../../packages/naver/contracts/pn03/partner.ts';

export function registerPartnerErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof Error && 'statusCode' in error && request.routeOptions.url?.startsWith(partnerPrefix)) {
      const status = error.statusCode;
      if (status === 404) return reply.code(status).send({ code: 'NOT_FOUND' });
      if (status === 409 && !('code' in error)) return reply.code(status).send({ code: 'CONFLICT' });
    }
    throw error;
  });
}

// Capability migrations supply static table and privilege names. Runtime values are bound separately.
export function scoped(table: string, privileges: string) {
  return `
    ALTER TABLE naver_virtual.${table} ENABLE ROW LEVEL SECURITY;
    ALTER TABLE naver_virtual.${table} FORCE ROW LEVEL SECURITY;
    CREATE POLICY account_scope ON naver_virtual.${table}
      USING (account_id = (SELECT current_setting('app.persona_account_id', true)))
      WITH CHECK (account_id = (SELECT current_setting('app.persona_account_id', true)));
    GRANT ${privileges} ON naver_virtual.${table} TO nvirtual_run;
  `;
}

export async function lockAccount(client: PoolClient, domain: string, accountId: string) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [domain, accountId]);
}
