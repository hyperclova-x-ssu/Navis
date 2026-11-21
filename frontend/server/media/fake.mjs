import { validateMedia } from './validation.mjs';

export const FAKE_RECEIPT_URL = 'https://receipt-fixture.invalid/document/receipt';

export async function fakeMediaFetch(url, { body, signal }) {
  signal.throwIfAborted();
  if (url !== FAKE_RECEIPT_URL) return Response.json({ text: '딸기스무디 메뉴 추가해줘' });

  const photo = body.get('file');
  const bytes = Buffer.from(await photo.arrayBuffer());
  signal.throwIfAborted();
  const { width, height } = validateMedia('receipt', photo.type, bytes);
  if (width === 1 && height === 1) return Response.json({ images: [{ inferResult: 'FAILURE' }] });
  return Response.json({
    images: [{ inferResult: 'SUCCESS', receipt: { result: {
      storeInfo: { name: { text: '샘플 원두상회', confidenceScore: 0.72 } },
      paymentInfo: { date: { formatted: { year: '2026', month: '11', day: '17' }, confidenceScore: 0.99 } },
      totalPrice: { price: { text: '12,000원', confidenceScore: 0.98 } },
      subResults: [{ items: [{ name: { text: '원두', confidenceScore: 0.96 }, price: { price: { text: '12,000', confidenceScore: 0.96 } } }] }],
    } } }],
  });
}
