import { count, invalid, object, readJson, unavailable, type Transport } from './protocol.ts';

const studioPath = '/v3/chat-completions/HCX-005';
const studioUrl = 'https://navis-agent.invalid' + studioPath;
const speechPath = '/recog/v1/stt?lang=Kor';
const speechUrl = 'https://clovaspeech-gw.ncloud.com' + speechPath;
const receiptUrl = 'https://receipt-fixture.invalid/document/receipt';

export function createStudioAndMedia(transport: Transport, {
  receiptPath, now = () => new Date(),
}: { receiptPath?: string; now?: () => Date }) {
  if (receiptPath !== undefined && !/^\/custom\/v1\/\d+\/[A-Za-z0-9_-]+\/document\/receipt$/.test(receiptPath)) invalid();

  const read = readJson(transport);
  return {
    // Reuse the bridge's validated Studio stream reader and metering.
    // https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-fc
    studioFetch(storeId: string, approvalScope?: unknown) {
      return async (url: string, init: RequestInit) => {
        if (url !== studioUrl || init.method !== 'POST' || typeof init.body !== 'string') invalid();
        const input = new Headers(init.headers);
        const headers = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' });
        const requestId = input.get('x-ncp-clovastudio-request-id');
        if (requestId) headers.set('x-ncp-clovastudio-request-id', requestId);
        return transport.request('pn14.chat', storeId, studioPath, { headers, body: init.body, signal: init.signal, approvalScope });
      };
    },
    // Inject into createMediaService's fetchImpl. Its existing validation, deadline,
    // metering projection and editable suggestions still apply.
    // https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-shortsentence
    // https://api.ncloud-docs.com/docs/ai-application-service-ocr-ocrdocumentocr-receipt
    mediaFetch(storeId: string, approvalScope?: unknown) {
      return async (url: string, init: RequestInit) => {
        if (init.method !== 'POST') invalid();
        const { body, signal } = init;
        if (url === speechUrl) {
          if (!(body instanceof Uint8Array)) invalid();
          return transport.request('pn15.speech', storeId, speechPath, {
            headers: { 'content-type': 'application/octet-stream' }, body, signal, approvalScope,
          });
        }
        if (url !== receiptUrl || !(body instanceof FormData)) invalid();
        if (!receiptPath) unavailable();
        return transport.request('pn15.receipt', storeId, receiptPath, { body, signal, approvalScope });
      };
    },
    // A dedicated text-only Studio call returns an editable draft and metering values.
    // https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3
    async studioDraft(storeId: string, prompt: string, approvalScope?: unknown) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 8_000) invalid();
      const started = +now();
      const { data } = await read('pn14.chat', storeId, studioPath, {
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], maxTokens: 512 }), approvalScope,
      });
      const output = object(data);
      const result = object(output.result);
      const message = object(result.message);
      const usage = object(result.usage);
      if (object(output.status).code !== '20000' || result.finishReason !== 'stop' ||
          message.role !== 'assistant' || message.toolCalls !== undefined ||
          typeof message.content !== 'string' || !message.content.trim()) unavailable();
      return { text: message.content, usage: { promptTokens: count(usage.promptTokens),
        completionTokens: count(usage.completionTokens), latencyMs: Math.max(0, +now() - started) } };
    },
  };
}
