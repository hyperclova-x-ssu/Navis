import { randomUUID } from 'node:crypto';
import { apply, confirm, event, id, integer, limit, MemberError, memberSources, object, page, revision,
  sourceRevision, text, type CustomerTx, type Receipt } from './wire.ts';

const grades = ['regular', 'frequent', 'occasional', 'inactive'] as const;
const nameCharacters = new Intl.Segmenter();
type Grade = typeof grades[number];
type Member = { memberId: string; memberCode: string; name: string; phone: string; gradeOverride: Grade | null; contactAllowed: boolean;
  marketingAllowed: boolean; revision: number; archivedAt: Date | null };
type Note = { noteId: string; body: string; revision: number; updatedAt: Date; archivedAt: Date | null };
type Inverse = { kind: 'member' | 'note'; memberId: string; targetId: string; previous: Member | Note | null };
const fields = `member_id AS "memberId", member_code AS "memberCode", name, phone, grade_override AS "gradeOverride", contact_allowed AS "contactAllowed",
  marketing_allowed AS "marketingAllowed", revision, archived_at AS "archivedAt"`;
const noteFields = `note_id AS "noteId", body, revision, updated_at AS "updatedAt", archived_at AS "archivedAt"`;

function phoneNumber(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9]{10,11}$/.test(value)) throw new MemberError(400, 'MEMBER_INVALID', undefined, 'phone');
  return value;
}
const masked = (phone: string) => phone.slice(0, 3) + '-****-' + phone.slice(-4);

async function assertPhone({ db, storeId }: CustomerTx, phone: string, memberId: string | null) {
  const { rows: [duplicate] } = await db.query<Member>(`SELECT ${fields} FROM customer.member
    WHERE store_id=$1 AND phone=$2 AND archived_at IS NULL AND member_id IS DISTINCT FROM $3`, [storeId, phone, memberId]);
  if (duplicate) throw new MemberError(409, 'DUPLICATE_MEMBER_PHONE',
    { memberId: duplicate.memberId, memberCode: duplicate.memberCode, name: Array.from(duplicate.name)[0] + '**', phone: masked(duplicate.phone) }, 'phone');
}
export async function getMember({ db, storeId }: CustomerTx, memberId: string, archived = false) {
  const { rows: [row] } = await db.query<Member>(`SELECT ${fields} FROM customer.member
    WHERE store_id=$1 AND member_id=$2 AND ($3 OR archived_at IS NULL)`, [storeId, memberId, archived]);
  if (!row) throw new MemberError(404, 'MEMBER_NOT_FOUND');
  return row;
}

export async function memberCodes({ db, storeId }: CustomerTx, input: unknown) {
  if (!Array.isArray(input) || input.length > 200) throw new MemberError(400, 'INVALID_REQUEST');
  const ids = input.map(id);
  const { rows } = await db.query<{ memberId: string; memberCode: string }>(`
    SELECT member_id AS "memberId", member_code AS "memberCode"
    FROM customer.member WHERE store_id=$1 AND member_id=ANY($2::uuid[])`, [storeId, ids]);
  return { items: rows };
}

