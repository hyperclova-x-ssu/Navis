/** Fake browser transport shared by assistant/host tests; never contacts an upstream service. */
export const sseFrame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
export function replyResponse(value: unknown): Response {
  const output = value as { answer: string; panels: unknown[] };
  return new Response(sseFrame('text_delta', { delta: output.answer }) + sseFrame('panels', { panels: output.panels }) + sseFrame('done', {}), { headers: { 'Content-Type': 'text/event-stream' } });
}
export function controlledResponse(headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/event-stream');
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; }, cancel() { cancelled = true; } }), { headers: responseHeaders });
  return { response, get cancelled() { return cancelled; }, frame(event: string, data: unknown) { if (!cancelled) writer.enqueue(encoder.encode(sseFrame(event, data))); }, bytes(bytes: Uint8Array) { if (!cancelled) writer.enqueue(bytes); }, close() { if (!cancelled) writer.close(); } };
}
