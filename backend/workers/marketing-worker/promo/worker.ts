import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { PromoError, reasonOf } from '../../../../frontend/server/promo/errors.mjs';
import { createPipeline } from '../../../../frontend/server/promo/pipeline.mjs';
import { photoAssets } from '../../../../frontend/server/promo/renderer.mjs';
import type { loadPlanningTemplates } from '../../../../frontend/server/promo/templates/runtime.mjs';
import type { loadReferences } from '../../../../frontend/server/promo/references.mjs';
import { fingerprint, sha256, stages, type CheckpointStage, type PromoArtifacts, type PromoResult } from '../../../services/marketing/promo/contracts.ts';
import { configuredPromoMediaStorage, createPromoMedia } from '../../../services/marketing/promo/media.ts';
import { inStore } from '../../../services/marketing/transaction.ts';
import type { ObjectStorage } from '../../../packages/object-storage/index.ts';
import { createAttemptRunner, UnsettledAttempt } from './attempts.ts';
import type { createPhotoContentClient, createUsageClient } from './clients.ts';
import { checkpoint, claim, complete, defer, fail, LostLease, renew, withLease, type Lease } from './leases.ts';
import type { PromoProvider } from './providers.ts';
import type { createPhotoAnalysis } from './photo-analysis.ts';

type Pipeline = ReturnType<typeof createPipeline>;
type Look = Awaited<ReturnType<Pipeline['look']>>;
type PipelineStory = Awaited<ReturnType<Pipeline['story']>>;
type Story = Pick<PipelineStory, 'story' | 'music'> & { promptCtx: Pick<PipelineStory['promptCtx'], 'photos' | 'exterior'> };
type Scene = Awaited<ReturnType<Pipeline['scenes']>>;
type SceneCheckpoint = Pick<Scene, 'html'> & { fixCount: number };

type Checkpoints = { look: Look; story: Story; scenes: SceneCheckpoint };
type VideoInfo = Pick<PromoResult, 'durationSec' | 'width' | 'height' | 'fps'>;
type PipelineOptions = Parameters<typeof createPipeline>[0];

interface WorkerOptions {
  database: Pool;
  artifacts: PromoArtifacts;
  objectStorage?: ObjectStorage | null;
  meter: ReturnType<typeof createUsageClient>;
  provider: PromoProvider;
  photoContent?: ReturnType<typeof createPhotoContentClient>;
  photoAnalysis?: ReturnType<typeof createPhotoAnalysis>;
  templates?: ReturnType<typeof loadPlanningTemplates>;
  references: ReturnType<typeof loadReferences>;
  music: Array<NonNullable<PromoResult['music']> & { file: string; moods?: string[] }>;
  musicDir: string;
  /** Bind the existing runSceneCheck and checkVideo validators to the configured tools. */
  checkScene: PipelineOptions['checkScene'];
  renderVideo: (request: { outFile: string; signal: AbortSignal } & Record<string, unknown>) => Promise<unknown>;
  checkVideo: (request: { file: string; lengthSec: number; rules: unknown }) => Promise<{ info: VideoInfo; violations: unknown[] }>;
  leaseMs?: number;
  retryDelayMs?: number;
  reconcileWindowMs?: number;
  onError?: (code: 'PROMO_STAGE_DEFERRED') => void;
}

const readJson = <T>(value: Buffer): T => JSON.parse(value.toString('utf8'));
const exec = promisify(execFile);

async function extractPoster(file: string, signal: AbortSignal) {
  const { stdout } = await exec(process.env.NAVIS_FFMPEG_PATH ?? 'ffmpeg', [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1', '-ss', '1', '-i', file,
    '-frames:v', '1', '-vf', 'scale=360:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1',
  ], { signal, timeout: 10_000, encoding: 'buffer', maxBuffer: 512 * 1024 });
  if (stdout[0] !== 0xff || stdout[1] !== 0xd8) throw new Error('Promo poster extraction failed');
  return stdout;
}

