import fs from 'node:fs';
import path from 'node:path';

/** 01_product/LOCALES.md의 표를 읽는다(테스트 전용). 절 번호 → 행들의 칸 배열. */
export function readLocalesTables(): Record<string, string[][]> {
  const md = fs.readFileSync(path.resolve(process.cwd(), '..', '01_product', 'LOCALES.md'), 'utf8');
  const out: Record<string, string[][]> = {};
  let cur: string | null = null;
  for (const line of md.split('\n')) {
    const h = /^## (\d+)\./.exec(line);
    if (h) { cur = h[1]; out[cur] = []; continue; }
    if (cur && line.startsWith('|')) {
      const cells = line.split('|').slice(1, -1).map((s) => s.trim());
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      out[cur].push(cells);
    }
  }
  return out;
}
