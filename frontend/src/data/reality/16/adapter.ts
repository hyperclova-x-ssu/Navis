import type { MarketingTables, PromoVideo, PromoVideoInput } from '../../marketing/types';
import { defineBinding, PortError, type CommandContext, type DomainAdapter, type ListPage, type PortReads } from '../00';
import { isVideoInput, jobPath, openDraft, promoPath, publishPath, safeAttestationLink, safePostLink, sameInput, type PromoAssetsPage,
  type PromoDraftDto, type PromoJobDto, type PromoPublicationDto, type PromoReadModel } from './dto';

type WirePage<T> = Omit<ListPage<T>, 'sourceRevision'> & { readonly sourceRevision: string | number };

async function readPages<T, Extra extends object = object>(reads: PortReads, resource: string, path: string, signal: AbortSignal) {
  const get = (cursor?: string) => reads.one<WirePage<T> & Extra>({ resource, path, query: { limit: 50, cursor } }, { signal });
  const first = await get();
  const sourceRevision = typeof first?.sourceRevision === 'string' && /^[0-9a-f]{64}$/u.test(first.sourceRevision)
    ? Number.parseInt(first.sourceRevision.slice(0, 12), 16) : first?.sourceRevision;
  if (typeof sourceRevision !== 'number' || !Number.isSafeInteger(sourceRevision) || !Array.isArray(first.items)
      || typeof first.asOf !== 'string' || !(first.nextCursor === null || typeof first.nextCursor === 'string')) {
    throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
  }
  const items = [...first.items];
  let nextCursor = first.nextCursor;
  for (let count = 1; nextCursor && count < 20; count += 1) {
    const page = await get(nextCursor);
    if (!Array.isArray(page?.items) || !(page.nextCursor === null || typeof page.nextCursor === 'string') || page.nextCursor === nextCursor) {
      throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
    }
    items.push(...page.items);
    nextCursor = page.nextCursor;
  }
  return { ...first, items, nextCursor, sourceRevision };
}

function marketingRows(model: PromoReadModel | undefined): Pick<MarketingTables, 'promoStore' | 'promoMenu' | 'promoPhoto' | 'promoVideo' | 'promoDrafts'> {
  if (!model) return { promoStore: [], promoMenu: [], promoPhoto: [], promoVideo: [], promoDrafts: undefined };
  const { assets, drafts, publications, jobs } = model;
  const byJob = new Map(drafts.map(draft => [draft.jobId, draft]));
  const promoVideo: PromoVideo[] = [];
  for (const job of jobs) {
    const draft = byJob.get(job.jobId);
    if (!draft || !isVideoInput(draft.input)) continue;
    const posted = publications.filter(row => row.jobId === job.jobId && row.state === 'published')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || Number(b.link !== null) - Number(a.link !== null))[0];
    const result = job.result;
    const madeAt = job.startedAt ?? draft.updatedAt;
    promoVideo.push({ videoId: job.jobId, jobId: job.jobId, input: draft.input,
      status: posted ? 'posted' : job.status === 'done' || job.status === 'failed' ? job.status : 'making',
      stage: job.stage, stageState: job.stageState, lookCount: job.lookCount ?? null, failReason: job.failReason ?? null,
      postedRoute: posted && posted.channel !== 'place-news' ? posted.channel : null, postedAt: posted?.createdAt ?? null, createdAt: madeAt, retryCount: 0,
      ...(posted && { publication: { channel: posted.channel, link: safePostLink(posted.link) ?? null } }),
      result: result ? { durationSec: result.durationSec, sizeBytes: result.sizeBytes, madeAt,
        fileUrl: `/api/v1/stores/${encodeURIComponent(model.storeId)}${jobPath(job.jobId)}/video.mp4`,
        music: result.music ? { ...result.music, licenseLabel: result.music.license } : { trackId: '', title: '', artist: '', licenseLabel: '' },
      } : null,
    });
  }
  const promoStore = assets.store ? [{ ...assets.store, sourceId: assets.store.sourceId ?? model.storeId }] : [];
  const promoMenu = assets.menus.map(({ menuId, names }, order) => ({ menuId, names, order }));
  const promoPhoto = assets.items.flatMap(({ photoId, menuId, url, width, height }, order) => menuId === null ? [] : [{ photoId, menuId, url, width, height, order }]);
  promoVideo.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { promoStore, promoMenu, promoPhoto, promoVideo, promoDrafts: undefined };
}

function generate(input: PromoVideoInput, context: CommandContext) {
  const draft = openDraft(context.snapshot.tables.realPromo);
  if (!draft || !sameInput(input, draft.input)) throw new PortError(400, 'VALIDATION', 'DRAFT_REQUIRED');
  return { method: 'POST' as const, path: `${promoPath}/drafts/${encodeURIComponent(draft.draftId)}/generate`,
    expectedRevision: draft.revision, body: { confirmed: true } };
}

