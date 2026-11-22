import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { PersonaCapability } from '../../app.ts';
import type { ReceiptImageResult, ReceiptRequest, ReceiptResponse, ShortSpeechResult } from '../../../../packages/naver/contracts/pn15/index.ts';
import { validateMedia } from '../../../../../frontend/server/media/validation.mjs';

function matches(expected: string | undefined, supplied: unknown) {
  return !!expected && typeof supplied === 'string' && Buffer.byteLength(expected) === Buffer.byteLength(supplied)
    && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key));
}

async function receiptBody(request: FastifyRequest) {
  if (!Buffer.isBuffer(request.body)) return { metadata: request.body as unknown, file: undefined };
  const header = request.headers['content-type'];
  if (!header?.startsWith('multipart/form-data;')) throw new Error('Invalid type');
  const data = await new Response(new Uint8Array(request.body), { headers: { 'content-type': header } }).formData();
  const message = data.get('message');
  const file = data.get('file');
  if ([...data.keys()].length !== 2 || message === null || !(file instanceof File)) throw new Error('Invalid form');
  const metadata: unknown = JSON.parse(typeof message === 'string' ? message : await message.text());
  return { metadata, file: Buffer.from(await file.arrayBuffer()) };
}

function isReceiptRequest(body: unknown, multipart: boolean): body is ReceiptRequest {
  return object(body) && onlyKeys(body, ['version', 'requestId', 'timestamp', 'images'])
    && body.version === 'V2' && typeof body.requestId === 'string' && body.requestId.length > 0
    && Number.isSafeInteger(body.timestamp) && Array.isArray(body.images) && body.images.length === 1
    && body.images.every(image => object(image) && onlyKeys(image, multipart ? ['format', 'name'] : ['format', 'name', 'data'])
      && typeof image.name === 'string' && image.name.length > 0
      && typeof image.format === 'string' && ['jpg', 'jpeg', 'png', 'pdf', 'tif', 'tiff'].includes(image.format)
      && (multipart || typeof image.data === 'string' && image.data.length > 0
        && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)));
}

function receiptImage(name: string, format: string, file: Buffer, now: Date): ReceiptImageResult {
  const uid = createHash('sha256').update(name).update(file).digest('hex').slice(0, 32);
  const common = { uid, name, validationResult: { result: 'NO_REQUESTED' as const } };
  try {
    if (!['png', 'jpg', 'jpeg'].includes(format)) throw new Error('Unreadable fixture');
    const media = validateMedia('receipt', format === 'png' ? 'image/png' : 'image/jpeg', file);
    if ('width' in media && media.width === 1 && media.height === 1) {
      return { ...common, inferResult: 'FAILURE', message: 'Not recognized.' };
    }
  } catch {
    return { ...common, inferResult: 'ERROR', message: 'Read page:0 error.' };
  }

  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now).split('-');
  const field = (text: string, value: string, confidenceScore: number) => ({ text, formatted: { value }, confidenceScore });
  return {
    ...common, inferResult: 'SUCCESS', message: 'SUCCESS',
    receipt: { meta: { estimatedLanguage: 'ko' }, result: {
      storeInfo: { name: field('샘플 원두상회', '샘플 원두상회', 0.72) },
      paymentInfo: { date: { text: `${year}-${month}-${day}`, formatted: { year, month, day }, confidenceScore: 0.99 } },
      totalPrice: { price: field('12,000원', '12000', 0.98) },
      subResults: [{ items: [{
        name: field('원두', '원두', 0.96),
        count: field('1', '1', 0.97),
        price: { price: field('12,000', '12000', 0.96), unitPrice: field('12,000', '12000', 0.96) },
      }] }],
    } },
  };
}