export function createPromoWorker({
  database, artifacts: fallback, objectStorage = configuredPromoMediaStorage(), meter, provider, photoContent, photoAnalysis, templates,
  references, music, musicDir, checkScene, renderVideo, checkVideo,
  leaseMs = 30_000, retryDelayMs = 5_000, reconcileWindowMs = 5 * 60_000, onError,
}: WorkerOptions) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 300 || leaseMs > 300_000
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0
      || !Number.isInteger(reconcileWindowMs) || reconcileWindowMs < 1 || reconcileWindowMs > 2_147_483_647) {
    throw new Error('Invalid promo timing');
  }
  const media = objectStorage && createPromoMedia(database, objectStorage);
  const artifacts = media ? media.artifacts(fallback) : fallback;

  async function process(lease: Lease, signal: AbortSignal, directory: string) {
    const { input, stage, catalog_snapshot: snapshot, store_id: storeId, job_id: jobId } = lease;
    const scope = { storeId, resourceId: jobId };
    // Check the persisted attempts even when a redeploy changes the stage's prompt or call keys.
    if (stage !== 'merge') {
      await withLease(database, lease, async db => {
        const expired = await db.query(`
          SELECT 1 FROM marketing.promo_attempt
          WHERE store_id = $1 AND job_id = $2 AND stage = $3 AND state = 'pending'
            AND started_at <= clock_timestamp() - $4 * interval '1 millisecond'
          LIMIT 1`, [storeId, jobId, stage, reconcileWindowMs]);
        if (expired.rowCount) throw new PromoError('AI_TIMEOUT', undefined);
      });
    }
    const attempts = createAttemptRunner({ database, lease, artifacts, meter, provider, signal, reconcileWindowMs });
    const photoSource = {
      listCatalog: () => snapshot.catalog,
      photoInfo: (id: string) => id === snapshot.catalog.store.exteriorPhotoId
        ? { ...snapshot.exterior, photoId: id, menuId: null }
        : snapshot.catalog.photos.find(photo => photo.photoId === id),
      async readPhoto(id: string) {
        if (!Object.hasOwn(snapshot.photos, id)) return null;
        const { resourceId, fileId, photoAssetId, sha256: expectedHash } = snapshot.photos[id];
        const photo = await (photoAssetId
          ? photoContent?.stage(storeId, photoAssetId, directory, signal)
          : artifacts.read({ storeId, resourceId }, fileId, signal));
        if (!photo) throw new Error('Promo Object Storage is off');
        const { bytes, mime } = photo;
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new PromoError('AI_BAD_OUTPUT', undefined);
        const digest = sha256(bytes);
        if (photoAssetId && expectedHash && digest !== expectedHash) throw new PromoError('AI_BAD_OUTPUT', undefined);
        const menuId = photoSource.photoInfo(id)?.menuId;
        const menuName = snapshot.catalog.menus.find(menu => menu.menuId === menuId)?.names.en ?? '';
        return { bytes, mediaType: mime, lookKey: fingerprint({ bytes: digest, menuName }) };
      },
    };
    if (!references.rules) throw new PromoError('AI_BAD_OUTPUT', undefined);
    const jobReferences = {
      ...references,
      rules: { ...references.rules, photo: { ...references.rules.photo, exteriorId: snapshot.catalog.store.exteriorPhotoId } },
    };
    const sceneRunner = attempts.runner('scenes');
    let renderedHtml: string | undefined;
    const pipeline = createPipeline({
      runner: sceneRunner, sceneRunner, lookRunner: attempts.runner('look'),
      storyRunner: attempts.runner('story', { retryInvalid: !templates }),
      lookModel: attempts.model('look'), model: attempts.model('scenes'),
      photoSource, references: jobReferences, music, musicDir: media ? directory : musicDir, cacheDir: directory,
      checkScene, checkVideo, renderVideo: (options: Parameters<WorkerOptions['renderVideo']>[0]) => {
        if (typeof options.html === 'string') renderedHtml = options.html;
        return renderVideo(options);
      },
      fault: null, onSceneCheck: undefined, templates, promotionFacts: snapshot.promotionFacts, storeId,
      readPhotoMeta: photoAnalysis && (async (id: string, stageSignal: AbortSignal) => {
        const photo = await photoSource.readPhoto(id);
        if (!photo) throw new PromoError('AI_BAD_OUTPUT', undefined);
        const menuId = photoSource.photoInfo(id)?.menuId;
        const menuName = snapshot.catalog.menus.find(menu => menu.menuId === menuId)?.names.en ?? '';
        return photoAnalysis.resolve(storeId, photo, menuName, stageSignal);
      }),
    });
    const job = { input, stage, dir: directory, takeIndex: snapshot.takeIndex, fixCount: 0, storyRewriteCount: 0, checks: [],
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 } };
    const save = async <S extends CheckpointStage>(name: S, data: Checkpoints[S]) => {
      await withLease(database, lease, async () => undefined);
      const assetId = await artifacts.put(scope, `${name}-${lease.lease_token}`, 'promo_checkpoint',
        'application/json', Buffer.from(JSON.stringify(data)), signal);
      await checkpoint(database, lease, name, stages[stages.indexOf(name) + 1], assetId);
    };
    const load = async <S extends CheckpointStage>(name: S): Promise<Checkpoints[S]> => {
      const fileId = await inStore(database, storeId, async db => {
        const { rows: [row] } = await db.query<{ asset_id: string }>(`
          SELECT asset_id FROM marketing.promo_checkpoint WHERE store_id = $1 AND job_id = $2 AND stage = $3`, [storeId, jobId, name]);
        if (!row) throw new Error('Promo checkpoint is missing');
        return row.asset_id;
      });
      const { bytes, mime } = await artifacts.read(scope, fileId, signal);
      if (mime !== 'application/json') throw new Error('Unexpected promo checkpoint content type');
      return readJson(bytes);
    };

    try {
      if (stage === 'look') {
        await save('look', await pipeline.look(job, { signal }));
      } else if (stage === 'story') {
        const metas = await load('look');
        const { story, music: track, promptCtx: { photos, exterior } } = await pipeline.story(job, { signal, metas });
        await save('story', { story, music: track, promptCtx: { photos, exterior } });
      } else if (stage === 'scenes') {
        const story = await load('story');
        const scene = await pipeline.scenes(job, { signal, story });
        await save('scenes', { html: scene.html, fixCount: job.fixCount });
      } else {
        const [story, scene] = await Promise.all([load('story'), load('scenes')]);
        job.fixCount = scene.fixCount;
        if (media && story.music) {
          const file = story.music.file;
          const audio = await media.readMusic(storeId, file, signal);
          await writeFile(join(directory, file), audio, { mode: 0o600, signal });
        }
        const { rules, fonts, contract } = jobReferences;
        const assets = await photoAssets(photoSource, [...input.photoIds, snapshot.catalog.store.exteriorPhotoId]);
        const ctx = { ...story.promptCtx, rules, fonts, contract };
        const { info, outFile, music: track } = await pipeline.merge(job, { signal, story, scene: { ...scene, ctx, assets } });
        const bytes = await readFile(outFile);
        if (!bytes.length || !Number.isFinite(info.durationSec) || Math.abs(info.durationSec - input.lengthSec) > 0.1
            || info.width !== 720 || info.height !== 1280 || info.fps !== 30) throw new PromoError('ENCODE_FAILED', undefined);
        const result: PromoResult = {
          durationSec: info.durationSec, width: info.width, height: info.height, fps: info.fps, sizeBytes: bytes.length,
          music: track && { trackId: track.trackId, title: track.title, artist: track.artist, license: 'CC0-1.0' },
          fixCount: job.fixCount,
        };
        await withLease(database, lease, async () => undefined);
        // The account identity is per lease. Even a late upload cannot touch the winning worker's bytes.
        const assetId = await artifacts.put(scope, `video-${lease.lease_token}`, 'promo_output', 'video/mp4', bytes, signal);
        if (media) {
          if (!renderedHtml) throw new Error('Promo render produced no scene');
          const poster = await extractPoster(outFile, signal);
          result.posterAssetId = await media.putArtifact(scope, `poster-${lease.lease_token}`, 'promo_poster', 'image/jpeg', poster, signal);
          result.sceneAssetId = await media.putArtifact(scope, `scene-${lease.lease_token}`, 'promo_scene', 'application/octet-stream',
            Buffer.from(renderedHtml, 'utf8'), signal);
        }
        await complete(database, lease, assetId, result);
      }
    } finally {
      await attempts.flush();
    }
  }

  return {
    /** Process one durable stage. The caller polls its authorized store IDs even if Redis is idle. */
    async runNext(storeId: string, shutdown?: AbortSignal): Promise<boolean> {
      if (shutdown?.aborted) return false;
      const lease = await claim(database, storeId, leaseMs);
      if (!lease) return false;
      const control = new AbortController();
      const signal = shutdown ? AbortSignal.any([control.signal, shutdown]) : control.signal;
      let directory: string | undefined;
      const heartbeat = (async () => {
        while (!signal.aborted) {
          await delay(Math.floor(leaseMs / 3), undefined, { signal });
          await renew(database, lease, leaseMs);
        }
      })().catch(() => control.abort(new LostLease()));

      try {
        directory = await mkdtemp(join(tmpdir(), 'navis-promo-stage-'));
        await process(lease, signal, directory);
      } catch (error) {
        if (!(error instanceof LostLease)) {
          const reason = shutdown?.aborted ? null : reasonOf(error);
          try {
            // Pending provider rows retain the unresolved outcome for audit after the job fails.
            if (reason) await fail(database, lease, reason);
            else {
              await defer(database, lease, retryDelayMs);
              if (!(error instanceof UnsettledAttempt) && !signal.aborted) onError?.('PROMO_STAGE_DEFERRED');
            }
          } catch (settlementError) {
            if (!(settlementError instanceof LostLease)) throw settlementError;
          }
        }
      } finally {
        control.abort();
        await heartbeat;
        if (directory) await rm(directory, { recursive: true, force: true });
      }
      return true;
    },
  };
}
