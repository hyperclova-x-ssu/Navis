import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { createExamplePhotoSource } from '../../../frontend/server/promo/photo-source.mjs';
import { createPromoService } from '../../../frontend/server/promo/service.mjs';
import { INPUT, refs } from '../../../frontend/server/promo/test/helpers.mjs';
import { mountBrowserMiddleware, promoBrowserRoutes } from '../../infra/browser-api.ts';
import { createApp } from '../../infra/http.ts';
import { allowWorkloadReads, briefingReadPaths } from '../../packages/contracts/workload-read.ts';
import { demoIdentity } from '../account/identity.ts';
import type { CatalogSnapshot, PromoArtifacts } from './promo/contracts.ts';
import { registerPromoRoutes } from './promo/routes.ts';
import { registerPhotoReads } from './promo/photo-routes.ts';
import { registerLocalMarketingRoutes, type LocalOptions } from './reality/13/routes.ts';
import { registerCouponRoutes, type CouponRouteOptions } from './reality/14/routes.ts';
import { registerNoticeApprovals, verifyNoticeApproval } from './reality/15/approval.ts';
import type { NoticeReplyOptions } from './reality/15/ports.ts';
import { registerNoticeReplyRoutes } from './reality/15/routes.ts';
import { registerPromoReality, type PromoRealityOptions } from './reality/16/routes.ts';
import { registerGroupsPerformanceRoutes, type GroupsPerformanceOptions } from './reality/19/routes.ts';
import { registerSensRoutes, sensAttemptsPath } from './sens/routes.ts';
import type { OwnerScope, SensCard, SensPolicy } from './sens/policy.ts';

export const fixtureStore = demoIdentity.storeId;
const fixtureOwner = demoIdentity.userId;
const targetId = 'local-test';
const approvedBody = 'Thank you for visiting our cafe.';
const draftLifetime = 10 * 60_000;

export function createFixtureSms(key: string, enabled: boolean) {
  function sign(value: string) {
    return createHmac('sha256', key).update(value).digest('hex');
  }

  const proposalFor = (draftId: string) =>
    sign(`proposal:${draftId}`).slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  const owner = ({ actorId, storeId }: OwnerScope) => storeId === fixtureStore && actorId === fixtureOwner;
  const issue = (scope: OwnerScope): SensCard | null => {
    if (!enabled || !owner(scope)) return null;
    const time = String(Date.now());
    const draftId = `${time}_${sign(`draft:${time}`)}`;
    return { source: 'card', proposalId: proposalFor(draftId), snapshotRevision: 1,
      input: { draftId, targetId, body: approvedBody } };
  };

  const policy: SensPolicy = {
    async settingsForStore(storeId) {
      return storeId === fixtureStore && enabled ? {
        enabled, credentials: { serviceId: 'fake', accessKey: 'fake', secretKey: key, senderNumber: '00000000001' },
        targets: new Map([[targetId, { number: '00000000002', consentSms: true }]]),
      } : null;
    },
    async draftForOwner(scope, draftId) {
      if (!owner(scope)) return null;
      const match = /^(\d{13})_([a-f0-9]{64})$/.exec(draftId);
      if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(sign(`draft:${match[1]}`)))) return null;
      const issuedAt = Number(match[1]);
      if (issuedAt > Date.now()) return null;
      return { sampleId: 'local-reply', sessionId: proposalFor(draftId),
        expiresAt: new Date(issuedAt + draftLifetime), approved: [approvedBody] };
    },
  };

  return { policy, issue, matchesCard(card: Partial<SensCard> | null | undefined) {
    const draftId = card?.input?.draftId;
    return card?.snapshotRevision === 1 && typeof draftId === 'string' && card.proposalId === proposalFor(draftId);
  } };
}

