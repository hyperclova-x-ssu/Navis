import type { Pool, PoolClient } from 'pg';
import type { PromoArtifacts, PromoJob } from '../../promo/contracts.ts';
import { inStore } from '../../transaction.ts';
import { command, emitPromoChange, receipt, type Owner, type Receipt } from './state.ts';
import { conflict, notFound, postingLink, type Channel, type PublishInput } from './wire.ts';

export type ProviderResult = { ref: string; state: 'published' | 'pending' | 'failed'; link?: string | null };
type Publish = (owner: Owner, input: PublishInput, bytes: Uint8Array, attemptKey: string) => Promise<ProviderResult>;
export type PublicationPorts = {
  artifacts: Pick<PromoArtifacts, 'read'>;
  naver?: { mode: 'fake'; publish: Publish;
    read?: (owner: Owner, channel: Channel, ref: string) => Promise<ProviderResult | null> };
  social?: {
    a6: true;
    channels: Partial<Record<'reels' | 'shorts', { officialAccountApproved: true; reviewApproved: true; publish: Publish }>>;
  };
};

// The composer supplies store-bound PN-A2 ports and binds only the FAKE transport in R1.
export function naverPromoPublish(adaptersFor: (owner: Owner) => {
  news: { create(input: { text: string; video: { bytes: Uint8Array; contentType: 'video/mp4' }; attemptKey: string }):
    Promise<{ news: { ref: string }; readBack: 'confirmed' | 'pending' }>;
    read?(ref: string): Promise<{ ref: string } | null> };
  clips: { upload(input: Omit<Extract<PublishInput, { channel: 'clip' }>, 'channel'> & {
    video: { bytes: Uint8Array; contentType: 'video/mp4' }; attemptKey: string;
  }): Promise<{ clip: { ref: string; state: 'processing' | 'published' | 'failed'; link: string | null } }>;
    read?(ref: string): Promise<{ ref: string; state: 'processing' | 'published' | 'failed'; link: string | null }> };
}): NonNullable<PublicationPorts['naver']> {
  return {
    mode: 'fake',
    async read(owner, channel, ref) {
      const adapters = adaptersFor(owner);
      if (channel === 'place-news') {
        const news = await adapters.news.read?.(ref);
        return news ? { ref: news.ref, state: 'published' } : null;
      }
      if (channel === 'clip') {
        const clip = await adapters.clips.read?.(ref);
        return clip ? { ref: clip.ref, state: clip.state === 'processing' ? 'pending' : clip.state, link: clip.link } : null;
      }
      return null;
    },
    async publish(owner, input, bytes, attemptKey) {
      const adapters = adaptersFor(owner);
      const video = { bytes, contentType: 'video/mp4' as const };
      const { channel, ...fields } = input;
      if (channel === 'place-news' && 'text' in fields) {
        const { news, readBack } = await adapters.news.create({ text: fields.text, video, attemptKey });
        return { ref: news.ref, state: readBack === 'confirmed' ? 'published' : 'pending' };
      }
      if (channel === 'clip' && 'category' in fields) {
        const { clip } = await adapters.clips.upload({ ...fields, video, attemptKey });
        return { ref: clip.ref, state: clip.state === 'processing' ? 'pending' : clip.state, link: clip.link };
      }
      throw new Error('Unsupported NAVER promo channel');
    },
  };
}

export async function finishedJob(db: PoolClient, storeId: string, jobId: string) {
  const { rows: [job] } = await db.query<Pick<PromoJob, 'status' | 'asset_id' | 'result'>>(
    'SELECT status, asset_id, result FROM marketing.promo_job WHERE store_id = $1 AND job_id = $2', [storeId, jobId]);
  if (!job) throw notFound();
  if (job.status !== 'done' || !job.asset_id || !job.result) throw conflict('PROMO_NOT_READY');
  return { assetId: job.asset_id, bytes: job.result.sizeBytes };
}

export async function attest(pool: Pool, owner: Owner, key: unknown, jobId: string, channel: Channel, link: string) {
  const result = await command(pool, owner, key, ['attest', jobId, channel, link], async (db, receiptId) => {
    await finishedJob(db, owner.storeId, jobId);
    const { rowCount } = await db.query(`
      INSERT INTO marketing.promo_publication (store_id, publication_id, job_id, channel, method, state, link)
      VALUES ($1, $2, $3, $4, 'attestation', 'published', $5)
      ON CONFLICT (store_id, job_id, channel, method) DO NOTHING`,
    [owner.storeId, receiptId, jobId, channel, link]);
    if (!rowCount) throw conflict('ALREADY_ATTESTED');
    return { receipt: receipt(receiptId, receiptId, 1, 'promo-publications') };
  });
  return result.value.receipt;
}

