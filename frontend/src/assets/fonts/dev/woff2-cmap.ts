/** Minimal woff2 reader: returns the set of code points in the font's cmap (cmap is never transformed in woff2). */
import { brotliDecompressSync } from 'node:zlib';

function base128(b: Uint8Array, o: { p: number }): number {
  let v = 0;
  for (let i = 0; i < 5; i++) { const x = b[o.p++]; v = v * 128 + (x & 0x7f); if (!(x & 0x80)) return v; }
  throw new Error('bad UIntBase128');
}
const KNOWN = ['cmap','head','hhea','hmtx','maxp','name','OS/2','post','cvt ','fpgm','glyf','loca','prep','CFF ','VORG','EBDT','EBLC','gasp','hdmx','kern','LTSH','PCLT','VDMX','vhea','vmtx','BASE','GDEF','GPOS','GSUB','EBSC','JSTF','MATH','CBDT','CBLC','COLR','CPAL','SVG ','sbix','acnt','avar','bdat','bloc','bsln','cvar','fdsc','feat','fmtx','fvar','gvar','hsty','just','lcar','mort','morx','opbd','prop','trak','Zapf','Silf','Glat','Gloc','Feat','Sill'];

export function woff2Cmap(file: Uint8Array): Set<number> {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (dv.getUint32(0) !== 0x774f4632) throw new Error('not woff2');
  const numTables = dv.getUint16(12);
  const totalCompressed = dv.getUint32(20);
  const o = { p: 48 };
  const tables: { tag: string; len: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const flags = file[o.p++];
    let tag: string;
    if ((flags & 0x3f) === 0x3f) { tag = String.fromCharCode(...file.subarray(o.p, o.p + 4)); o.p += 4; } else tag = KNOWN[flags & 0x3f];
    const origLen = base128(file, o);
    const ver = flags >> 6;
    const transformed = tag === 'glyf' || tag === 'loca' ? ver === 0 : ver !== 0;
    const len = transformed ? base128(file, o) : origLen;
    tables.push({ tag, len });
  }
  const data = brotliDecompressSync(file.subarray(o.p, o.p + totalCompressed));
  let off = 0;
  let cmap: Uint8Array | null = null;
  for (const t of tables) { if (t.tag === 'cmap') cmap = data.subarray(off, off + t.len); off += t.len; }
  if (!cmap) throw new Error('no cmap');
  const c = new DataView(cmap.buffer, cmap.byteOffset, cmap.byteLength);
  const out = new Set<number>();
  const n = c.getUint16(2);
  for (let i = 0; i < n; i++) {
    const so = c.getUint32(4 + i * 8 + 4);
    const fmt = c.getUint16(so);
    if (fmt === 12) {
      const groups = c.getUint32(so + 12);
      for (let g = 0; g < groups; g++) {
        const s = c.getUint32(so + 16 + g * 12), e = c.getUint32(so + 20 + g * 12);
        for (let cp = s; cp <= e; cp++) out.add(cp);
      }
    } else if (fmt === 4) {
      const segX2 = c.getUint16(so + 6), seg = segX2 / 2;
      const endO = so + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
      for (let s = 0; s < seg; s++) {
        const end = c.getUint16(endO + s * 2), start = c.getUint16(startO + s * 2), ro = c.getUint16(rangeO + s * 2);
        for (let cp = start; cp <= end && cp < 0xffff; cp++) {
          if (ro === 0) { out.add(cp); continue; }
          const gi = c.getUint16(rangeO + s * 2 + ro + (cp - start) * 2);
          if (gi !== 0) out.add(cp);
        }
      }
    }
  }
  out.delete(0);
  return out;
}
