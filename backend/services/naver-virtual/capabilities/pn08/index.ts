import type { PersonaCapability } from '../../app.ts';
import { calendarDate, record } from '../../../../packages/naver/contracts/pn01/wire.ts';
import { aiCallFixtureDispatchOperation, aiCallFixtureDispatchPath, smartCallPath } from '../../../../packages/naver/contracts/pn08/wire.ts';
import type { CallResult, SmartCallSummary } from '../../../../packages/naver/contracts/pn08/wire.ts';
import { deliverAiCallFixture } from './fixture.ts';

const scope = "(SELECT current_setting('app.persona_account_id', true))";
const tables = ['pn08_settings', 'pn08_call'];
const migration = {
  id: 'pn08_001_smartcall',
  up: `
    CREATE TABLE naver_virtual.pn08_settings (account_id text PRIMARY KEY, generation text NOT NULL, number_050 text NOT NULL);
    CREATE TABLE naver_virtual.pn08_call (
      account_id text NOT NULL, generation text NOT NULL, call_at timestamptz NOT NULL,
      result text NOT NULL CHECK (result IN ('connected','ars','missed','busy')),
      seconds integer CHECK (seconds > 0), channel text, PRIMARY KEY(account_id,call_at)
    );
    ${tables.map(table => `
      ALTER TABLE naver_virtual.${table} ENABLE ROW LEVEL SECURITY;
      CREATE POLICY pn08_account ON naver_virtual.${table} USING (account_id=${scope}) WITH CHECK (account_id=${scope});
      GRANT SELECT ON naver_virtual.${table} TO nvirtual_run;
    `).join('')}
  `,
  down: 'DROP TABLE naver_virtual.pn08_call, naver_virtual.pn08_settings;',
};
const callbackMigration = {
  id: 'pn08_002_aicall_fixture_dispatch',
  up: `
    CREATE TABLE naver_virtual.pn08_fixture_dispatch (
      account_id text NOT NULL, generation text NOT NULL, acknowledged boolean NOT NULL DEFAULT false,
      PRIMARY KEY (account_id, generation)
    );
    ALTER TABLE naver_virtual.pn08_fixture_dispatch ENABLE ROW LEVEL SECURITY;
    CREATE POLICY pn08_account ON naver_virtual.pn08_fixture_dispatch USING (account_id=${scope}) WITH CHECK (account_id=${scope});
    GRANT SELECT, INSERT, UPDATE ON naver_virtual.pn08_fixture_dispatch TO nvirtual_run;
  `,
  down: 'DROP TABLE naver_virtual.pn08_fixture_dispatch',
};

interface CallRow { call_at: Date; result: CallResult; seconds: number | null; channel: string | null }
const seoul = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short' });

function project(calls: CallRow[], startDate: string, endDate: string): SmartCallSummary {
  const days = new Map<string, CallRow[]>();
  const channels = new Map<string, number>();
  for (const call of calls) {
    const date = seoul.format(call.call_at);
    if (!days.has(date)) days.set(date, []);
    days.get(date)!.push(call);
    if (call.channel) channels.set(call.channel, (channels.get(call.channel) ?? 0) + 1);
  }
  const daily = [...days].map(([date, rows]) => {
    const connected = rows.filter(row => row.result === 'connected');
    const durations = connected.flatMap(row => row.seconds === null ? [] : [row.seconds]);
    return {
      date, totalCalls: rows.length, connectedCalls: connected.length,
      arsCalls: rows.filter(row => row.result === 'ars').length,
      missedCalls: rows.filter(row => row.result === 'missed').length,
      busyCalls: rows.filter(row => row.result === 'busy').length,
      averageDurationSeconds: durations.length ? Math.round(durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length) : null,
      callsAtLeastTenSeconds: durations.filter(seconds => seconds >= 10).length,
    };
  });
  return { period: { startDate, endDate },
    channels: [...channels].sort((left, right) => right[1] - left[1]).map(([channel]) => channel), daily };
}