export async function publish(pool: Pool, ports: PublicationPorts, owner: Owner, key: unknown, jobId: string, input: PublishInput) {
  const { channel } = input;
  const social = channel === 'reels' || channel === 'shorts' ? ports.social?.channels[channel] : undefined;
  const send = channel === 'clip' || channel === 'place-news'
    ? (ports.naver?.mode === 'fake' ? ports.naver.publish : undefined)
    : (ports.social?.a6 === true && social?.officialAccountApproved === true && social.reviewApproved === true ? social.publish : undefined);
  if (!send) throw conflict('MANUAL_UPLOAD_REQUIRED');

  let bytes: Uint8Array | undefined;
  const reservation = await command(pool, owner, key, ['publish', jobId, input], async (db, receiptId) => {
    const video = await finishedJob(db, owner.storeId, jobId);
    const artifact = await ports.artifacts.read({ storeId: owner.storeId, resourceId: jobId }, video.assetId);
    if (artifact.mime !== 'video/mp4' || artifact.bytes.length !== video.bytes) throw conflict('PROMO_NOT_READY');
    bytes = artifact.bytes;
    const { rowCount } = await db.query(`
      INSERT INTO marketing.promo_publication (store_id, publication_id, job_id, channel, method, state)
      VALUES ($1, $2, $3, $4, 'provider', 'pending')
      ON CONFLICT (store_id, job_id, channel, method) DO NOTHING`,
    [owner.storeId, receiptId, jobId, channel]);
    if (!rowCount) throw conflict('PUBLICATION_ALREADY_REQUESTED');
    return { receipt: receipt(receiptId, receiptId, 1, 'promo-publications') };
  });
  const original = reservation.value.receipt;
  let outcome: ProviderResult | null;
  let expected = 1;
  try {
    if (reservation.replayed) {
      const providerRead = ports.naver?.mode === 'fake' ? ports.naver.read : undefined;
      if (!providerRead) return original;
      const prior = await inStore(pool, owner.storeId, async db => (await db.query<{
        provider_ref: string; revision: number;
      }>(`SELECT provider_ref, revision FROM marketing.promo_publication
        WHERE store_id = $1 AND publication_id = $2 AND state = 'pending' AND provider_ref IS NOT NULL`,
      [owner.storeId, original.resourceId])).rows[0]);
      if (!prior) return original;
      expected = prior.revision;
      outcome = await providerRead(owner, channel, prior.provider_ref);
      if (!outcome || outcome.ref !== prior.provider_ref || outcome.state === 'pending') return original;
    } else {
      if (!bytes) return original;
      outcome = await send(owner, input, bytes, original.receiptId);
    }
  } catch {
    // An unknown send has no provider reference and stays pending. Replay never sends it again.
    return original;
  }
  await recordProviderResult(pool, owner, original, channel, expected, outcome);
  return original;
}

async function recordProviderResult(pool: Pool, owner: Owner, original: Receipt, channel: Channel,
  expected: number, outcome: ProviderResult) {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(outcome.ref)) return;
  let link: string | null = null;
  if (outcome.state === 'published' && outcome.link) {
    try { link = postingLink(outcome.link, channel); } catch { /* Omit links outside the approved surface. */ }
  }
  await inStore(pool, owner.storeId, async db => {
    const { rowCount } = await db.query(`UPDATE marketing.promo_publication
      SET state = $3, provider_ref = $4, link = $5, revision = revision + 1
      WHERE store_id = $1 AND publication_id = $2 AND revision = $6 AND state = 'pending'`,
    [owner.storeId, original.resourceId, outcome.state, outcome.ref, link, expected]);
    if (!rowCount) return;
    const eventType = outcome.state === 'pending' ? 'marketing.promo_publication_progressed.v1' : 'marketing.promo_publication_resolved.v1';
    await emitPromoChange(db, owner.storeId, { ...original, revision: expected + 1 }, eventType);
  }, { serialize: true });
}
