// Client-side bcrypt for the NAVER Commerce token signature. The seller application signs
// `${clientId}_${timestamp}` with bcrypt, using its client secret as the salt, and sends the
// base64 of the result as client_secret_sign. https://apicenter.commerce.naver.com/docs/auth
// The backend has no bcrypt dependency, so this follows the published algorithm (Provos and
// Mazières, "A Future-Adaptable Password Scheme", 1999) and is checked against PostgreSQL
// pgcrypto crypt() in bcrypt.test.ts. It is a signer only: nothing here stores or verifies passwords.

const pWords = 18;
const words = pWords + 4 * 256;
const alphabet = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// "OrpheanBeholderScryDoubt" as six big-endian words.
const magic = [0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274];
let initial: Uint32Array | undefined;

// Blowfish initializes P and the four S-boxes with the hexadecimal digits of the fractional part of
// pi (Schneier, 1993). Compute them once with Machin's formula instead of embedding 1,042 constants.
function blowfishInitialState(): Uint32Array {
  if (initial) return initial;
  const bits = BigInt(words * 32);
  const guard = 64n;
  const one = 1n << (bits + guard);
  const arctanInverse = (x: bigint) => {
    const square = x * x;
    let power = one / x;
    let sum = power;
    for (let k = 1n; power !== 0n; k++) {
      power /= square;
      const term = power / (2n * k + 1n);
      sum += k % 2n ? -term : term;
    }
    return sum;
  };
  const pi = 16n * arctanInverse(5n) - 4n * arctanInverse(239n);
  const fraction = (pi - (3n << (bits + guard))) >> guard;
  const state = new Uint32Array(words);
  for (let i = 0; i < words; i++) state[i] = Number((fraction >> (bits - 32n * BigInt(i + 1))) & 0xffffffffn);
  initial = state;
  return state;
}

function round(state: Uint32Array, x: number) {
  const a = state[pWords + (x >>> 24)];
  const b = state[pWords + 256 + ((x >>> 16) & 0xff)];
  const c = state[pWords + 512 + ((x >>> 8) & 0xff)];
  const d = state[pWords + 768 + (x & 0xff)];
  return (((a + b) ^ c) + d) | 0;
}

function encipher(state: Uint32Array, block: Uint32Array, offset: number) {
  let left = block[offset] ^ state[0];
  let right = block[offset + 1];
  for (let i = 0; i < 16; i += 2) {
    right ^= round(state, left) ^ state[i + 1];
    left ^= round(state, right) ^ state[i + 2];
  }
  block[offset] = right ^ state[17];
  block[offset + 1] = left;
}

function streamWord(data: Uint8Array, cursor: { at: number }) {
  let word = 0;
  for (let i = 0; i < 4; i++) {
    word = (word << 8) | data[cursor.at];
    cursor.at = (cursor.at + 1) % data.length;
  }
  return word;
}

// ExpandKey(state, salt, key); a null salt is the all-zero salt used by the cost loop.
function expandKey(state: Uint32Array, key: Uint8Array, salt: Uint8Array | null) {
  const keyCursor = { at: 0 };
  for (let i = 0; i < pWords; i++) state[i] ^= streamWord(key, keyCursor);
  const saltCursor = { at: 0 };
  const block = new Uint32Array(2);
  for (let i = 0; i < words; i += 2) {
    if (salt) {
      block[0] ^= streamWord(salt, saltCursor);
      block[1] ^= streamWord(salt, saltCursor);
    }
    encipher(state, block, 0);
    state[i] = block[0];
    state[i + 1] = block[1];
  }
}

function encode(bytes: Uint8Array, length: number) {
  let out = '';
  for (let i = 0; i < length;) {
    let first = bytes[i++];
    out += alphabet[first >> 2];
    first = (first & 0x03) << 4;
    if (i >= length) return out + alphabet[first];
    let next = bytes[i++];
    out += alphabet[first | (next >> 4)];
    first = (next & 0x0f) << 2;
    if (i >= length) return out + alphabet[first];
    next = bytes[i++];
    out += alphabet[first | (next >> 6)] + alphabet[next & 0x3f];
  }
  return out;
}

function decodeSalt(text: string) {
  const values = [...text].map(char => alphabet.indexOf(char));
  const bytes = new Uint8Array(16);
  let length = 0;
  for (let i = 0; length < 16; i += 4) {
    const [a, b, c = 0, d = 0] = values.slice(i, i + 4);
    bytes[length++] = (a << 2) | ((b & 0x30) >> 4);
    if (length < 16) bytes[length++] = ((b & 0x0f) << 4) | ((c & 0x3c) >> 2);
    if (length < 16) bytes[length++] = ((c & 0x03) << 6) | d;
  }
  return bytes;
}

/** bcrypt(password, salt) for `$2a$`/`$2b$`/`$2y$` salts with cost 4–16. Returns the 60-character string. */
export function bcrypt(password: string, salt: string): string {
  const match = /^\$(2[aby])\$(\d{2})\$([./A-Za-z0-9]{22})/.exec(salt);
  const cost = Number(match?.[2]);
  // The Commerce secrets observed in local tooling use cost 4; 16 bounds the work per token request.
  if (!match || !Number.isInteger(cost) || cost < 4 || cost > 16) throw new Error('Unsupported bcrypt salt');
  const saltBytes = decodeSalt(match[3]);
  const encoded = new TextEncoder().encode(password);
  // The key is the password bytes plus a NUL terminator, truncated to 72 bytes.
  const key = new Uint8Array(Math.min(encoded.length + 1, 72));
  key.set(encoded.subarray(0, Math.min(encoded.length, 72)));
  const state = blowfishInitialState().slice();
  expandKey(state, key, saltBytes);
  for (let i = 0; i < 2 ** cost; i++) {
    expandKey(state, key, null);
    expandKey(state, saltBytes, null);
  }
  const block = Uint32Array.from(magic);
  for (let i = 0; i < 64; i++) for (let j = 0; j < 6; j += 2) encipher(state, block, j);
  const output = new Uint8Array(24);
  block.forEach((word, i) => new DataView(output.buffer).setUint32(i * 4, word));
  return `$${match[1]}$${match[2]}$${encode(saltBytes, 16)}${encode(output, 23)}`;
}
