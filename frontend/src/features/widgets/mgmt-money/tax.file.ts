import { sha256Hex } from '../../../data/reality/00/files';
import type { TaxExportFile, TaxExportFormat } from '../../../data/reality/18/dto';

/** Verify the response bytes before exposing the browser download. */
export async function verifiedTaxFile(file: TaxExportFile, exportId: string, format: TaxExportFormat): Promise<Blob> {
  const name = new RegExp(`^[a-z0-9._-]+\\.${format}$`, 'iu');
  if (file.exportId !== exportId || file.format !== format || !name.test(file.filename)) throw new Error('Unexpected export file');
  const bytes = Uint8Array.from(atob(file.contentBase64), byte => byte.charCodeAt(0));
  const blob = new Blob([bytes], { type: file.contentType });
  if (blob.size !== file.size || await sha256Hex(blob) !== file.sha256) throw new Error('Tax export integrity check failed');
  return blob;
}

export function downloadTaxFile(url: string, filename: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
