import { createHash } from 'node:crypto';
import type { ObjectStorage } from '../../../packages/object-storage/index.ts';
import { AccountError } from '../reality/00/wire.ts';

export type AttachmentContent = {
  bytes: Buffer | null;
  objectKey: string | null;
  size: number;
  sha256: string;
};

export function attachmentStorageUnavailable() {
  return new AccountError(503, 'UNAVAILABLE', 'FILE_STORAGE_UNAVAILABLE');
}

export async function withAttachmentStorage<T>(storage: ObjectStorage | undefined, operation: (storage: ObjectStorage, signal: AbortSignal) => Promise<T>) {
  if (!storage) throw attachmentStorageUnavailable();
  try {
    return await operation(storage, AbortSignal.timeout(1_500));
  } catch {
    throw attachmentStorageUnavailable();
  }
}

export async function readAttachmentBytes(storage: ObjectStorage | undefined, file: AttachmentContent) {
  const { objectKey } = file;
  if (!objectKey) return file.bytes ?? undefined;
  return withAttachmentStorage(storage, async (objects, signal) => {
    const object = await objects.get(objectKey, signal);
    if (!object) return;
    const { body, contentLength } = object;
    try {
      if (contentLength !== null && contentLength !== file.size) throw attachmentStorageUnavailable();
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > file.size) throw attachmentStorageUnavailable();
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, size);
      if (size !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        throw attachmentStorageUnavailable();
      }
      return bytes;
    } finally {
      body.destroy();
    }
  });
}
