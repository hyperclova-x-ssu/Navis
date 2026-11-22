import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { createExamplePhotoSource } from '../../../frontend/server/promo/photo-source.mjs';
import { readBounded } from '../../../frontend/server/media/validation.mjs';
import { listen } from '../../infra/http.ts';
import { disposableReplayClock } from '../../packages/contracts/replay-clock.ts';
import { createSensSettingsReader } from './reality/15/sens-settings.ts';
import { dbPool, fileSecret, readSecret, requiredEnv } from '../../packages/db/index.ts';
import { promoSeedFileId } from '../../packages/contracts/promo-photos.ts';
import { createObjectStorage } from '../../packages/object-storage/index.ts';
import type { NaverBinding } from '../../packages/naver/config/index.ts';
import { createNaverTransport } from '../../packages/naver/transport/index.ts';
import { createArtifactClient } from '../../workers/marketing-worker/promo/clients.ts';
import { demoIdentity } from '../account/identity.ts';
import { createPersonaOwnerGrants } from '../account/naver/persona-grants.ts';
import { pn17Cafe } from './reality/13/cafe.ts';
import { createInsightNaver } from '../insight/naver/index.ts';
import { connectStreams } from '../../packages/streams/index.ts';
import { createFixtureSms, createMarketingApp, fixtureStore } from './app.ts';
import { couponLedger } from './coupon-ledger.ts';
import { couponRecommendations } from './coupon-recommendations.ts';
import { createMarketingProvider, OPERATIONS, registerTalkTalkInbound } from './naver/index.ts';
import { createSearchPort } from './naver/pn10-search.ts';
import { PromoRouteError } from './promo/jobs.ts';
import { sha256 } from './promo/contracts.ts';
import { createPromoMenuPriceRead } from './promo/menu-facts.ts';
import { bundledMenuPhotos } from './promo/bundled-photos.ts';
import { maxPhotoBytes, photoContentUrl, readPromoPhotoAliases } from './promo/photo-assets.ts';
import { createHttpCouponSources, createPosBillReader } from './reality/14/clients.ts';
import { createPersonaCouponPort } from './reality/14/coupon-provider.ts';
import { couponPosHandlers } from './reality/14/redemptions.ts';
import { createClosureReader } from './reality/15/closure.ts';
import { navisReviewDraft, scheduledSmsProvider } from './reality/15/gap-providers.ts';
import { createTalkTalkInbox } from './reality/15/inbox.ts';
import { createTalkTalkDraftPorts } from './reality/15/talktalk-draft.ts';
import { createVirtualNoticeMarketing } from './reality/15/notice-marketing.ts';
import type { Review } from './reality/15/ports.ts';
import { createNoticeRecipients } from './reality/15/recipients.ts';
import { NoticeError } from './reality/15/wire.ts';
import { createPromoCatalog } from './reality/16/catalog.ts';
import { assetColumns, type Asset } from './reality/16/state.ts';
import type { PromoRealityOptions } from './reality/16/routes.ts';
import { localPosHandlers } from './reality/13/pos.ts';
import { configureSeoulPublic } from './reality/13/seoul-public.ts';
import { startSeoulRefresh } from './reality/13/seoul-refresh.ts';
import { createLiveSearchSources } from './reality/13/ncp-search.ts';
import { createTrendMenuReader } from './reality/13/trend-menu.ts';
import { configureTrendHcx } from './reality/13/trend-hcx.ts';
import { pn10SearchInterest } from './reality/13/sources.ts';
import { createMarketingStreamConsumers, mergeStreamHandlers } from './reality/19/consumers.ts';
import type { ReplyQueue, TodaySources } from './reality/19/ports.ts';
import { createGroupMemberCodeReader } from './reality/19/routes.ts';
import { inStore } from './transaction.ts';

const pool = dbPool('marketing');
const photoStorage = createObjectStorage();
const replayNow = disposableReplayClock();
const phase3 = process.env.NAVIS_PHASE3_FIXTURES === '1';
const gatewayToken = phase3 || process.env.NAVIS_GATEWAY_MARKETING_TOKEN_FILE
  ? fileSecret('NAVIS_GATEWAY_MARKETING_TOKEN_FILE')
  : undefined;
