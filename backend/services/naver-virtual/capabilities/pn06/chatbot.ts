import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { PersonaContext } from '../../app.ts';
import { talkTalkReplyPath, type TalkTalkEvent, type TalkTalkReply, type TalkTalkResult } from '../../../../packages/naver/contracts/pn06/index.ts';
import { fields, fingerprint, ref } from '../../../../packages/naver/contracts/pn03/partner.ts';

const fixturePath = '/internal/naver-virtual/v1/talktalk/webhook-fixtures/:ref/dispatch';
const digest = (value: string) => createHash('sha256').update(value).digest();
const contentType = 'application/json;charset=UTF-8';
const failures = {
  '01': 'Authorization 정보 오류',
  '02': 'request json 문자열 파싱 오류',
  '99': '메시지를 처리할 수 없습니다.',
} as const;

function failure(resultCode: keyof typeof failures): TalkTalkResult {
  return { success: false, resultCode, resultMessage: failures[resultCode] };
}

function parseReply(value: unknown): TalkTalkReply | undefined {
  try {
    if (typeof value !== 'string') return;
    const body = fields(JSON.parse(value), ['event', 'user', 'textContent'], ['options']);
    if (body.event !== 'send' || typeof body.user !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.user)) return;
    const { text } = fields(body.textContent, ['text']);
    if (typeof text !== 'string' || text.trim() === '' || text.includes('\0') || Array.from(text).length > 10000) return;
    if (body.options !== undefined) {
      if (fields(body.options, ['notification']).notification !== false) return;
      return { event: 'send', user: body.user, textContent: { text }, options: { notification: false } };
    }
    return { event: 'send', user: body.user, textContent: { text } };
  } catch (error) {
    if (error instanceof SyntaxError || (error as { statusCode?: number }).statusCode === 400) return;
    throw error;
  }
}

type WebhookRow = { state: 'pending' | 'sending' | 'acknowledged' | 'uncertain'; payload: TalkTalkEvent };
type DispatchResult = 'acknowledged' | 'pending' | 'missing';

async function dispatch(context: PersonaContext, request: FastifyRequest, eventRef: string): Promise<DispatchResult> {
  const callbackToken = context.providerCredential(request, 'talktalkCallbackToken');
  if (!callbackToken) return 'pending';
  const account = context.accountId(request);
  const claim = await context.transaction(request, async (client) => {
    const { rows: [work] } = await client.query<WebhookRow>(`
      UPDATE naver_virtual.pn06_webhook_events AS events SET state = 'sending'
      FROM naver_virtual.pn06_webhook_settings AS settings
      WHERE events.account_id = $1 AND events.ref = $2 AND events.state = 'pending' AND settings.account_id = events.account_id
      AND CASE events.payload->>'event' WHEN 'send' THEN settings.inbound_enabled WHEN 'echo' THEN settings.echo_enabled ELSE false END
      RETURNING events.state, events.payload
    `, [account, eventRef]);
    if (work) return { work };
    const { rows: [existing] } = await client.query<Pick<WebhookRow, 'state'>>(
      'SELECT state FROM naver_virtual.pn06_webhook_events WHERE account_id = $1 AND ref = $2', [account, eventRef],
    );
    return { state: existing?.state };
  });
  if (!claim.work) {
    if (!claim.state) return 'missing';
    return claim.state === 'acknowledged' ? 'acknowledged' : 'pending';
  }

  let state: 'acknowledged' | 'uncertain' = 'uncertain';
  try {
    const response = await context.callback('talktalk', {
      headers: { accept: 'application/json', 'content-type': contentType, authorization: `Bearer ${callbackToken}` },
      body: JSON.stringify(claim.work.payload),
      signal: AbortSignal.timeout(1000),
    });
    if (response.ok) state = 'acknowledged';
    if (response.body) await response.body.cancel();
  } catch {
    // The published event has no unique message ID. An unknown outcome cannot safely trigger another delivery.
  }
  await context.transaction(request, async (client) => {
    await client.query("UPDATE naver_virtual.pn06_webhook_events SET state = $3 WHERE account_id = $1 AND ref = $2 AND state = 'sending'",
      [account, eventRef, state]);
  });
  return state === 'acknowledged' ? state : 'pending';
}

async function acceptReply(client: PoolClient, account: string, input: TalkTalkReply) {
  const { rows: [row] } = await client.query<{ partner: string; echo_enabled: boolean }>(`
    SELECT config.partner, config.echo_enabled
    FROM naver_virtual.pn06_consultations AS chat JOIN naver_virtual.pn06_webhook_settings AS config USING (account_id)
    WHERE chat.account_id = $1 AND chat.wire_user = $2 AND chat.retained AND chat.status NOT IN ('blocked','spam')
  `, [account, input.user]);
  if (!row) throw new UnknownTalkTalkUser();
  const eventRef = randomUUID();
  const payload: TalkTalkEvent = {
    event: 'echo', echoedEvent: 'send', user: input.user, partner: row.partner, textContent: { text: input.textContent.text },
  };
  await client.query(`
    INSERT INTO naver_virtual.pn06_webhook_events (account_id, ref, payload, state) VALUES ($1,$2,$3,$4)
  `, [account, eventRef, payload, row.echo_enabled ? 'pending' : 'acknowledged']);
  return eventRef;
}

class UnknownTalkTalkUser extends Error {}

export function registerChatbot(app: FastifyInstance, context: PersonaContext) {
  app.register(async (wire) => {
    // The official Chat Bot API V1 returns HTTP 200 with resultCode 02 for invalid JSON.
    wire.removeContentTypeParser('application/json');
    wire.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 128 * 1024 }, (_request, body, done) => done(null, body));
    wire.post(talkTalkReplyPath, { config: { personaOperation: 'pn06.chatbot.send' } }, async (request, reply) => {
      reply.type(contentType);
      const token = context.providerCredential(request, 'talktalkAuthorization');
      const authorization = request.headers.authorization;
      if (!token || typeof authorization !== 'string' || !timingSafeEqual(digest(token), digest(authorization))) return failure('01');
      const input = parseReply(request.body);
      if (!input || Object.keys(request.query as object).length > 0) return failure('02');
      const account = context.accountId(request);
      const save = (client: PoolClient) => acceptReply(client, account, input);
      let eventRef: string;
      try {
        if (request.headers['idempotency-key'] === undefined) {
          eventRef = await context.transaction(request, save);
        } else {
          // The private workload can bind one Navis attempt separately from the official body.
          eventRef = (await context.effect(request, fingerprint(input), save)).ref;
        }
      } catch (error) {
        if (error instanceof UnknownTalkTalkUser || [400, 409].includes((error as { statusCode?: number }).statusCode ?? 0)) {
          return failure('99');
        }
        throw error;
      }
      try {
        await dispatch(context, request, eventRef);
      } catch {
        // The reply was accepted before attempting its separately settings-gated echo.
      }
      return { success: true, resultCode: '00' } satisfies TalkTalkResult;
    });
  });

  // Internal fixture transport for the published TalkTalk Chat Bot API V1 webhook send and echo events.
  app.post<{ Params: { ref: string } }>(fixturePath, {
    config: { personaOperation: 'pn06.fixture.dispatch' },
  }, async (request, reply) => {
    fields(request.query, []);
    if (request.body !== undefined) fields(request.body, []);
    const result = await dispatch(context, request, ref(request.params.ref));
    return reply.code(result === 'missing' ? 404 : result === 'pending' ? 202 : 204).send();
  });
}