export async function members(tx: CustomerTx, query: unknown, memberId?: string) {
  const filters = object(query ?? {}, ['query', 'gradeFilter', 'marketingEligible', 'cursor', 'limit']);
  const q = filters.query === undefined || filters.query === '' ? '' : text(filters.query, 100);
  const grade = filters.gradeFilter === 'all' || filters.gradeFilter === undefined ? null : filters.gradeFilter;
  if (grade !== null && !grades.some(value => value === grade)) throw new MemberError(400, 'INVALID_REQUEST');
  if (filters.marketingEligible !== undefined && filters.marketingEligible !== 'true' && filters.marketingEligible !== 'false') {
    throw new MemberError(400, 'INVALID_REQUEST');
  }
  const cursor = filters.cursor === undefined ? null : id(filters.cursor);
  const take = limit(filters.limit);
  type Summary = Member & { grade: Grade; joinedOn: string; visitCount: number; recentVisitCount: number; lastVisitAt: Date | null; notes: Note[] };
  const { rows } = await tx.db.query<Summary>(`
    WITH summary AS (
      SELECT ${fields}, (created_at AT TIME ZONE 'Asia/Seoul')::date::text AS "joinedOn",
        v.total AS "visitCount", v.recent AS "recentVisitCount", v.last AS "lastVisitAt",
        COALESCE(grade_override, CASE WHEN v.recent >= 4 THEN 'regular' WHEN v.recent >= 2 THEN 'frequent'
           WHEN v.recent = 1 OR v.total = 0 THEN 'occasional' ELSE 'inactive' END) AS grade
      FROM customer.member m
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS total, max(visited_at) AS last,
          count(*) FILTER (WHERE (visited_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN $7::date - 27 AND $7::date)::int AS recent
        FROM customer.member_visit WHERE store_id=m.store_id AND member_id=m.member_id AND reversed_at IS NULL
      ) v
      WHERE store_id=$1 AND archived_at IS NULL AND ($2::uuid IS NULL OR member_id=$2)
        AND ($3::uuid IS NULL OR member_id>$3)
        AND ($4='' OR member_code=upper($4) OR strpos(lower(name),lower($4))>0
          OR ($4 ~ '^[0-9]{1,4}$' AND right(phone,length($4))=$4))
        AND (NOT $5::boolean OR (contact_allowed AND marketing_allowed))
    )
    SELECT s.*, COALESCE((
      SELECT jsonb_agg(jsonb_build_object('noteId',note_id,'body',body,'revision',revision,'updatedAt',updated_at) ORDER BY note_id)
      FROM customer.member_note WHERE store_id=$1 AND member_id=s."memberId" AND archived_at IS NULL
    ), '[]') AS notes
    FROM summary s WHERE ($6::text IS NULL OR grade=$6) ORDER BY "memberId" LIMIT $8
  `, [tx.storeId, memberId ?? null, cursor, q, filters.marketingEligible === 'true', grade, tx.day, take + 1]);
  const items = rows.map(({ phone, contactAllowed, marketingAllowed, archivedAt: _archivedAt, ...row }) => ({
    ...row, customerId: row.memberId, ...(memberId && { phone }), phoneMasked: masked(phone),
    consent: { contactAllowed, marketingAllowed },
  }));
  if (memberId) {
    if (!items[0]) throw new MemberError(404, 'MEMBER_NOT_FOUND');
    return items[0];
  }
  return page(items, take, row => row.memberId, tx, await sourceRevision(tx));
}

const meta = (memberId: string, revision: number, noteId?: string) => ({
  resourceId: noteId ?? memberId, memberId, customerId: memberId, revision, affectedSources: memberSources, ...(noteId && { noteId }),
});
function announce(tx: CustomerTx, member: Member, type = 'customer.member_changed.v1') {
  const active = !member.archivedAt;
  const contactAllowed = active && member.contactAllowed;
  const marketingAllowed = active && member.marketingAllowed;
  const [first, second] = nameCharacters.segment(member.name.normalize('NFC'));
  // A one-character name would disclose the full name.
  const nameInitial = contactAllowed && marketingAllowed && second && first && /^\p{L}$/u.test(first.segment)
    ? first.segment : undefined;
  return event(tx, type, member.memberId, { memberId: member.memberId, revision: member.revision,
    active, contactAllowed, marketingAllowed, ...(nameInitial && { nameInitial }) });
}

