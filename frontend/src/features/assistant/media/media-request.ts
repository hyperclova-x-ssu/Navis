export async function postMedia<T>(route: 'receipt-ocr' | 'transcription', media: Blob, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/navis/media/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': media.type },
    body: media,
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('Media recognition failed');
  return response.json() as Promise<T>;
}
