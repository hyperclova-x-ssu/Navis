import type { PersonaCapability } from '../../app.ts';
import type { Consultation, TalkTalkEvent } from '../../../../packages/naver/contracts/pn06/index.ts';
import { talkTalkConsultationTabs } from '../../../../packages/naver/contracts/pn06/index.ts';
import {
  day, fields, kstDay, oneOf, page, partnerError, partnerPrefix, ref, shiftDay,
} from '../../../../packages/naver/contracts/pn03/partner.ts';
import { registerPartnerErrors, scoped } from '../pn03/partner-db.ts';
import { registerChatbot } from './chatbot.ts';

type Row = { ref: string; status: Consultation['status']; messages: Consultation['messages'] };
const path = `${partnerPrefix}/talktalk/consultations`;

function project(row: Row): Consultation {
  return { ref: row.ref, status: row.status, messages: row.messages.map(({ text }) => ({ text })) };
}

export const personaCapability: PersonaCapability = {
  id: 'pn06',
  migrations: [{
    id: '20261123000600_pn06_talktalk',
    up: `
      CREATE TABLE naver_virtual.pn06_consultations (
        account_id text NOT NULL, ref text NOT NULL, wire_user text NOT NULL,
        status text NOT NULL CHECK (status IN ('waiting','in-progress','on-hold','completed','blocked','spam')),
        messages jsonb NOT NULL, activity_on date NOT NULL, retained boolean NOT NULL,
        PRIMARY KEY (account_id, ref), UNIQUE (account_id, wire_user)
      );
      CREATE INDEX pn06_consultation_view ON naver_virtual.pn06_consultations (account_id, activity_on DESC, ref) WHERE retained;
      CREATE TABLE naver_virtual.pn06_webhook_settings (
        account_id text PRIMARY KEY, partner text NOT NULL, inbound_enabled boolean NOT NULL, echo_enabled boolean NOT NULL
      );
      CREATE TABLE naver_virtual.pn06_webhook_events (
        account_id text NOT NULL, ref text NOT NULL, payload jsonb NOT NULL,
        state text NOT NULL CHECK (state IN ('pending','sending','acknowledged','uncertain')),
        PRIMARY KEY (account_id, ref)
      );
      ${scoped('pn06_consultations', 'SELECT')}
      ${scoped('pn06_webhook_settings', 'SELECT')}
      ${scoped('pn06_webhook_events', 'SELECT, INSERT, UPDATE (state)')}
    `,
    down: 'DROP TABLE naver_virtual.pn06_webhook_events, naver_virtual.pn06_webhook_settings, naver_virtual.pn06_consultations',
  }],
  async seed(client, { accountId, now, previousGeneration }) {
    if (previousGeneration) {
      await client.query('DELETE FROM naver_virtual.pn06_webhook_events WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn06_webhook_settings WHERE account_id = $1', [accountId]);
      await client.query('DELETE FROM naver_virtual.pn06_consultations WHERE account_id = $1', [accountId]);
    }
    const today = kstDay(now);
    const inbound: TalkTalkEvent = {
      event: 'send', user: 'al-cafe-fixture-01', textContent: { text: '오늘 창가 자리가 있나요?', inputType: 'typing' },
    };
    await client.query(`
      INSERT INTO naver_virtual.pn06_consultations VALUES
        ($1,'consultation-01',$2,'waiting',$3,$4,true),
        ($1,'consultation-02','al-cafe-fixture-02','completed',$5,$6,true),
        ($1,'consultation-hidden','al-cafe-hidden','completed','[]',$6,false)
      ON CONFLICT DO NOTHING
    `, [accountId, inbound.user, JSON.stringify([{ text: inbound.textContent.text }]), today,
      JSON.stringify([{ text: '드립커피도 포장할 수 있나요?' }, { text: '네, 주문하실 때 말씀해 주세요.' }]), shiftDay(today, -20)]);
    await client.query("INSERT INTO naver_virtual.pn06_webhook_settings VALUES ($1,'cafe01',true,true) ON CONFLICT DO NOTHING",
      [accountId]);
    await client.query("INSERT INTO naver_virtual.pn06_webhook_events VALUES ($1,'inbound-01',$2,'pending') ON CONFLICT DO NOTHING",
      [accountId, inbound]);
  },
  register(app, context) {
    registerPartnerErrors(app);
    // TalkTalk partner conversation 3614, period 23823 and consultation tabs 24283.
    app.get(path, { config: { personaOperation: 'pn06.consultations.list' } }, (request) => {
      const query = fields(request.query, [], ['status', 'from', 'to', 'limit', 'offset']);
      const status = query.status === undefined || query.status === 'all' ? null : oneOf(query.status, talkTalkConsultationTabs);
      const from = query.from === undefined ? null : day(query.from);
      const to = query.to === undefined ? null : day(query.to);
      if (from && to && from > to) partnerError(400, '조회 기간을 확인해 주세요.');
      const [limit, offset] = page(query);
      return context.transaction(request, async (client) => {
        const { rows } = await client.query<Row>(`
          SELECT ref, status, messages FROM naver_virtual.pn06_consultations WHERE account_id = $1 AND retained
            AND ($2::text IS NULL OR status = $2) AND ($3::date IS NULL OR activity_on >= $3)
            AND ($4::date IS NULL OR activity_on <= $4)
          ORDER BY activity_on DESC, ref LIMIT $5 OFFSET $6
        `, [context.accountId(request), status, from, to, limit, offset]);
        return { items: rows.map(project) };
      });
    });

    // Owner-visible conversation (3614). Exact partner text field schema is unconfirmed.
    app.get<{ Params: { ref: string } }>(`${path}/:ref`, { config: { personaOperation: 'pn06.consultations.get' } }, (request) => {
      fields(request.query, []);
      const consultationRef = ref(request.params.ref);
      return context.transaction(request, async (client) => {
        const { rows: [row] } = await client.query<Row>(`
          SELECT ref, status, messages FROM naver_virtual.pn06_consultations WHERE account_id = $1 AND ref = $2 AND retained
        `, [context.accountId(request), consultationRef]);
        if (!row) partnerError(404, '확인할 수 있는 상담을 찾을 수 없어요.');
        return project(row);
      });
    });
    registerChatbot(app, context);
  },
};
