import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { integer, object, text } from '../../account/naver/wire.ts';

type Candidate = { storeId: string; dedupeKey: string; usageAt: string; partySize: number; contact?: string };
type Options = {
  authenticate: (request: FastifyRequest) => Promise<{ storeId: string; retainContact?: boolean } | undefined>;
  upsertCandidate: (candidate: Candidate) => Promise<void>;
};

// https://guide.ncloud-docs.com/docs/chatbot-chatbot-2-3 and https://guide.ncloud-docs.com/docs/clovaaicall-aicall-1-9
export function registerAiCallCallback(app: FastifyInstance, options: Options) {
  app.post('/internal/naver-virtual/aicall/custom-condition/v2', { bodyLimit: 16_384, logLevel: 'silent' }, async (req, reply) => {
    const scope = await options.authenticate(req);
    if (!scope) return reply.code(403).send({ code: 'STORE_FORBIDDEN' });
    let candidate: Candidate;
    try {
      const payload = object(req.body);
      const userId = text(payload.userId);
      const userKey = text(payload.userKey);
      const variables = object(payload.userVariables);
      const read = (key: string, typ: string) => {
        const row = object(variables[key]);
        if (row.typ !== typ) throw new Error();
        return text(row.value);
      };
      const date = object(JSON.parse(read('예약날짜_completed', 'JSON')));
      const time = object(JSON.parse(read('예약시간_completed', 'JSON')));
      const year = integer(date.year);
      const month = integer(date.month);
      const day = integer(date.day);
      const hour = integer(time.hour);
      const minute = integer(time.minute);
      const party = read('예약인원_completed', 'NUMBER');
      const partySize = Number(party);
      const contact = scope.retainContact && variables.전화번호_completed !== undefined
        ? read('전화번호_completed', 'TEXT') : undefined;
      const pad = (n: number) => String(n).padStart(2, '0');
      const dayString = [year, pad(month), pad(day)].join('-');
      const dt = new Date(dayString + 'T00:00:00Z');
      if (year < 2000 || year > 9999 || !Number.isFinite(+dt) || dt.toISOString().slice(0, 10) !== dayString
        || hour < 0 || hour > 23 || minute < 0 || minute > 59 || !/^[1-9]\d*$/.test(party)
        || partySize > 30 || !userId || !userKey || (contact !== undefined && !/^\d{9,11}$/.test(contact))) throw new Error();
      const usageAt = dayString + 'T' + pad(hour) + ':' + pad(minute) + ':00+09:00';
      candidate = {
        storeId: scope.storeId, usageAt, partySize, ...(contact && { contact }),
        dedupeKey: createHash('sha256').update(JSON.stringify([scope.storeId, userId, userKey, usageAt, partySize])).digest('hex'),
      };
    } catch {
      return reply.code(400).send({ valid: 'reservationFailed' });
    }
    await options.upsertCandidate(candidate);
    return { valid: 'reservationFailed' };
  });
}
