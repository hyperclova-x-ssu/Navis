import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { personaPool, personaTransaction } from '../../services/naver-virtual/db.ts';

const scheduledFor = '2026-11-18T08:00';
const marketing = '/marketing';
const retainedNumber = '01000000981';
const revokedNumber = '01000000982';
const noticePath = id => `${marketing}/notices/${id}`;
const calendarPath = '/calendar/projections?startDate=2026-11-18&endDate=2026-11-19';

async function waitFor(read, description) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await read();
    if (value) return value;
    await delay(250);
  }
  assert.fail(description);
}

async function providerRequests() {
  const pool = personaPool('migrate');
  try {
    return await personaTransaction(pool, 'ansungjalbu-cafe', async client => (await client.query(`
      SELECT request.payload, request.scheduled_at AS "scheduledAt", (
        SELECT coalesce(jsonb_agg(message.message ORDER BY message.message_id), '[]'::jsonb)
        FROM naver_virtual.sens_messages message
        WHERE (message.account_id, message.product, message.service_id, message.request_id) =
          (request.account_id, request.product, request.service_id, request.request_id)
      ) AS messages FROM naver_virtual.sens_requests request WHERE request.product = 'sms'
      ORDER BY request.accepted_at, request.request_id`)).rows);
  } finally { await pool.end(); }
}

