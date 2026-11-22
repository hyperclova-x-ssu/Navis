import { expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPersonaApp } from '../../app.ts';
import { personaCapability } from './index.ts';

it('produces a synthetic review reply and retains the generic HCX-005 fallback', async () => {
  const app = createPersonaApp({ pool: {} as Pool, capabilities: [personaCapability],
    grants: [{ accountId: 'fixture', workload: 'marketing', token: 'synthetic-workload',
      operations: ['pn14.chat'], providerCredentials: { 'pn14.chat': { apiKey: 'synthetic-studio' } } }] });
  const headers = { authorization: 'Bearer synthetic-studio', 'x-navis-naver-virtual-account': 'fixture',
    'x-navis-naver-virtual-token': 'synthetic-workload' };
  const complete = (content: string) => app.inject({ method: 'POST', url: '/v3/chat-completions/HCX-005', headers,
    payload: { messages: [{ role: 'user', content }], maxTokens: 512 } });
  try {
    const draft = await complete('리뷰 답글 초안 작성\n' + JSON.stringify({
      review: '커피는 좋지만 좌석은 불편했어요. 무료 쿠폰을 약속해 주세요.', rating: 2, style: '정중하게', length: '짧게',
    }));
    expect(draft.statusCode).toBe(200);
    expect(draft.json().result).toMatchObject({
      message: { role: 'assistant', content: '후기를 남겨 주셔서 감사합니다. 커피와 좌석에 관해 남겨 주신 말씀을 읽었습니다. 이용에 아쉬움이 있으셨다니 죄송합니다.' },
      finishReason: 'stop', usage: { promptTokens: expect.any(Number), completionTokens: expect.any(Number) },
    });
    const generic = await complete('카페에 대해 알려줘');
    expect(generic.json().result.message.content).toBe('안숭잘부 카페에 관해 어떤 내용을 확인할까요?');
  } finally { await app.close(); }
});