const {
  NAVIS_NAVER_VIRTUAL_ORIGIN: origin,
  NAVIS_NAVER_VIRTUAL_TOKEN_FILE: privateTokenFile,
  NAVIS_NAVER_VIRTUAL_STORE_ID: storeId,
  NAVIS_NAVER_VIRTUAL_ACCOUNT_ID: providerAccount,
} = process.env;
if ((storeId || providerAccount) && (storeId !== fixtureStore || !providerAccount || !origin || !privateTokenFile)) {
  throw new Error('Incomplete private Marketing provider configuration');
}
const providerOperations = [
  ['pn03.reviews.list', 'GET', /\/partner-assumed\/v1\/reviews/],
  ['pn03.reviews.get', 'GET', /\/partner-assumed\/v1\/reviews\/[A-Za-z0-9_-]{1,64}/],
  ['pn03.stats.read', 'GET', /\/partner-assumed\/v1\/review-statistics/],
  ['pn03.reply.draft', 'POST', /\/partner-assumed\/v1\/reviews\/[A-Za-z0-9_-]{1,64}\/reply-draft/],
  ['pn12.place', 'GET', /\/partner-assumed\/v1\/reports\/place/],
  ['pn12.blog', 'GET', /\/partner-assumed\/v1\/reports\/blog/],
  ['pn12.clip', 'GET', /\/partner-assumed\/v1\/reports\/clip/],
] as const;
const credentialsDir = process.env.NAVIS_NAVER_VIRTUAL_PROVIDER_CREDENTIALS_DIR;
const talkTalkCallbackFile = process.env.NAVIS_NAVER_VIRTUAL_TALKTALK_CALLBACK_TOKEN_FILE;
const talkTalkCallbackToken = talkTalkCallbackFile ? readSecret(talkTalkCallbackFile) : undefined;
const talkTalkCredentialFile = credentialsDir && join(credentialsDir, 'nvirtual_talktalk');
if (talkTalkCallbackToken && (!storeId || !privateTokenFile || !talkTalkCredentialFile
  || [gatewayToken, readSecret(privateTokenFile), readSecret(talkTalkCredentialFile)].includes(talkTalkCallbackToken))) {
  throw new Error('TalkTalk callback requires a configured store and a distinct workload credential');
}
const searchPort = process.env.NAVIS_NCP_APIHUB_PROVIDER === 'fake' && storeId && providerAccount && origin && privateTokenFile && credentialsDir ? createSearchPort({
  storeId, strict: true, transport: createNaverTransport({ bindings: (['pn10.trend', 'pn10.blog', 'pn10.cafearticle'] as const).map(operation => {
    const spec = OPERATIONS[operation];
    return {
      operation, grade: 'W', method: spec.method, route: spec.route,
      storeId, providerAccount, origin, privateTokenFile, mode: 'virtual', timeoutMs: 3_500,
      credentialFile: join(credentialsDir, 'nvirtual_hub_key'),
      authorize: (_request, key) => ({ 'x-ncp-apigw-api-key-id': readSecret(join(credentialsDir, 'nvirtual_hub_id')),
        'x-ncp-apigw-api-key': key }),
    } satisfies NaverBinding;
  }) }),
}) : undefined;
function searchFor(scope: string) {
  if (!searchPort || scope !== storeId) throw new Error('NAVER search is unavailable for this store');
  return searchPort;
}
const searchInterest = searchPort && pn10SearchInterest(searchFor);
const searchLinks = searchPort && (async (scope: string, channel: 'blog' | 'cafearticle', query: string) =>
  (await searchFor(scope).search(channel, { query, display: 10, signal: AbortSignal.timeout(4_000) })).result);