export async function verifyNoticeSms(call, root, phase) {
  assert.equal(process.env.NAVIS_REPLAY_DISPOSABLE, '1');
  assert.equal(process.env.NAVIS_DB_HOST, 'db');
  const statePath = process.env.NOTICE_SMS_PROOF_STATE;
  assert.ok(statePath);
  const read = (path, status = 200) => call('GET', root + path, status);
  const write = (path, body, status = 200, key = randomUUID(), method = 'POST') =>
    call(method, root + path, status, { body, key });

  if (phase === 'after') {
    const { sent, closed, canceled, content } = JSON.parse(await readFile(statePath, 'utf8'));
    const waitForResult = (id, description) => waitFor(async () => {
      const value = await read(noticePath(id) + '/sms-reservation');
      return ['scheduled', 'dispatching'].includes(value.dispatchState) ? null : value;
    }, description);
    const delivered = await waitForResult(sent, 'The standalone marketing worker must claim the due SMS');
    assert.equal(delivered.status, 'DONE');
    assert.equal(delivered.dispatchState, 'sent');
    assert.equal(delivered.recipientCount, 1);
    assert.equal(delivered.acceptedCount, 1);
    const skipped = await waitForResult(closed, 'The standalone worker must settle the changed closure');
    assert.equal(skipped.status, 'SKIP');
    assert.equal(skipped.reason, 'CLOSURE_CHANGED');
    assert.equal((await read(noticePath(canceled) + '/sms-reservation')).status, 'CANCELED');
    const requests = await providerRequests();
    assert.equal(requests.length, 1, 'The virtual provider receives a single accepted notice across worker iterations');
    assert.equal(requests[0].payload.contentType, 'AD');
    assert.deepEqual(requests[0].messages.map(message => ({ phone: message.to, content: message.content })), [{ phone: retainedNumber, content }]);
    assert.equal(requests[0].scheduledAt, null);
    assert.equal((await read(noticePath(sent))).result.state, 'sent');
    await waitFor(async () => {
      const { items } = await read(calendarPath);
      return items.some(row => row.sourceId === sent) && !items.some(row => row.sourceId === closed || row.sourceId === canceled);
    }, 'Calendar must keep the sent notice and remove the skipped and canceled notices');
    console.info('PASS standalone worker sends one virtual PN13 notice after rechecking consent and skips changed closure and confirmed cancellation');
    return;
  }

  assert.equal(phase, 'before');
  const menu = await write('/inventory/menu', { name: '문자 검증 상품', category: 'drink', price: 3000 }, 201);
  async function registerVisit(phone) {
    const member = await write('/customers', { name: '문자 검증 회원', phone });
    const consentPath = `/customers/${member.resourceId}/consents`;
    const consent = await write(consentPath, { expectedRevision: member.revision, contactAllowed: true, marketingAllowed: true }, 200, randomUUID(), 'PATCH');
    await write(`/pos/member-accounts/${member.resourceId}/entries`, {
      purpose: 'charge_topup', amount: 5000, expectedRevision: 0, splits: [{ method: 'cash', amount: 5000 }],
    });
    const bill = await write('/pos/bills', { type: 'takeout', lines: [{ menuId: menu.resourceId, qty: 1 }] });
    const billPath = `/pos/bills/${bill.resourceId}`;
    const checkout = { memberId: member.resourceId, allocations: [{ kind: 'charge', amount: 3000 }] };
    const quote = await write(billPath + '/member-quote', checkout);
    await write(billPath + '/member-payments', { ...checkout, quoteRevision: quote.quoteRevision, accountRevision: quote.accountRevision });
    return { id: member.resourceId, consentPath, revision: consent.revision };
  }
  const retained = await registerVisit(retainedNumber);
  const revoked = await registerVisit(revokedNumber);
  await waitFor(async () => {
    const { items } = await read(marketing + '/groups/first-visit/customers');
    return [retained, revoked].every(member => items.some(row => row.memberId === member.id && row.selectable));
  }, 'Customer consent and POS visits must reach the Marketing projection');
  const groups = marketing + '/notice-recipient-groups';
  const selection = { groupId: 'first-visit' };
  const group = await write(groups, selection);
  assert.deepEqual(await write(groups, selection), group);
  assert.ok((await read(groups)).items.some(row => row.recipientGroupId === group.recipientGroupId && row.memberCount >= 2));

  const closure = await write('/calendar/events', {
    kind: 'event', date: '2026-11-19', title: '휴무 일정', storeClosure: { kind: 'temporary', endDate: '2026-11-19' },
  }, 201);
  async function schedule(text, link) {
    const draft = await write(marketing + '/notices', { title: '공지', text, channel: 'sms',
      recipientGroupId: group.recipientGroupId, ...(link && { closure: link }) });
    const id = draft.resourceId;
    const path = noticePath(id);
    const { smsPreview: preview, nextSendWindow } = await read(path);
    assert.equal(nextSendWindow.localTime, scheduledFor);
    assert.equal(preview.sendAllowed, true);
    assert.equal(preview.recipientCount, 2);
    assert.ok(preview.content.startsWith('(광고)'));
    assert.match(preview.content, /무료수신거부/);
    const command = { scheduledFor };
    const card = { operation: 'sms.schedule', expectedRevision: 1, targetRef: id, command };
    await write(path + '/send', { ...command, expectedRevision: 1, approvalId: randomUUID() }, 403);
    const press = await write(marketing + '/approvals', { ...card, stage: 'press' });
    const body = { ...command, expectedRevision: 1, approvalId: press.approvalId };
    const key = randomUUID();
    const receipt = await write(path + '/send', body, 200, key);
    assert.equal(receipt.state, 'scheduled');
    assert.deepEqual(await write(path + '/send', body, 200, key), receipt);
    assert.equal((await read(path + '/sms-reservation')).status, 'READY');
    return { id, content: preview.content };
  }
  const sent = await schedule('새 소식');
  const closed = await schedule('휴무 안내', { eventId: closure.resourceId, revision: closure.revision });
  const canceled = await schedule('취소할 소식');
  await waitFor(async () => {
    const { items } = await read(calendarPath);
    return [sent, closed, canceled].every(notice => items.some(row => row.source === 'notice' && row.sourceId === notice.id));
  }, 'The scheduled notices must reach Calendar');

  const cancelCard = { operation: 'sms.cancel', targetRef: canceled.id, expectedRevision: 2, command: {} };
  const press = await write(marketing + '/approvals', { ...cancelCard, stage: 'press' });
  const command = { expectedRevision: 2, approvalId: press.approvalId };
  assert.equal(press.requiresConfirmation, true);
  await write(noticePath(canceled.id) + '/cancel-sms', command, 403);
  await write(marketing + '/approvals', { ...cancelCard, stage: 'confirm', approvalId: press.approvalId });
  assert.equal((await write(noticePath(canceled.id) + '/cancel-sms', command)).state, 'canceled');
  await waitFor(async () => !(await read(calendarPath)).items.some(row => row.sourceId === canceled.id),
    'The confirmed cancellation must remove the Calendar entry');
  await write(revoked.consentPath, { expectedRevision: revoked.revision, contactAllowed: true, marketingAllowed: false }, 200, randomUUID(), 'PATCH');
  await write(`/calendar/events/${closure.resourceId}`, { expectedRevision: closure.revision, memo: '변경됨' }, 200, randomUUID(), 'PATCH');
  assert.deepEqual(await providerRequests(), [], 'The gateway card press and cancellation must not send before due time');
  await writeFile(statePath, JSON.stringify({ sent: sent.id, closed: closed.id, canceled: canceled.id, content: sent.content }));
  console.info('PASS night card schedules 08:00 with exact advertising preview, confirmed cancel, Calendar projections and no early provider calls');
}
