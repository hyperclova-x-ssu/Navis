import { readJson, type Transport } from './protocol.ts';
import { createStudioAndMedia } from './studio-media.ts';
import { createOwnerReads } from './owner-reads.ts';
import { createChannelReads } from './channels.ts';

export { searchAdsAuthorization } from './channels.ts';

export function createInsightNaver(transport: Transport, options: { now?: () => Date; receiptPath?: string } = {}) {
  const read = readJson(transport);
  return { ...createOwnerReads(read), ...createChannelReads(read), ...createStudioAndMedia(transport, options) };
}