export const personaCapability: PersonaCapability = {
  id: 'pn08', migrations: [migration, callbackMigration],
  async seed(client, { accountId, generation, now }) {
    for (const table of tables) await client.query(`DELETE FROM naver_virtual.${table} WHERE account_id=$1 AND generation<>$2`, [accountId, generation]);
    await client.query('INSERT INTO naver_virtual.pn08_settings VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [accountId, generation, '0507-0000-0000']);
    const observations = [
      [44, 'connected', 42, '네이버 지도'],
      [82, 'missed', null, '네이버 검색'],
      [156, 'ars', 13, '네이버 지도'],
      [990, 'busy', null, '네이버 검색'],
    ] as const;
    for (const [minutesAgo, result, seconds, channel] of observations) {
      const callAt = new Date(now.getTime() - minutesAgo * 60_000);
      await client.query('INSERT INTO naver_virtual.pn08_call VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
        [accountId, generation, callAt, result, seconds, channel]);
    }
  },
  register(app, context) {
    app.post(aiCallFixtureDispatchPath, { config: { personaOperation: aiCallFixtureDispatchOperation } }, async (request, reply) => {
      if (!record(request.query) || Object.keys(request.query).length ||
          (request.body !== undefined && (!record(request.body) || Object.keys(request.body).length))) {
        return reply.code(400).send();
      }
      const token = context.providerCredential(request, 'aicallCallbackToken');
      if (!token) return reply.code(503).send();
      const accountId = context.accountId(request);
      const { rows: [claim] } = await context.transaction(request, async client => {
        const result = await client.query<{ generation: string }>(`
          INSERT INTO naver_virtual.pn08_fixture_dispatch (account_id, generation)
          SELECT account_id, generation FROM naver_virtual.pn08_settings WHERE account_id = $1
          ON CONFLICT DO NOTHING RETURNING generation
        `, [accountId]);
        return result;
      });
      if (!claim) {
        const { rows: [prior] } = await context.transaction(request, client => client.query<{ acknowledged: boolean }>(`
          SELECT dispatch.acknowledged FROM naver_virtual.pn08_fixture_dispatch AS dispatch
          JOIN naver_virtual.pn08_settings AS settings USING (account_id, generation)
          WHERE dispatch.account_id = $1
        `, [accountId]));
        return reply.code(prior ? (prior.acknowledged ? 204 : 202) : 404).send();
      }
      try {
        await deliverAiCallFixture(context.callback, new Date(claim.generation), token);
      } catch {
        // The customer may have received the callback before a response was lost.
        return reply.code(202).send();
      }
      await context.transaction(request, client => client.query(`
        UPDATE naver_virtual.pn08_fixture_dispatch SET acknowledged = true WHERE account_id = $1 AND generation = $2
      `, [accountId, claim.generation]));
      return reply.code(204).send();
    });

    // 050 number: https://help.naver.com/service/30026/contents/20471?lang=ko
    app.get(smartCallPath + '/settings', { config: { personaOperation: 'pn08.smartcall.settings' } }, async (request, reply) => {
      if (!record(request.query) || Object.keys(request.query).length) return reply.code(400).send({ code: 'INVALID_REQUEST' });
      const settings = await context.transaction(request, async client => {
        const { rows } = await client.query<{ number050: string }>(
          'SELECT number_050 AS "number050" FROM naver_virtual.pn08_settings WHERE account_id=$1', [context.accountId(request)]);
        return rows[0];
      });
      return settings ?? reply.code(404).send({ code: 'NOT_FOUND' });
    });
    // Owner summary and daily views: https://help.naver.com/service/30026/contents/20474?lang=ko&osType=COMMONOS
    app.get(smartCallPath + '/calls', { config: { personaOperation: 'pn08.smartcall.calls' } }, async (request, reply) => {
      const query = request.query;
      if (!record(query) || Object.keys(query).some(key => key !== 'startDate' && key !== 'endDate')
        || !calendarDate(query.startDate) || !calendarDate(query.endDate) || query.startDate > query.endDate) {
        return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      const { startDate, endDate } = query;
      return context.transaction(request, async client => {
        const { rows } = await client.query<CallRow>(`
          SELECT call_at,result,seconds,channel FROM naver_virtual.pn08_call
          WHERE account_id=$1 AND call_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Seoul')
          AND call_at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')
          ORDER BY call_at
        `, [context.accountId(request), startDate, endDate]);
        return project(rows, startDate, endDate);
      });
    });
  },
};