export function createMember(tx: CustomerTx, key: string, body: unknown) {
  const input = object(body, ['name', 'phone']);
  const name = text(input.name, 100, 'MEMBER_INVALID', 'name');
  const phone = phoneNumber(input.phone);
  return apply(tx, key, 'members.create', { name, phone }, async () => {
    await assertPhone(tx, phone, null);
    const memberId = randomUUID();
    const { rows: [member] } = await tx.db.query<Member>(`INSERT INTO customer.member (store_id,member_id,name,phone,created_at)
      VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`, [tx.storeId, memberId, name, phone, tx.at]);
    await announce(tx, member);
    return { receipt: meta(memberId, 1), inverse: { kind: 'member', memberId, targetId: memberId, previous: null } satisfies Inverse };
  });
}
async function writeMember(tx: CustomerTx, member: Member) {
  const { rows: [row] } = await tx.db.query<Member>(`UPDATE customer.member SET name=$3, phone=$4,
    grade_override=$5, contact_allowed=$6, marketing_allowed=$7, archived_at=$8, revision=revision+1
    WHERE store_id=$1 AND member_id=$2 RETURNING ${fields}`, [tx.storeId, member.memberId, member.name, member.phone,
    member.gradeOverride, member.contactAllowed, member.marketingAllowed, member.archivedAt]);
  return row;
}
async function assertPassesClear(tx: CustomerTx, memberId: string) {
  const { rows: [row] } = await tx.db.query<{ passes: number }>(`SELECT count(*)::int AS passes FROM customer.membership m
    WHERE m.store_id=$1 AND m.member_id=$2 AND ((m.status='active' AND m.ends_on >= $3::date AND m.uses_left>0)
      OR EXISTS (SELECT 1 FROM customer.pos_claim c WHERE c.store_id=m.store_id AND c.membership_id=m.membership_id AND c.state='held'))`,
    [tx.storeId, memberId, tx.day]);
  if (row.passes) throw new MemberError(409, 'MEMBER_DELETE_BLOCKED', { passes: row.passes });
}
export function changeMember(tx: CustomerTx, key: string, memberId: string, body: unknown, mode: 'profile' | 'consent' | 'archive') {
  const keys = mode === 'profile' ? ['name', 'phone', 'grade'] : mode === 'consent' ? ['contactAllowed', 'marketingAllowed'] : ['confirmed'];
  const input = object(body, ['expectedRevision', ...keys]);
  const expectedRevision = integer(input.expectedRevision);
  if (!keys.some(field => field in input)) throw new MemberError(400, 'INVALID_REQUEST');
  if (mode === 'archive') confirm(input.confirmed);
  const name = 'name' in input ? text(input.name, 100, 'MEMBER_INVALID', 'name') : undefined;
  const phone = 'phone' in input ? phoneNumber(input.phone) : undefined;
  const grade = input.grade;
  if ('grade' in input && grade !== null && !grades.some(value => value === grade)) throw new MemberError(400, 'INVALID_REQUEST');
  for (const field of ['contactAllowed', 'marketingAllowed'] as const) {
    if (field in input && typeof input[field] !== 'boolean') throw new MemberError(400, 'INVALID_REQUEST');
  }
  return apply(tx, key, 'members.' + mode, { memberId, ...input }, async () => {
    const prior = await getMember(tx, memberId);
    revision(prior.revision, expectedRevision);
    if (phone) await assertPhone(tx, phone, memberId);
    if (mode === 'archive') await assertPassesClear(tx, memberId);
    const contactAllowed = (input.contactAllowed as boolean | undefined) ?? prior.contactAllowed;
    const marketingAllowed = (input.marketingAllowed as boolean | undefined) ?? (contactAllowed && prior.marketingAllowed);
    if (marketingAllowed && !contactAllowed) throw new MemberError(400, 'CONSENT_REQUIRES_CONTACT');
    const row = await writeMember(tx, { ...prior, name: name ?? prior.name, phone: phone ?? prior.phone,
      gradeOverride: grade === undefined ? prior.gradeOverride : grade as Grade | null, contactAllowed, marketingAllowed,
      archivedAt: mode === 'archive' ? tx.at : null });
    await announce(tx, row, mode === 'consent' ? 'customer.contact_state_changed.v1' : undefined);
    return { receipt: meta(memberId, row.revision), inverse: { kind: 'member', memberId, targetId: memberId, previous: prior } satisfies Inverse };
  });
}

