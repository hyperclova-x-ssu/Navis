import { PortError, type PortFile, type PortFiles, type PortTransport } from './port';

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');

const bytesOf = (blob: Blob): Promise<ArrayBuffer> => typeof blob.arrayBuffer === 'function' ? blob.arrayBuffer() : new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as ArrayBuffer);
  reader.onerror = () => reject(reader.error);
  reader.readAsArrayBuffer(blob);
});

export async function sha256Hex(blob: Blob): Promise<string> {
  // A copy in this realm: some DOM implementations hand back a foreign ArrayBuffer that SubtleCrypto rejects.
  return hex(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(new Uint8Array(await bytesOf(blob)))));
}

/** Attachments over the account service (REAL-PLAN B00 `files`). The create call is idempotent by content hash, so a retried upload never makes a second file. */
export function createPortFiles(transport: PortTransport): PortFiles {
  const files: PortFiles = {
    async upload({ purpose, blob }) {
      const sha256 = await sha256Hex(blob);
      const created = await transport.request<{ fileId: string }>({
        method: 'POST', path: '/files', idempotencyKey: `file:${purpose}:${sha256}`,
        body: { purpose, contentType: blob.type, size: blob.size, sha256 },
      });
      if (typeof created?.fileId !== 'string') throw new PortError(502, 'SERVICE_UNAVAILABLE', 'BAD_RESPONSE');
      await transport.request({ method: 'PUT', path: `/files/${created.fileId}/content`, bytes: blob });
      const done = await transport.request<Partial<PortFile>>({ method: 'POST', path: `/files/${created.fileId}/complete`, body: {} });
      return { fileId: created.fileId, contentType: done?.contentType ?? blob.type, size: done?.size ?? blob.size, sha256: done?.sha256 ?? sha256 };
    },
    async uploadDataUrl(purpose, dataUrl) {
      const match = DATA_URL.exec(dataUrl);
      if (!match) throw new PortError(400, 'VALIDATION', 'FILE_INVALID', 'file');
      const bytes = Uint8Array.from(globalThis.atob(match[2]), character => character.charCodeAt(0));
      return files.upload({ purpose, blob: new Blob([bytes], { type: match[1].toLowerCase() }) });
    },
    async readUrl(fileId) {
      const blob = await transport.request<Blob>({ method: 'GET', path: `/files/${encodeURIComponent(fileId)}/content`, responseAs: 'blob' });
      return URL.createObjectURL(blob);
    },
    async revoke(fileId) {
      await transport.request({ method: 'DELETE', path: `/files/${encodeURIComponent(fileId)}` });
    },
  };
  return files;
}