export const promoAdapter: DomainAdapter = {
  domain: 'promo',
  sources: ['promo-assets', 'promo-drafts', 'promo-publications', 'promo-jobs'],
  tables: ['realPromo'],
  clear: () => ({ realPromo: undefined }),
  merge(snapshot, tables) {
    if (!Object.hasOwn(tables, 'realPromo') && !Object.hasOwn(tables, 'marketing')) return tables;
    const model = Object.hasOwn(tables, 'realPromo') ? tables.realPromo : snapshot.tables.realPromo;
    return { ...tables, marketing: { ...(tables.marketing ?? snapshot.tables.marketing), ...marketingRows(model) } };
  },
  errorKeys: {
    DRAFT_REQUIRED: 'promo.real.draftRequired',
    MANUAL_UPLOAD_REQUIRED: 'promo.real.manual',
    POST_LINK_REQUIRED: 'promo.real.linkRequired',
    PROMO_SELECTION_UNAVAILABLE: 'promo.error.selectionUnavailable',
    PROMO_NOT_READY: 'promo.error.notReady',
    BUSY: 'data.marketing.error.busy',
  },
  async load({ reads, storeId, signal, snapshot }) {
    const [assets, drafts, publications] = await Promise.all([
      readPages<PromoAssetsPage['items'][number], Omit<PromoAssetsPage, keyof ListPage<unknown>>>(reads, 'promo.assets', `${promoPath}/assets`, signal),
      readPages<PromoDraftDto>(reads, 'promo.drafts', `${promoPath}/drafts`, signal),
      readPages<PromoPublicationDto, Pick<PromoReadModel, 'uploadTargets'>>(reads, 'promo.publications', `${promoPath}/publications`, signal),
    ]);
    const orderedDrafts = [...drafts.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.draftId.localeCompare(a.draftId));
    const jobs: PromoJobDto[] = [];
    const previous = snapshot.tables.realPromo;
    const terminal = new Map(previous?.storeId === storeId ? previous.jobs.flatMap(job => job.status === 'done' || job.status === 'failed' ? [[job.jobId, job] as const] : []) : []);
    const ids = [...new Set(orderedDrafts.flatMap(draft => draft.jobId ? [draft.jobId] : []))];
    for (let start = 0; start < ids.length; start += 8) {
      jobs.push(...await Promise.all(ids.slice(start, start + 8).map(id => terminal.get(id) ?? reads.one<PromoJobDto>({ resource: 'promo.job', path: jobPath(id) }, { signal }))));
    }
    return {
      tables: { realPromo: { storeId, assets: { items: assets.items, store: assets.store, menus: assets.menus, eligiblePhotoCount: assets.eligiblePhotoCount },
        drafts: orderedDrafts, publications: publications.items, jobs, uploadTargets: publications.uploadTargets } },
      revisions: Object.fromEntries(orderedDrafts.map(draft => [`promo.draft:${draft.draftId}`, draft.revision])),
      asOf: [assets.asOf, drafts.asOf, publications.asOf].sort().at(-1)!, sourceRevision: Math.max(assets.sourceRevision, drafts.sourceRevision, publications.sourceRevision),
      complete: assets.nextCursor === null && drafts.nextCursor === null && publications.nextCursor === null,
    };
  },
  commands: [
    defineBinding({ type: 'promo.addPhoto', request: ({ fileId, menuId, rightsConfirmed }) => {
      if (rightsConfirmed !== true) throw new PortError(400, 'VALIDATION', 'RIGHTS_REQUIRED');
      return { method: 'POST', path: `${promoPath}/assets`, body: { fileId, menuId, rightsConfirmed } };
    } }),
    defineBinding({ type: 'promo.saveDraft', request: ({ draftId, expectedRevision, patch }, context) => {
      if (!draftId) return { method: 'POST', path: `${promoPath}/drafts`, body: patch };
      if (expectedRevision === undefined || context.revision(`promo.draft:${draftId}`) !== expectedRevision) throw new PortError(409, 'CONFLICT', 'STALE_REVISION');
      return { method: 'PATCH', path: `${promoPath}/drafts/${encodeURIComponent(draftId)}`, body: { patch }, expectedRevision };
    } }),
    defineBinding({ type: 'video.make', noticeKey: 'data.marketing.notice.videoStarted', request: ({ input }, context) => generate(input, context) }),
    defineBinding({ type: 'video.retry', noticeKey: 'data.marketing.notice.videoStarted', request: ({ videoId }, context) => {
      const failed = context.snapshot.tables.marketing.promoVideo.find(row => row.videoId === videoId && row.status === 'failed');
      if (!failed) throw new PortError(404, 'NOT_FOUND', 'NOT_FOUND');
      return generate(failed.input, context);
    } }),
    defineBinding({ type: 'video.markPosted', request: () => { throw new PortError(400, 'VALIDATION', 'POST_LINK_REQUIRED', 'link'); } }),
    defineBinding({ type: 'promo.publishPlaceNews', request: ({ jobId, text }) =>
      ({ method: 'POST', path: publishPath(jobId, 'place-news'), body: { confirmed: true, text } }) }),
    defineBinding({ type: 'promo.publishClip', request: ({ jobId, description, hashtags, category, visibility, sponsored, commentsAllowed }) =>
      ({ method: 'POST', path: publishPath(jobId, 'clip'), body: { confirmed: true, description, hashtags, category, visibility, aiUsed: true, sponsored, commentsAllowed } }) }),
    defineBinding({ type: 'promo.attestLink', request: ({ jobId, route, link }) => {
      const checked = safeAttestationLink(link, route);
      if (!checked) throw new PortError(400, 'VALIDATION', 'POST_LINK_REQUIRED', 'link');
      return { method: 'POST', path: publishPath(jobId, 'attest'), body: { confirmed: true, extraConfirmed: true, route, link: checked } };
    } }),
  ],
};
