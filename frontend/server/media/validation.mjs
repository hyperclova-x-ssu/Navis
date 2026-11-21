import { MediaError } from './errors.mjs';

export const MEDIA_TYPES = {
  receipt: ['image/jpeg', 'image/png'],
  speech: ['audio/wav'],
};

export const MAX_BYTES = { receipt: 5_000_000, speech: 10_000_000 };
const SAMPLE_RATE = 16_000;
const MAX_SECONDS = 60;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

const malformed = () => new MediaError('BAD_REQUEST');
const unsupported = () => new MediaError('UNSUPPORTED_MEDIA_TYPE');
const overflow = () => new MediaError('PAYLOAD_TOO_LARGE');

export async function readBounded(chunks, limit, signal) {
  const buffers = [];
  let size = 0;
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > limit) throw overflow();
    buffers.push(chunk);
  }
  return Buffer.concat(buffers, size);
}

function validatePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw unsupported();
  const ihdr = bytes.length >= 33 && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR';
  if (!ihdr) throw malformed();
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 0x7fffffff || height > 0x7fffffff) throw malformed();

  let hasImageData = false;
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + size;
    if (end > bytes.length || type === 'IHDR') throw malformed();
    if (type === 'IDAT' && size > 0) hasImageData = true;
    if (type === 'IEND' && hasImageData && size === 0 && end === bytes.length) return { format: 'png', width, height };
    offset = end;
  }
  throw malformed();
}

const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function validateJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw unsupported();
  let dimensions;
  let inScan = false;
  let hasScan = false;
  for (let offset = 2; offset < bytes.length;) {
    if (inScan) offset = bytes.indexOf(0xff, offset);
    if (offset < 0 || bytes[offset++] !== 0xff) throw malformed();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (inScan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    inScan = false;
    if (marker === 0xd9 && dimensions && hasScan && offset === bytes.length) return dimensions;
    if (marker === undefined || marker === 0 || (marker >= 0xd0 && marker <= 0xd9) || offset + 2 > bytes.length) throw malformed();

    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) throw malformed();
    if (SOF_MARKERS.has(marker)) {
      if (size < 8) throw malformed();
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) throw malformed();
      dimensions = { format: 'jpg', width, height };
    }
    if (marker === 0xda) {
      if (!dimensions || size < 6) throw malformed();
      inScan = hasScan = true;
    }
    offset += size;
  }
  throw malformed();
}

function validateWav(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw unsupported();
  if (bytes.readUInt32LE(4) !== bytes.length - 8) throw malformed();

  let hasFormat = false;
  let dataSize;
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw malformed();
    const kind = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const next = start + size + (size % 2);
    if (next > bytes.length) throw malformed();

    if (kind === 'fmt ') {
      if (hasFormat || size < 16) throw malformed();
      if (bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
          || bytes.readUInt32LE(start + 4) !== SAMPLE_RATE || bytes.readUInt32LE(start + 8) !== SAMPLE_RATE * 2
          || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) throw unsupported();
      hasFormat = true;
    }
    if (kind === 'data') {
      if (dataSize !== undefined || size % 2 !== 0) throw malformed();
      dataSize = size;
    }
    offset = next;
  }
  if (!hasFormat || !dataSize) throw malformed();
  const durationSeconds = dataSize / (SAMPLE_RATE * 2);
  if (durationSeconds > MAX_SECONDS) throw overflow();
  return { durationSeconds };
}

export function validateMedia(service, type, bytes) {
  if (!MEDIA_TYPES[service].includes(type)) throw unsupported();
  if (!bytes.length) throw malformed();
  if (bytes.length > MAX_BYTES[service]) throw overflow();
  if (service === 'speech') return validateWav(bytes);
  return type === 'image/png' ? validatePng(bytes) : validateJpeg(bytes);
}