export const personaCapability: PersonaCapability = {
  id: 'pn15',
  register(app, context) {
    app.addContentTypeParser(['application/octet-stream', 'multipart/form-data'], { parseAs: 'buffer' },
      (_request, body, done) => done(null, body));

    // Speech short-sentence auth and errors: https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech-shortsentence
    // Common status codes: https://api.ncloud-docs.com/docs/ai-application-service-clovaspeech
    app.post<{ Querystring: { lang?: string } }>('/recog/v1/stt', {
      bodyLimit: 10_000_000, config: { personaOperation: 'pn15.speech' },
      errorHandler(error: { statusCode?: number }, _request, reply) {
        if (error.statusCode === 413) return reply.code(413).send({ code: 'STT001', message: 'Exceed Sound Data length' });
        return reply.code(400).send({ code: 'STT002', message: 'Invalid Content Type' });
      },
    }, (request, reply) => {
      if (!matches(context.providerCredential(request, 'secret'), request.headers['x-clovaspeech-api-key'])) {
        return reply.code(401).send({ code: '401', message: 'Invalid secret' });
      }
      if (request.query.lang === undefined) return reply.code(400).send({ code: 'STT004', message: 'Empty Language' });
      if (request.query.lang !== 'Kor') return reply.code(400).send({ code: 'STT005', message: 'Invalid Language' });
      if (Object.keys(request.query).length !== 1) return reply.code(400).send({ code: '400', message: 'Invalid request parameters' });
      if (request.headers['content-type'] !== 'application/octet-stream') {
        return reply.code(400).send({ code: 'STT002', message: 'Invalid Content Type' });
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        return reply.code(400).send({ code: 'STT003', message: 'Empty Sound Data' });
      }
      try {
        const media = validateMedia('speech', 'audio/wav', request.body);
        if (!('durationSeconds' in media)) throw new Error('Invalid audio');
        const result: ShortSpeechResult = {
          text: '오늘 원두 발주 내역 보여줘', quota: Math.ceil(media.durationSeconds / 15) * 15,
        };
        return result;
      } catch (error) {
        if (object(error) && error.code === 'PAYLOAD_TOO_LARGE') {
          return reply.code(413).send({ code: 'STT001', message: 'Exceed Sound Data length' });
        }
        return reply.code(500).send({ code: 'STT006', message: 'Failed to pre-processing' });
      }
    });

    // Receipt V2 URL, image status and error codes:
    // https://api.ncloud-docs.com/docs/ai-application-service-ocr-ocrdocumentocr-receipt
    // https://api.ncloud-docs.com/docs/ai-application-service-ocr
    app.post<{ Params: { domainId: string; invokeKey: string } }>('/custom/v1/:domainId/:invokeKey/document/receipt', {
      bodyLimit: 7_000_000, config: { personaOperation: 'pn15.receipt' },
      errorHandler(_error, _request, reply) {
        return reply.code(400).send({ code: '0011', message: 'Request body invalid.' });
      },
    }, async (request, reply) => {
      if (!matches(context.providerCredential(request, 'domainId'), request.params.domainId)
        || !matches(context.providerCredential(request, 'invokeKey'), request.params.invokeKey)) {
        return reply.code(400).send({ code: '0001', message: 'URL is invalid.' });
      }
      if (!matches(context.providerCredential(request, 'secret'), request.headers['x-ocr-secret'])) {
        return reply.code(401).send({ code: '0002', message: 'Secret key validate failed.' });
      }
      let body;
      try {
        body = await receiptBody(request);
      } catch {
        return reply.code(400).send({ code: '0011', message: 'Request body invalid.' });
      }
      if (object(body.metadata) && body.metadata.version !== undefined && body.metadata.version !== 'V2') {
        return reply.code(400).send({ code: '0021', message: 'Protocol version not support.' });
      }
      if (!isReceiptRequest(body.metadata, !!body.file)) {
        return reply.code(400).send({ code: '0011', message: 'Request body invalid.' });
      }
      const currentTime = context.now();
      const result: ReceiptResponse = {
        version: 'V2', requestId: body.metadata.requestId, timestamp: currentTime.getTime(),
        images: body.metadata.images.map(({ name, format, data }) =>
          receiptImage(name, format, body.file ?? Buffer.from(data ?? '', 'base64'), currentTime)),
      };
      return result;
    });
  },
};
