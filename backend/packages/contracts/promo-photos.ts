import { createHash } from 'node:crypto';

export function promoSeedFileId(storeId: string, photoId: string) {
  const digest = createHash('sha256').update(JSON.stringify([storeId, photoId])).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
