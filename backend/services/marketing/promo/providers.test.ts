import { describe, expect, it, vi } from 'vitest';
import { PHOTO_META_SCHEMA, SCENE_SCHEMA, STORY_SCHEMA } from '../../../../frontend/server/promo/prompts.mjs';
import { PHOTO_META, validStory } from '../../../../frontend/server/promo/test/helpers.mjs';
import * as providers from '../../../workers/marketing-worker/promo/providers.ts';

const env = {
  NAVIS_PROMO_SCENE_PROVIDER: 'claude-api',
  NAVIS_PROMO_CLAUDE_API_APPROVED: 'true',
  NAVIS_PROMO_HCX_PILOT: 'true',
};
const options = { env, clovaKey: 'test-clova', anthropicKey: 'test-anthropic' };
const scene = { prompt: 'build this scene', schema: SCENE_SCHEMA };

describe('hosted promo provider', () => {
  it('calls each stage at the approved host and reports its actual model and tokens', async () => {
    const { scenes, texts, ending } = validStory();
    const story = { scenes, texts, ending };
    const html = '<p>scene</p>';
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const destination = String(url);
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe('error');
      if (destination === 'https://api.anthropic.com/v1/messages') {
        expect(headers.get('x-api-key')).toBe('test-anthropic');
        expect(JSON.parse(String(init?.body)).messages).toEqual([{ role: 'user', content: scene.prompt }]);
        return Response.json({ content: [{ type: 'text', text: JSON.stringify({ html }) }],
          stop_reason: 'end_turn', usage: { input_tokens: 15, cache_read_input_tokens: 3, output_tokens: 4 } });
      }
      const model = destination.match(/^https:\/\/clovastudio\.stream\.ntruss\.com\/v3\/chat-completions\/(HCX-005|HCX-007)$/)?.[1];
      expect(model).toBeTruthy();
      expect(headers.get('authorization')).toBe('Bearer test-clova');
      return Response.json({ status: { code: '20000' }, result: {
        finishReason: 'stop', message: { role: 'assistant', content: JSON.stringify(model === 'HCX-005' ? PHOTO_META : story) },
        usage: { promptTokens: 8, completionTokens: 2 },
      } });
    });
    const provider = providers.createLivePromoProvider({ ...options, fetchImpl });
    const look = await provider.invoke('look', 'look', { prompt: 'photo', schema: PHOTO_META_SCHEMA,
      images: [{ bytes: Buffer.from([255, 216, 255, 0]), lookKey: 'photo', mediaType: 'image/jpeg' }] });
    expect(look).toMatchObject({ state: 'received', output: PHOTO_META, usage: { inputTokens: 8, outputTokens: 2 } });
    expect(await provider.invoke('story', 'story', { prompt: 'story', schema: STORY_SCHEMA }))
      .toMatchObject({ state: 'received', output: story, usage: { inputTokens: 8, outputTokens: 2 } });
    expect(await provider.invoke('scenes', 'scenes', scene)).toMatchObject({
      state: 'received', output: { html }, usage: { inputTokens: 18, outputTokens: 4, outcome: 'success' },
    });
    expect(['look', 'story', 'scenes'].map(stage => provider.identity(stage as providers.ModelStage).model))
      .toEqual(['HCX-005', 'HCX-007', 'claude-opus-5-5']);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('requires explicit approval and does not resend when a paid scene outcome is unknown', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('connection lost'));
    expect(() => providers.createLivePromoProvider({ ...options, env: {}, fetchImpl })).toThrow('AI_UNAVAILABLE');
    expect(() => providers.createLivePromoProvider({ ...options, anthropicKey: '', fetchImpl })).toThrow('AI_UNAVAILABLE');
    expect(fetchImpl).toHaveBeenCalledTimes(0);

    const provider = providers.createLivePromoProvider({ ...options, fetchImpl });
    expect(await provider.invoke('scenes', 'attempt', scene)).toEqual({ state: 'unknown' });
    expect(await provider.reconcile('scenes', 'attempt', AbortSignal.timeout(1000))).toEqual({ state: 'unknown' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
