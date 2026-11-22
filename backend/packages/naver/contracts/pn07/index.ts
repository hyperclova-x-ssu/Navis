export const campaignSources = {
  campaign: 'https://help.naver.com/service/30026/contents/20507?lang=ko&osType=COMMONOS',
  attachment: 'https://help.naver.com/service/30026/contents/21111?lang=ko',
} as const;

export const campaignAudiences = ['benefit-subscribers', 'recent-visitor-reviewers'] as const;
export type CampaignAudience = typeof campaignAudiences[number];
export type CampaignAudiences = {
  items: { audience: CampaignAudience }[];
  /** Monthly assigned allowance. Consumption per accepted Place campaign is unconfirmed. */
  quota?: { month: string; assigned: number };
};
export type CampaignSend = { audience: CampaignAudience; title: string; body: string; couponRef?: string };