async function readNote(tx: CustomerTx, memberId: string, noteId: string, archived = false) {
  const { rows: [row] } = await tx.db.query<Note>(`SELECT ${noteFields} FROM customer.member_note
    WHERE store_id=$1 AND member_id=$2 AND note_id=$3 AND ($4 OR archived_at IS NULL)`, [tx.storeId, memberId, noteId, archived]);
  if (!row) throw new MemberError(404, 'NOTE_NOT_FOUND');
  return row;
}
async function writeNote(tx: CustomerTx, memberId: string, noteId: string, body: string, archivedAt: Date | null) {
  const { rows: [row] } = await tx.db.query<Note>(`UPDATE customer.member_note
    SET body=$4, archived_at=$5, updated_at=$6, revision=revision+1 WHERE store_id=$1 AND member_id=$2 AND note_id=$3
    RETURNING ${noteFields}`, [tx.storeId, memberId, noteId, body, archivedAt, tx.at]);
  return row;
}
export function changeNote(tx: CustomerTx, key: string, memberId: string, noteId: string | null, body: unknown, archive = false) {
  const input = object(body, ['expectedRevision', archive ? 'confirmed' : 'body']);
  const expectedRevision = integer(input.expectedRevision);
  if (archive) confirm(input.confirmed);
  const message = archive ? null : text(input.body, 2000);
  return apply(tx, key, 'members.note', { memberId, noteId, archive, message, expectedRevision }, async () => {
    const member = await getMember(tx, memberId);
    const prior = noteId ? await readNote(tx, memberId, noteId) : null;
    revision(prior?.revision ?? member.revision, expectedRevision);
    const targetId = noteId ?? randomUUID();
    let next = 1;
    if (!prior) {
      await tx.db.query(`INSERT INTO customer.member_note (store_id,member_id,note_id,body,updated_at)
        VALUES ($1,$2,$3,$4,$5)`, [tx.storeId, memberId, targetId, message, tx.at]);
    } else {
      next = (await writeNote(tx, memberId, targetId, message ?? prior.body, archive ? tx.at : null)).revision;
    }
    await event(tx, 'customer.member_changed.v1', memberId, { memberId, noteId: targetId, noteRevision: next });
    return { receipt: meta(memberId, next, targetId), inverse: { kind: 'note', memberId, targetId, previous: prior } satisfies Inverse };
  });
}

async function original(tx: CustomerTx, receiptId: string) {
  const { rows: [row] } = await tx.db.query<{ receipt: Receipt; inverse: Inverse | null; undoneAt: Date | null }>(`
    SELECT receipt, inverse, undone_at AS "undoneAt" FROM customer.member_command
    WHERE store_id=$1 AND receipt_id=$2 AND actor_id=$3`, [tx.storeId, receiptId, tx.actorId]);
  if (!row) throw new MemberError(404, 'RECEIPT_NOT_FOUND');
  return row;
}
export async function undoArchiveTarget(tx: CustomerTx, receiptId: string) {
  const { inverse } = await original(tx, receiptId);
  return inverse?.kind === 'member' && inverse.previous === null ? inverse.memberId : null;
}
export function undoMember(tx: CustomerTx, key: string, receiptId: string, guardedMemberId: string | null) {
  return apply(tx, key, 'members.undo', { receiptId }, async () => {
    const { receipt, inverse, undoneAt } = await original(tx, receiptId);
    if (undoneAt) throw new MemberError(409, 'UNDO_ALREADY_APPLIED');
    if (!receipt.undoUntil || !inverse) throw new MemberError(409, 'UNDO_UNAVAILABLE');
    if (tx.at >= new Date(receipt.undoUntil)) throw new MemberError(409, 'UNDO_EXPIRED');
    const { memberId, targetId } = inverse;
    let value: ReturnType<typeof meta>;
    if (inverse.kind === 'member') {
      const member = await getMember(tx, memberId, true);
      revision(member.revision, receipt.revision);
      const prior = inverse.previous as Member | null;
      if (!prior) {
        if (guardedMemberId !== memberId) throw new MemberError(409, 'UNDO_UNAVAILABLE');
        await assertPassesClear(tx, memberId);
      } else if (!prior.archivedAt) {
        await assertPhone(tx, prior.phone, memberId);
      }
      const row = await writeMember(tx, prior ?? { ...member, archivedAt: tx.at });
      await announce(tx, row, 'customer.contact_state_changed.v1');
      value = meta(memberId, row.revision);
    } else {
      await getMember(tx, memberId);
      const note = await readNote(tx, memberId, targetId, true);
      revision(note.revision, receipt.revision);
      const prior = inverse.previous as Note | null;
      const row = await writeNote(tx, memberId, targetId, prior?.body ?? note.body, prior ? prior.archivedAt : tx.at);
      await event(tx, 'customer.member_changed.v1', memberId, { memberId, noteId: targetId, noteRevision: row.revision });
      value = meta(memberId, row.revision, targetId);
    }
    await tx.db.query('UPDATE customer.member_command SET undone_at=$3 WHERE store_id=$1 AND receipt_id=$2',
      [tx.storeId, receiptId, tx.at]);
    return { receipt: value };
  });
}
