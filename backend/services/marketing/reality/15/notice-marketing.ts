import { createMarketingProvider, createNaverMarketing } from '../../naver/index.ts';
import type { FakeNoticeProvider } from './ports.ts';

type Binding = Pick<Parameters<typeof createMarketingProvider>[0],
  'storeId' | 'providerAccount' | 'virtualOrigin' | 'privateTokenFile' | 'now' | 'fetcher' | 'readCredential'>;
type Campaign = Parameters<NonNullable<FakeNoticeProvider['campaign']>>[1];

export function createVirtualNoticeMarketing(options: Binding & {
  talkTalkCredentialFile?: string;
  enableTalkTalkReply?: boolean;
}) {
  const { talkTalkCredentialFile, enableTalkTalkReply, ...binding } = options;
  const marketing = createNaverMarketing(createMarketingProvider({
    ...binding, mode: 'virtual',
    credentialFiles: talkTalkCredentialFile ? { talktalk: talkTalkCredentialFile } : undefined,
    operations: ['pn03.reviews.get', 'pn03.reply.create', 'pn03.reply.update', 'pn03.reply.delete',
      'pn04.news.list', 'pn04.news.get', 'pn04.news.create', 'pn04.news.delete', 'pn06.consultations.list', 'pn06.consultations.get',
      ...(enableTalkTalkReply ? ['pn06.chatbot.send'] as const : []), 'pn07.audiences.list', 'pn07.sends.create'],
  }), binding.now ? { clock: { now: binding.now } } : undefined);

  return {
    ...marketing,
    async campaign({ effectId, audience, title, body, couponRef }: Campaign) {
      await marketing.talktalkMarketing.send({ audience, title, body, couponRef: couponRef ?? undefined, attemptKey: effectId });
      return { state: 'accepted' as const };
    },
  };
}
