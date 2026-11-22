import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createNaverMarketing, type CafeGrant, type Provider } from '../../naver/index.ts';
import { invalid, LocalError } from './sources.ts';

type Owner = { storeId: string; actorId: string };
type Board = { clubid: string; menuid: string };
type CafePost = Board & { subject: string; text: string };
type Published = { articleId: number; articleUrl: string };
type CafeReceipt = { id: string; receiptId: string; revision: number; state: 'pending-reconciliation' | 'published' | 'rejected';
  articleId: string | null; articleUrl: string | null };

export function cafeReceipt(row: CafeReceipt) {
  return { ...row, resourceId: row.id, affectedSources: ['community'] };
}

export type CafeOptions = {
  mode: 'fake' | 'virtual';
  /** Optional legacy workload credential. Every publish uses the shared approval registry. */
  cardToken?: string;
  boards(owner: Owner): Promise<readonly Board[]>;
  publish(owner: Owner, input: CafePost & { attemptKey: string }): Promise<Published>;
};

export function pn17Cafe(options: {
  mode: CafeOptions['mode'];
  cardToken?: string;
  forOwner(owner: Owner): Provider;
  grantFor(owner: Owner, signal?: AbortSignal): Promise<CafeGrant | null>;
}): CafeOptions {
  return {
    mode: options.mode,
    cardToken: options.cardToken,
    async boards(owner) {
      const grant = await options.grantFor(owner);
      return grant?.accessToken ? grant.boards : [];
    },
    publish(owner, input) {
      const provider = options.forOwner(owner);
      if (!provider.strict || provider.storeId !== owner.storeId) throw new Error('Expected scoped virtual NAVER provider');
      return createNaverMarketing(provider, { cafeGrant: signal => options.grantFor(owner, signal) })
        .cafe.post({ ...input, signal: AbortSignal.timeout(5000) });
    },
  };
}

export function cafePostInput(value: unknown): CafePost {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 4) invalid();
  const { clubid, menuid, subject, text } = value as Record<string, unknown>;
  const id = (input: unknown): input is string => typeof input === 'string' && /^\d{1,12}$/.test(input);
  const nonempty = (input: unknown, max: number): input is string =>
    typeof input === 'string' && Boolean(input.trim()) && !input.includes('\0') && [...input].length <= max;
  if (!id(clubid) || !id(menuid) || !nonempty(subject, 200) || !nonempty(text, 10000)) invalid();
  return { clubid, menuid, subject, text };
}

const columns = 'id, receipt_id AS "receiptId", revision, state, article_id::text AS "articleId", article_url AS "articleUrl"';

export async function reserveCafePost(tx: Owner & { db: PoolClient }, key: string, input: CafePost, authorize: () => Promise<boolean>) {
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const args = [tx.storeId, tx.actorId, key];
  const { rows: [prior] } = await tx.db.query<CafeReceipt & { fingerprint: string }>(
    `SELECT ${columns}, fingerprint FROM marketing.community_cafe_post WHERE store_id=$1 AND actor_id=$2 AND action_key=$3`, args);
  if (prior) {
    const { fingerprint: saved, ...row } = prior;
    if (saved !== fingerprint) throw new LocalError(409, 'IDEMPOTENCY_CONFLICT');
    return { row, created: false };
  }
  if (!await authorize()) throw new LocalError(403, 'CAFE_BOARD_FORBIDDEN');
  const { rows: [row] } = await tx.db.query<CafeReceipt>(
    `INSERT INTO marketing.community_cafe_post (store_id,actor_id,action_key,fingerprint,id,receipt_id,subject)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
    [...args, fingerprint, randomUUID(), randomUUID(), input.subject]);
  return { row, created: true };
}

/**
 * The Café API documents `articleUrl` only as "작성된 게시글의 링크 주소" with no scheme or host guarantee
 * ([Café API](https://developers.naver.com/docs/login/cafe-api/cafe-api.md)). A confirmed article is recorded
 * either way (RV-GAP-B-9): an unexpected link is replaced by a display link built from the returned IDs.
 */
export function cafeArticleLink(board: Board, result: Published) {
  try {
    const url = new URL(result.articleUrl);
    if (url.protocol === 'https:' && url.hostname === 'cafe.naver.com' && !url.username && !url.password) return url.href;
  } catch { /* Not a URL; fall back below. */ }
  return `https://cafe.naver.com/ca-fe/cafes/${board.clubid}/articles/${result.articleId}`;
}

export async function finishCafePost(tx: Owner & { db: PoolClient }, id: string, result: Published | null, board?: Board) {
  if (result && (!Number.isSafeInteger(result.articleId) || result.articleId < 1)) throw new Error('Invalid Café article ID');
  const link = result && board ? cafeArticleLink(board, result) : null;
  if (result && !link) throw new Error('Café board required for a published article');
  const { rows: [row] } = await tx.db.query<CafeReceipt>(
    `UPDATE marketing.community_cafe_post SET state=$4, article_id=$5, article_url=$6, revision=revision+1, updated_at=now()
     WHERE store_id=$1 AND actor_id=$2 AND id=$3 RETURNING ${columns}`,
    [tx.storeId, tx.actorId, id, result ? 'published' : 'rejected', result?.articleId ?? null, link]);
  return row;
}