const studioFile = credentialsDir && join(credentialsDir, 'nvirtual_marketing_studio_key');
const gapProvider = storeId && providerAccount && origin && privateTokenFile && studioFile ? createMarketingProvider({
  storeId, providerAccount, virtualOrigin: origin, privateTokenFile, mode: 'virtual',
  operations: ['pn17.article.create', 'pn14.chat'], credentialFiles: { studio: studioFile },
  readCredential(path) { return path === studioFile ? JSON.stringify({ apiKey: readSecret(path) }) : readSecret(path); },
}) : undefined;
const grantOwner = { storeId: demoIdentity.storeId, actorId: demoIdentity.userId };
const cafeGrants = gapProvider && storeId && providerAccount && origin && privateTokenFile ? createPersonaOwnerGrants({
  owner: grantOwner, scopes: ['cafe'], now: replayNow, bindings: [{
    storeId, providerAccount, origin, privateTokenFile, mode: 'virtual', grade: 'P', method: 'POST',
    operation: 'pn11.fixture.owner-grant', route: /^\/partner-assumed\/v1\/fixture\/owner-grants$/, timeoutMs: 2_000,
  }],
}) : undefined;
const cafe = gapProvider && cafeGrants ? pn17Cafe({
  mode: 'virtual', forOwner: () => gapProvider,
  async grantFor(scope) {
    if (scope.storeId !== grantOwner.storeId || scope.actorId !== grantOwner.actorId) return null;
    return { accessToken: await cafeGrants.resolve(scope, 'cafe'), boards: [{ clubid: '10000001', menuid: '1' }] };
  },
}) : undefined;
const naver = storeId && providerAccount && origin && privateTokenFile ? createInsightNaver(createNaverTransport({
  bindings: providerOperations.map(([operation, method, route]): NaverBinding => ({
    operation, method, route, storeId, providerAccount, origin, privateTokenFile, mode: 'virtual', grade: 'O', timeoutMs: 2_000,
  })),
})) : undefined;
const noticeProvider = storeId && providerAccount && origin && privateTokenFile ? createVirtualNoticeMarketing({
  storeId, providerAccount, virtualOrigin: origin, privateTokenFile, now: replayNow,
  talkTalkCredentialFile, enableTalkTalkReply: Boolean(talkTalkCallbackToken),
}) : undefined;
function confirmed(readBack: 'confirmed' | 'pending') {
  if (readBack !== 'confirmed') throw new NoticeError(409, 'PROVIDER_READBACK_PENDING');
  return { state: 'saved' as const };
}
function scopedNotices(scope: string) {
  if (!noticeProvider || scope !== storeId) throw new NoticeError(503, 'PROVIDER_UNAVAILABLE');
  return noticeProvider;
}
function reviewView(row: Awaited<ReturnType<NonNullable<typeof naver>['review']>>): Review {
  return { ...row, media: row.media.map(({ type, url }) => ({ type: type === 'photo' ? 'photo' : 'video', url })) };
}
const localCommandFile = process.env.NAVIS_GATEWAY_MARKETING_LOCAL_COMMAND_TOKEN_FILE;
const localToken = localCommandFile && readSecret(localCommandFile);
const briefingFile = process.env.NAVIS_INSIGHT_MARKETING_READ_TOKEN_FILE;
const communityFile = process.env.NAVIS_MARKETING_COMMUNITY_ACCOUNT_TOKEN_FILE;
const communityToken = communityFile && readSecret(communityFile);
const communityAccount = communityToken && new URL(requiredEnv('NAVIS_ACCOUNT_BASE_URL'));
const scheduleFile = process.env.NAVIS_MARKETING_CUSTOMER_READ_TOKEN_FILE;
const scheduleToken = scheduleFile && readSecret(scheduleFile);
const smsRecipientFile = process.env.NAVIS_MARKETING_CUSTOMER_SMS_TOKEN_FILE;
const smsWorkerFile = process.env.NAVIS_MARKETING_SMS_WORKER_TOKEN_FILE;
const smsRecipientToken = smsRecipientFile && readSecret(smsRecipientFile);
const smsWorkerToken = smsWorkerFile && readSecret(smsWorkerFile);
if (Boolean(smsRecipientToken) !== Boolean(smsWorkerToken) || (smsWorkerToken && (!storeId || !gatewayToken))) {
  throw new Error('Incomplete private notice SMS configuration');
}
const customer = (scheduleToken || smsRecipientToken) && new URL(requiredEnv('NAVIS_MARKETING_CUSTOMER_URL'));
const couponTokenFiles = ['CUSTOMER', 'INVENTORY', 'POS'].map(service => process.env[`NAVIS_MARKETING_${service}_TOKEN_FILE`]);
const couponTokens = couponTokenFiles.flatMap(file => file ? [readSecret(file)] : []);
if (couponTokens.length && (couponTokens.length !== 3 || new Set(couponTokens).size !== 3
  || couponTokens.some(token => [gatewayToken, localToken, communityToken, scheduleToken].includes(token)))) {
  throw new Error('Marketing coupon source credentials must be complete and distinct');
}
const [customerCouponToken, inventoryCouponToken, posCouponToken] = couponTokens;
if (smsRecipientToken && [smsWorkerToken, gatewayToken, localToken, communityToken, scheduleToken, ...couponTokens].includes(smsRecipientToken)) {
  throw new Error('The Customer SMS recipient credential must be distinct');
}
const accountUrl = process.env.NAVIS_ACCOUNT_BASE_URL;
const artifactFile = process.env.NAVIS_MARKETING_ACCOUNT_TOKEN_FILE;
const liveSms = process.env.NAVIS_NCP_SENS_PROVIDER === 'live';
const readSensSettings = liveSms && accountUrl && artifactFile
  ? createSensSettingsReader(new URL(accountUrl), readSecret(artifactFile)) : undefined;