export function createMarketingApp(database: Pool, options?: {
  promoToken: string; readToken: string; confirmSmsToken: string; artifacts: PromoArtifacts;
  sms: ReturnType<typeof createFixtureSms>;
}, browserToken?: string, records?: {
  readToken: string; local?: Omit<LocalOptions, 'readToken'>;
  notice?: Pick<NoticeReplyOptions, 'provider' | 'readClosure' | 'now' | 'navisReviewDraft' | 'talkTalkDraft' | 'scheduledSms' | 'smsWorkerToken'>;
  briefingToken?: string;
  coupons?: Omit<CouponRouteOptions, 'gatewayToken'>;
  promo?: Omit<PromoRealityOptions, 'gatewayToken'>;
  photos?: Omit<Parameters<typeof registerPhotoReads>[2], 'gatewayToken' | 'bundledStoreId'>;
  groups?: Pick<GroupsPerformanceOptions, 'channels' | 'today' | 'coupons' | 'now' | 'memberCodes'>;
}) {
  // W5 serves the fixture catalog and assets. Render tools and live keys stay off until A6.
  const promo = browserToken ? createPromoService({
    originAllowed: () => true, tools: {},
    env: { NAVIS_PROMO_DIR: process.env.NAVIS_PROMO_DIR, NAVIS_PROMO_HCX_PILOT: 'false' },
  }) : undefined;
  const app = createApp('marketing', async () => {
    const readiness = records ? 'SELECT 1 FROM marketing.notice_reply_approval LIMIT 0'
      : options ? 'SELECT 1 FROM marketing.promo_job LIMIT 0' : 'SELECT 1';
    await Promise.all([database.query(readiness), promo?.ready]);
  });
  if (promo && browserToken) {
    const hidePhoto = Boolean(records?.photos?.storage);
    const hideReference = hidePhoto && process.env.NAVIS_OBJECT_STORAGE_MEDIA_ENABLED === '1';
    const middleware = Object.assign((req: Parameters<typeof promo>[0], res: Parameters<typeof promo>[1], next: () => void) => {
      const path = (req.url ?? '').split('?')[0];
      if ((hidePhoto && path.startsWith('/api/promo/photos/')) || (hideReference && path.startsWith('/api/promo/references/'))) {
        next();
        return Promise.resolve();
      }
      return promo(req, res, next);
    }, { close: () => promo.close() });
    mountBrowserMiddleware(app, browserToken, promoBrowserRoutes, middleware);
  }
  if (records) {
    const { readToken, briefingToken, local, notice } = records;
    const now = notice?.now ?? (() => new Date());
    if (local && [readToken, options?.promoToken, options?.confirmSmsToken].includes(local.commandToken)) {
      throw new Error('Marketing workload credentials must be distinct');
    }
    if (notice?.smsWorkerToken && [readToken, briefingToken, local?.commandToken, browserToken,
      options?.promoToken, options?.readToken, options?.confirmSmsToken].includes(notice.smsWorkerToken)) {
      throw new Error('The SMS worker credential must be distinct');
    }
    if (briefingToken) allowWorkloadReads(app, readToken, briefingToken, '/internal/v1/marketing/stores/:storeId',
      briefingReadPaths.marketing, [local?.commandToken, options?.promoToken, options?.confirmSmsToken]);
    if (local) registerLocalMarketingRoutes(app, database, { ...local, readToken });
    if (records.coupons) registerCouponRoutes(app, database, { ...records.coupons, gatewayToken: readToken });
    registerPhotoReads(app, database, { ...records.photos, gatewayToken: readToken, bundledStoreId: fixtureStore });
    registerNoticeApprovals(app, database, readToken, now);
    registerNoticeReplyRoutes(app, database, { ...notice, gatewayToken: readToken, verifyApproval: verifyNoticeApproval(now) });
    registerGroupsPerformanceRoutes(app, database, { ...records.groups, gatewayToken: readToken });
    if (records.promo) {
      const { references, artifacts } = records.promo;
      registerPromoReality(app, database, { ...records.promo, gatewayToken: readToken });
      if (!options) registerPromoRoutes(app, database, { readToken, references, artifacts });
    }
  }

  if (options) {
    const { artifacts, promoToken, readToken, confirmSmsToken, sms } = options;
    if (new Set([promoToken, readToken, confirmSmsToken]).size !== 3) {
      throw new Error('Marketing workload credentials must be distinct');
    }
    const photos = createExamplePhotoSource();
    const catalog: CatalogSnapshot['catalog'] = photos.listCatalog();
    type StoreParams = { storeId: string };
    const { exteriorPhotoId } = catalog.store;

    // Register only the smoke's synthetic inputs, under their stable fixture identities.
    registerPromoRoutes(app, database, {
      confirmToken: promoToken, readToken, references: refs, galleryReferences: records?.promo?.references, artifacts,
      async catalogForStore(storeId) {
        if (storeId !== fixtureStore) return null;
        const selected = [...INPUT.photoIds, exteriorPhotoId];
        const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXuoAAAAASUVORK5CYII=', 'base64');
        const bindings = await Promise.all(selected.map(async resourceId => [
          resourceId,
          { resourceId, fileId: await artifacts.put({ storeId, resourceId }, resourceId, 'promo_input', 'image/png', bytes) },
        ] as const));
        return {
          catalog: { ...catalog, menus: catalog.menus.filter(menu => INPUT.menuIds.includes(menu.menuId)),
            photos: catalog.photos.filter(photo => INPUT.photoIds.includes(photo.photoId)) },
          photos: Object.fromEntries(bindings), exterior: photos.photoInfo(exteriorPhotoId)!,
        };
      },
    });

    app.register(async routes => {
      routes.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store'); });
      routes.get<{ Params: StoreParams }>('/internal/v1/marketing/stores/:storeId/sens/test-card', async (req, reply) => {
        const supplied = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${readToken}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
          return reply.code(401).send({ code: 'UNAUTHENTICATED' });
        }
        const { storeId } = req.params;
        if (req.headers['x-navis-store-id'] !== storeId || req.headers['x-navis-store-role'] !== 'owner') {
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        const card = sms.issue({ storeId, actorId: String(req.headers['x-navis-user-id'] ?? '') });
        return card ?? reply.code(404).send({ code: 'NOT_FOUND' });
      });
      routes.addHook('preHandler', async (req, reply) => {
        if (req.method === 'POST' && req.routeOptions.url === sensAttemptsPath
          && !sms.matchesCard(req.body as SensCard | undefined)) {
          return reply.code(400).send({ code: 'BAD_REQUEST' });
        }
      });
      registerSensRoutes(routes, database, { confirmToken: confirmSmsToken, readToken, policy: sms.policy });
    });
  }
  return app;
}
