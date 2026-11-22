import { commandHeaders, json, list, object, ownerRequest, text, type NaverTransport,
  type OwnerApproval, type OwnerContext } from './wire.ts';

const place = '/partner-assumed/v1/place';

function venueView(value: unknown) {
  const row = object(value);
  return { name: text(row.name), address: text(row.address), phone: text(row.phone), keywords: list(row.keywords, text), photos: list(row.photos, text) };
}

// https://help.naver.com/service/30026/contents/20366?lang=ko
// https://help.naver.com/service/30026/contents/20379?lang=ko
// https://help.naver.com/service/30026/contents/20394?lang=ko
export function createAccountNaver(transport: NaverTransport, verifyPhotos: (ctx: OwnerContext, photos: readonly string[]) => Promise<void>) {
  return {
    async venue(ctx: OwnerContext) {
      return venueView(await json(ownerRequest(transport, ctx)('pn01.place.read', place)));
    },
    async updateVenue(ctx: OwnerContext, card: OwnerApproval, patch: Partial<ReturnType<typeof venueView>>) {
      const headers = commandHeaders(card);
      const { name, address, phone, keywords, photos } = patch;
      const approvedPhotos = photos?.slice();
      if (approvedPhotos?.length) await verifyPhotos(ctx, approvedPhotos);
      return venueView(await json(ownerRequest(transport, ctx)('pn01.place.update', place, {
        headers, body: JSON.stringify({ name, address, phone, keywords, photos: approvedPhotos }),
        approvalScope: { actorId: ctx.actorId },
      })));
    },
  };
}

export { createNaverLogin, createOwnerGrantResolver } from './oauth.ts';
export { createNaverObjectStorage, createObjectStorageSigner } from './storage.ts';
export { createCommerceTokenExchange } from './commerce.ts';

export { createPersonaOwnerGrants } from './persona-grants.ts';
