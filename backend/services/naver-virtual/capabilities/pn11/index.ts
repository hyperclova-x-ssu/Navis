import type { PersonaCapability } from '../../app.ts';
import type { CalendarCreated } from '../../../../packages/naver/contracts/pn11/index.ts';
import { digest, oauthAccess, registerOAuth } from './oauth.ts';
import { registerWorks } from './works.ts';

function eventUid(value: string) {
  const lines = value.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
  if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR' ||
      lines.filter((line) => line === 'BEGIN:VEVENT').length !== 1 ||
      lines.filter((line) => line === 'END:VEVENT').length !== 1) return;
  const start = lines.indexOf('BEGIN:VEVENT');
  const event = lines.slice(start + 1, lines.indexOf('END:VEVENT', start));
  for (const required of ['UID', 'DTSTAMP', 'DTSTART', 'SUMMARY']) {
    if (event.filter((line) => new RegExp(`^${required}(?:;[^:]*)?:.+$`).test(line)).length !== 1) return;
  }
  return event.find((line) => line.startsWith('UID:'))?.slice(4);
}

export const personaCapability: PersonaCapability = {
  id: 'pn11',
  migrations: [{
    id: 'pn11-calendar-001',
    up: `
      CREATE TABLE naver_virtual.pn11_oauth (
        account_id text NOT NULL, code_hash text NOT NULL, state_hash text, client_id text,
        scopes text[] NOT NULL, code_expires_at timestamptz, access_hash text, refresh_hash text, expires_at timestamptz,
        PRIMARY KEY (account_id, code_hash), UNIQUE (account_id, access_hash), UNIQUE (account_id, refresh_hash)
      );
      CREATE TABLE naver_virtual.pn11_calendar (
        account_id text NOT NULL, calendar_id text NOT NULL, uid text NOT NULL, fingerprint text NOT NULL,
        ical_uid text NOT NULL, schedule text NOT NULL,
        PRIMARY KEY (account_id, calendar_id, uid)
      );
      CREATE TABLE naver_virtual.pn11_works (
        account_id text NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL,
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, deleted_at timestamptz,
        PRIMARY KEY (account_id, event_id)
      );
      CREATE INDEX pn11_works_period ON naver_virtual.pn11_works (account_id, starts_at) WHERE deleted_at IS NULL;
      ALTER TABLE naver_virtual.pn11_oauth ENABLE ROW LEVEL SECURITY;
      ALTER TABLE naver_virtual.pn11_calendar ENABLE ROW LEVEL SECURITY;
      ALTER TABLE naver_virtual.pn11_works ENABLE ROW LEVEL SECURITY;
      CREATE POLICY account_scope ON naver_virtual.pn11_oauth
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      CREATE POLICY account_scope ON naver_virtual.pn11_calendar
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      CREATE POLICY account_scope ON naver_virtual.pn11_works
        USING (account_id = (SELECT current_setting('app.persona_account_id', true)));
      GRANT SELECT, INSERT, UPDATE, DELETE ON naver_virtual.pn11_oauth TO nvirtual_run;
      GRANT SELECT, INSERT ON naver_virtual.pn11_calendar TO nvirtual_run;
      GRANT SELECT, INSERT, UPDATE ON naver_virtual.pn11_works TO nvirtual_run;
    `,
    down: 'DROP TABLE naver_virtual.pn11_works, naver_virtual.pn11_calendar, naver_virtual.pn11_oauth;',
  }, {
    id: 'pn11-002-calendar-modify',
    up: 'GRANT UPDATE (fingerprint, schedule) ON naver_virtual.pn11_calendar TO nvirtual_run',
    down: 'REVOKE UPDATE (fingerprint, schedule) ON naver_virtual.pn11_calendar FROM nvirtual_run',
  }],
  async seed(client, { accountId, previousGeneration }) {
    if (previousGeneration) {
      await client.query('DELETE FROM naver_virtual.pn11_oauth WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn11_calendar WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn11_works WHERE account_id = $1', [accountId]);
    }
    await client.query(`
      INSERT INTO naver_virtual.pn11_oauth (account_id, code_hash, scopes, access_hash, expires_at)
      VALUES ($1, $2, ARRAY['cafe'], $2, 'infinity'::timestamptz)
      ON CONFLICT (account_id, code_hash) DO NOTHING
    `, [accountId, digest('fixture-cafe-write')]);
  },
  register(app, context) {
    registerWorks(app, context);
    app.register(async (forms) => {
      forms.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, payload, done) => {
        const parameters = new URLSearchParams(String(payload));
        const fields = new Set(parameters.keys());
        done(null, parameters.size === fields.size ? Object.fromEntries(parameters) : null);
      });
      registerOAuth(forms, context);
      // https://developers.naver.com/docs/login/calendar-api/calendar-api.md
      forms.post('/calendar/createSchedule.json', { config: { personaOperation: 'pn11.calendar.create' } }, async (request, reply) => {
        const access = await oauthAccess(request, context, 'calendar');
        if (access === 'missing' || access === 'invalid') {
          return reply.code(401).send({ errorCode: access === 'missing' ? '028' : '024',
            errorMessage: access === 'missing' ? 'Authentication header not exists' : 'Authentication failed' });
        }
        if (access === 'forbidden') return reply.code(403).send({ errorCode: '1403', errorMessage: '권한이 없습니다.' });
        const input = request.body as Record<string, unknown> | null;
        if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ||
            !input || Object.keys(input).length !== 2 || typeof input.calendarId !== 'string' ||
            typeof input.scheduleIcalString !== 'string') {
          return reply.code(400).send({ errorCode: '400', errorMessage: '잘못된 요청입니다.' });
        }
        if (!['fixture-calendar', 'defaultCalendarId'].includes(input.calendarId)) {
          return reply.code(404).send({ errorCode: '1404', errorMessage: '존재하지 않는 캘린더입니다.' });
        }
        const schedule = input.scheduleIcalString;
        const uid = eventUid(schedule);
        if (!uid || uid.length > 255) return reply.code(400).send({ errorCode: '400', errorMessage: '잘못된 요청입니다.' });
        const calendarId = 'fixture-calendar';
        const accountId = context.accountId(request);
        const fingerprint = digest(schedule);
        const icalUid = digest(`${accountId}:${calendarId}:${uid}`).slice(0, 24);
        const processType = await context.transaction(request, async (client) => {
          const inserted = await client.query(`
            INSERT INTO naver_virtual.pn11_calendar (account_id, calendar_id, uid, fingerprint, ical_uid, schedule)
            VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING
          `, [accountId, calendarId, uid, fingerprint, icalUid, schedule]);
          if (inserted.rowCount) return 'create';
          await client.query(`
            UPDATE naver_virtual.pn11_calendar SET fingerprint = $4, schedule = $5
            WHERE account_id = $1 AND calendar_id = $2 AND uid = $3
          `, [accountId, calendarId, uid, fingerprint, schedule]);
          return 'modify';
        });
        const response: CalendarCreated = { result: 'success', returnValue: {
          processType, calendarId, icalUid,
        } };
        return response;
      });
    });
  },
};
