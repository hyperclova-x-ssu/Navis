export const talkTalkSources = {
  chatbot: 'https://github.com/navertalk/chatbot-api/blob/master/README.md',
  consultations: 'https://help.naver.com/service/11830/contents/3614?lang=ko',
  period: 'https://help.naver.com/service/11830/contents/23823?osType=COMMONOS',
  tabs: 'https://help.naver.com/service/11830/contents/24283?osType=COMMONOS',
} as const;

export const talkTalkReplyPath = '/chatbot/v1/event';
export const talkTalkWebhookPath = '/internal/v1/naver/talktalk/webhook';
export const talkTalkConsultationTabs = ['waiting', 'in-progress', 'on-hold', 'completed', 'blocked', 'spam'] as const;
export type Consultation = {
  ref: string;
  status: typeof talkTalkConsultationTabs[number];
  /** Owner-visible conversation projection. Exact partner field schema is unconfirmed (미확인). */
  messages: { text: string }[];
};

// Published TalkTalk Chat Bot API V1. This binding selects the text-only reply case.
export type TalkTalkReply = { event: 'send'; user: string; textContent: { text: string }; options?: { notification: false } };
export type TalkTalkEvent =
  | { event: 'send'; user: string; textContent: { text: string; inputType: 'typing' } }
  | { event: 'echo'; echoedEvent: 'send'; user: string; partner: string; textContent: { text: string; inputType?: string }; options?: { mobile: boolean } };
export type TalkTalkResult =
  | { success: true; resultCode: '00' }
  | { success: false; resultCode: '01' | '02' | '99'; resultMessage?: string };