const readSmsCustomer = customer && smsRecipientToken
  ? (scope: string, body: { memberIds: string[]; purpose: 'advertising' | 'informational' }) =>
    fetch(new URL(`/internal/v1/customer/stores/${scope}/sms-recipients`, customer), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
    headers: { authorization: `Bearer ${smsRecipientToken}`, 'x-navis-store-id': scope, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) : undefined;
const noticeRecipients = readSmsCustomer ? createNoticeRecipients({
  pool, senderNumber: '01000000000', now: replayNow, readCustomer: readSmsCustomer,
}) : undefined;
const scheduledSms = noticeRecipients && (!liveSms || readSensSettings) ? scheduledSmsProvider({
  mode: liveSms ? 'live' : 'virtual', recipients: (scope, group, advertising) => scope.storeId === storeId
    ? noticeRecipients(scope, group, advertising) : Promise.resolve(null),
  settings: readSensSettings,
  couponRecipient: liveSms && readSmsCustomer ? async (scope, memberId) => {
    if (scope !== storeId) return null;
    const response = await readSmsCustomer(scope, { memberIds: [memberId], purpose: 'advertising' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Coupon consent lookup unavailable'); }
    const result = await response.json() as { items?: { memberId: string; phone: string }[] };
    return result.items?.find(item => item.memberId === memberId)?.phone ?? null;
  } : undefined,
}) : undefined;
const naverCoupon = storeId && providerAccount && origin && privateTokenFile
  ? createPersonaCouponPort({ storeId, providerAccount, virtualOrigin: origin, privateTokenFile }) : undefined;
const coupons = customerCouponToken && inventoryCouponToken && posCouponToken ? {
  sources: createHttpCouponSources({
    customerUrl: requiredEnv('NAVIS_MARKETING_CUSTOMER_URL'), customerToken: customerCouponToken,
    inventoryUrl: requiredEnv('NAVIS_MARKETING_INVENTORY_URL'), inventoryToken: inventoryCouponToken,
  }),
  pos: createPosBillReader(requiredEnv('NAVIS_MARKETING_POS_URL'), posCouponToken),
  naver: (scope: string) => scope === storeId ? naverCoupon ?? null : null,
  naverWriteMode: naverCoupon ? 'fake' as const : undefined,
  smsSettings: liveSms ? async (scope: string) => scope === storeId ? await readSensSettings?.(scope) ?? null : null : undefined,
} : undefined;
const listPeers = communityAccount && communityToken ? async (storeId: string) => {
  const response = await fetch(new URL(`/internal/v1/account/stores/${storeId}/community-peers`, communityAccount), {
    headers: { authorization: `Bearer ${communityToken}` }, redirect: 'error', signal: AbortSignal.timeout(2500),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Community participation lookup unavailable');
  }
  const wire: { items: { storeId: string; displayName: string }[] } = await response.json();
  return wire.items;
} : undefined;
const readClosure = customer && scheduleToken ? createClosureReader(({ storeId, actorId }, eventId) =>
  fetch(new URL(`/internal/v1/customer/stores/${storeId}/calendar/events/${eventId}`, customer), {
    headers: { authorization: `Bearer ${scheduleToken}`, 'x-navis-store-id': storeId, 'x-navis-user-id': actorId,
      'x-navis-store-role': 'owner' }, redirect: 'error', signal: AbortSignal.timeout(2500),
  })) : undefined;
const artifacts = accountUrl && artifactFile ? createArtifactClient({ baseUrl: accountUrl, token: readSecret(artifactFile) }) : undefined;
let promo: Omit<PromoRealityOptions, 'gatewayToken'> | undefined;
if (accountUrl && artifactFile && artifacts) {
  const account = new URL(accountUrl);
  const token = readSecret(artifactFile);
  const source = createExamplePhotoSource({ sourceId: 'cafe' });
  const catalog = source.listCatalog();
  const venue = { ...catalog, store: { ...catalog.store, location: catalog.store.location.split(' (')[0] } };
  const seed = source.listPhotoIds().map(photoId => ({ ...source.photoInfo(photoId)!, fileId: promoSeedFileId(fixtureStore, photoId) }));
  const menuIds = new Map(bundledMenuPhotos.map(photo => [photo.legacyMenuId, photo.menuId]));
  const promoMenuIds = new Map(bundledMenuPhotos.map(photo => [photo.menuId, photo.legacyMenuId]));
  const read = async (owner: { storeId: string; actorId: string }, path: string, body = {}) => {
    const response = await fetch(new URL(`/internal/v1/account/stores/${owner.storeId}/promo-input/${path}`, account), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(2500),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, actorId: owner.actorId }),
    });
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 404) return null;
    throw new Error('Promo photo lookup unavailable');
  };
  promo = {
    artifacts,
    photoUpload: photoStorage && {
      storage: photoStorage,
      catalogMenuId: menuId => menuIds.get(menuId) ?? menuId,
      promoMenuId: menuId => promoMenuIds.get(menuId) ?? menuId,
      async read(owner, fileId) {
        const photo = await read(owner, `${fileId}/bytes`);
        if (!photo?.body) return null;
        return {
          width: Number(photo.headers.get('x-navis-photo-width')),
          height: Number(photo.headers.get('x-navis-photo-height')),
          contentType: photo.headers.get('content-type') ?? '',
          bytes: await readBounded(photo.body, maxPhotoBytes),
        };
      },
    },
    readMenuPrice: inventoryCouponToken
      ? createPromoMenuPriceRead(requiredEnv('NAVIS_MARKETING_INVENTORY_URL'), inventoryCouponToken) : undefined,
    ...createPromoCatalog({
      async photos(owner, uploads, db) {
        const uploaded = uploads.map(row => ({ ...row, photoId: row.assetId.replaceAll('-', '') }));
        const uploadIds = uploaded.flatMap(row => row.photoAssetId ? [row.photoAssetId] : []);
        const readAliases = (client: PoolClient) => readPromoPhotoAliases(client, owner.storeId, uploadIds);
        const aliases = photoStorage && (db ? await readAliases(db) : await inStore(pool, owner.storeId, readAliases));
        const candidates = photoStorage ? uploaded : [...seed.map(row => ({ ...row, photoAssetId: undefined })), ...uploaded];
        const ready = new Set<string>();
        for (let offset = 0; offset < candidates.length; offset += 160) {
          const fileIds = candidates.slice(offset, offset + 160).map(row => row.fileId);
          const result = await read(owner, 'ready', { fileIds });
          const values: unknown = result && (await result.json()).fileIds;
          if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('Invalid ready photo response');
          values.forEach(fileId => ready.add(fileId));
        }
        const storedSeed = aliases ? seed.flatMap(row => {
          const asset = aliases.get(row.photoId);
          if (!asset) return [];
          return [{ ...row, width: asset.width, height: asset.height, contentUrl: photoContentUrl(owner.storeId, asset.photoId),
            binding: { fileId: row.fileId, resourceId: row.photoId, photoAssetId: asset.photoId, sha256: asset.sha256 } }];
        }) : [];
        return [...storedSeed, ...candidates.filter(row => ready.has(row.fileId)).map(row => {
          const asset = aliases && row.photoAssetId ? aliases.get(row.photoAssetId) : undefined;
          return { ...row, contentUrl: asset && photoContentUrl(owner.storeId, asset.photoId),
            binding: { fileId: row.fileId, resourceId: row.photoId, photoAssetId: asset?.photoId, sha256: asset?.sha256 } };
        })];
      },
      async verifyUpload(owner, fileId) {
        const photo = await read(owner, `${fileId}/bytes`);
        if (!photo) return null;
        const width = Number(photo.headers.get('x-navis-photo-width'));
        const height = Number(photo.headers.get('x-navis-photo-height'));
        await photo.body?.cancel();
        return { width, height };
      },
    }, async owner => owner.storeId === fixtureStore ? venue : null),
    async bindPhoto(owner, photoId, binding) {
      if (binding.photoAssetId) return binding;
      const photo = await read(owner, `${binding.fileId}/bytes`);
      if (!photo) throw new PromoRouteError(409, 'PROMO_SELECTION_UNAVAILABLE');
      const mime = photo.headers.get('content-type') ?? '';
      const bytes = Buffer.from(await photo.arrayBuffer());
      const fileId = await artifacts.put({ storeId: owner.storeId, resourceId: photoId }, binding.fileId, 'promo_input', mime, bytes);
      return { resourceId: photoId, fileId, sourceFileId: binding.fileId, sha256: sha256(bytes) };
    },
  };
}
if (photoStorage && (!gatewayToken || !smsWorkerToken || !promo)) {
  throw new Error('Marketing object storage requires configured gateway, worker, and promo account workloads');
}
const promoForGroups = promo;
const today: TodaySources = {
  ...(inventoryCouponToken && couponRecommendations(requiredEnv('NAVIS_MARKETING_INVENTORY_URL'), inventoryCouponToken)),
  async replies(db, scope) {
    const { rows: [queue] } = await db.query<ReplyQueue>(`
      SELECT count(*)::integer AS waiting,
             count(*) FILTER (WHERE status='draft_ready')::integer AS "withDraft",
             (array_agg(id ORDER BY updated_at, id))[1] AS "firstWaitingId",
             (array_agg(id ORDER BY updated_at, id) FILTER (WHERE status='draft_ready'))[1] AS "firstDraftId"
      FROM marketing.reply_notice_record WHERE store_id=$1 AND kind='inquiry' AND status IN ('waiting','draft_ready')`, [scope]);
    return queue;
  },
  assets: promoForGroups && (async (db, scope, day, actorId) => {
    const { rows: stored } = await db.query<Asset>(
      `SELECT ${assetColumns} FROM marketing.promo_asset WHERE store_id=$1`, [scope]);
    const snapshot = await promoForGroups.catalogForOwner({ storeId: scope, actorId }, stored, db);
    if (!snapshot) throw new Error('Approved promo catalog unavailable');
    const photos = snapshot.catalog.photos.filter(photo => photo.menuId !== null);
    const { rows: [publication] } = await db.query<{ count: number }>(`
      SELECT count(DISTINCT job_id)::integer AS count FROM marketing.promo_publication WHERE store_id=$1 AND state='published'
        AND (created_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN date_trunc('week',$2::date)::date AND $2::date`, [scope, day]);
    return { eligiblePhotos: photos.length, postedVideos: publication.count, firstAssetId: photos[0]?.photoId ?? null };
  }),
};
const seoulPublic = await configureSeoulPublic(process.env);
const app = createMarketingApp(pool, phase3 && gatewayToken ? {
  promoToken: fileSecret('NAVIS_INSIGHT_MARKETING_TOKEN_FILE'),
  readToken: gatewayToken,
  confirmSmsToken: fileSecret('NAVIS_GATEWAY_SMS_CONFIRM_TOKEN_FILE'),
  sms: createFixtureSms(fileSecret('NAVIS_FIXTURE_SMS_KEY_FILE'), process.env.NAVIS_FIXTURE_SMS_ENABLED === '1'),
  artifacts: artifacts ?? createArtifactClient({
    baseUrl: requiredEnv('NAVIS_ACCOUNT_BASE_URL'), token: fileSecret('NAVIS_MARKETING_ACCOUNT_TOKEN_FILE'),
  }),
} : undefined, gatewayToken, gatewayToken && localToken ? {
  readToken: gatewayToken, briefingToken: briefingFile && readSecret(briefingFile),
  local: { commandToken: localToken, listPeers, ...createLiveSearchSources(process.env, { searchInterest, searchLinks }),
    trendMenu: inventoryCouponToken ? createTrendMenuReader(requiredEnv('NAVIS_MARKETING_INVENTORY_URL'), inventoryCouponToken) : undefined,
    chooseTrendCandidates: configureTrendHcx(process.env, gapProvider),
    cafe, now: replayNow, canOffer: listPeers && (async (senderStoreId, recipientStoreId) =>
    (await listPeers(senderStoreId)).some(peer => peer.storeId === recipientStoreId)) },
  notice: { readClosure, now: replayNow, scheduledSms, smsWorkerToken, talkTalkDraft: createTalkTalkDraftPorts(pool, process.env, replayNow), navisReviewDraft: gapProvider && navisReviewDraft(() => gapProvider), provider: naver && {
    mode: 'virtual',
    async reviews({ storeId }, { view, ...filter }) {
      const result = await naver.reviews(storeId, view === 'venue' ? { scope: 'venue' } : { ...filter, scope: 'booking' });
      return { ...result, items: result.items.map(reviewView) };
    },
    async review({ storeId }, ref) { return reviewView(await naver.review(storeId, ref)); },
    reviewStatistics: ({ storeId }, period) => naver.reviewStatistics(storeId, { period }),
    reviewDraft: ({ storeId }, { ref, ...draft }) => naver.reviewDraft(storeId, ref, draft),
    async reviewReply({ storeId }, { operation, effectId: attemptKey, ref: reviewRef, text }) {
      const { reply } = scopedNotices(storeId);
      const input = { reviewRef, attemptKey, text };
      if (operation === 'delete') return confirmed((await reply.remove({ reviewRef, attemptKey, confirmation: 'confirmed-twice' })).readBack);
      return confirmed((await (operation === 'create' ? reply.post(input) : reply.update(input))).readBack);
    },
    news: ({ storeId }) => scopedNotices(storeId).news.list(),
    async publishNews({ storeId }, { effectId: attemptKey, pin, title, text }) {
      const result = await scopedNotices(storeId).news.create({ attemptKey, title, text, pin: pin && { to: pin.to, order: pin.order } });
      return { ...confirmed(result.readBack), providerRef: result.news.ref };
    },
    async deleteNews({ storeId }, { ref, effectId: attemptKey }) {
      return confirmed((await scopedNotices(storeId).news.remove({ ref, attemptKey, confirmation: 'confirmed-twice' })).readBack);
    },
    consultation: ({ storeId }, ref) => scopedNotices(storeId).talktalk.getConsultation(ref),
    async consultations({ storeId }, { from, to, status, cursor }) {
      if (cursor !== undefined && !/^(0|[1-9]\d{0,6})$/.test(cursor)) throw new NoticeError(400, 'INVALID_REQUEST');
      const offset = cursor === undefined ? 0 : Number(cursor);
      const limit = 50;
      const { items } = await scopedNotices(storeId).talktalk.listConsultations({ from, to, status, offset, limit });
      return { items: items.map(({ ref, status }) => ({ ref, status })), nextCursor: items.length === limit ? String(offset + limit) : null };
    },
    talkTalkReply: talkTalkCallbackToken ? async ({ storeId }, { user, text, effectId: attemptKey }) => {
      if (!user) throw new NoticeError(409, 'TALKTALK_REPLY_UNAVAILABLE');
      return scopedNotices(storeId).talktalk.sendReply({ user, text, attemptKey });
    } : undefined,
    audiences: ({ storeId }) => scopedNotices(storeId).talktalkMarketing.audiences(),
    campaign: ({ storeId }, input) => scopedNotices(storeId).campaign(input),
  } }, promo, photos: { storage: photoStorage, workerToken: photoStorage ? smsWorkerToken || undefined : undefined },
  coupons: coupons && { ...coupons, now: replayNow },
  groups: { channels: naver, today, coupons: coupons && couponLedger, now: replayNow,
    memberCodes: customerCouponToken
      ? createGroupMemberCodeReader(requiredEnv('NAVIS_MARKETING_CUSTOMER_URL'), customerCouponToken) : undefined },
} : undefined);
if (storeId && talkTalkCallbackToken) registerTalkTalkInbound(app, {
  mode: 'virtual', callbackToken: talkTalkCallbackToken, onEvent: createTalkTalkInbox(pool, storeId),
});
pool.on('error', () => app.log.warn('Idle database connection closed unexpectedly'));
let stopSeoulRefresh: ReturnType<typeof startSeoulRefresh> | undefined;
if (seoulPublic) app.addHook('onReady', async () => {
  stopSeoulRefresh = startSeoulRefresh(pool, seoulPublic, fixtureStore, dataset =>
    app.log.warn({ dataset }, 'Seoul public data refresh unavailable'));
});
const stop = new AbortController();
const redis = process.env.NAVIS_REDIS_URL ? await connectStreams('marketing') : undefined;
const workers = redis ? createMarketingStreamConsumers(pool, redis, `marketing-${randomUUID()}`, {
  pos: mergeStreamHandlers(localPosHandlers, couponPosHandlers),
})
  .map(consumer => consumer.run(stop.signal)) : [];
app.addHook('onClose', async () => {
  stop.abort();
  await stopSeoulRefresh?.();
  await Promise.all(workers);
  redis?.close();
  await pool.end();
});
await listen(app);
