import type { Locale, MessageParams } from './types';

// ICU 부분 구현: {name}, {n, plural, =0 {} one {} other {}} (# = 숫자 서식), {x, select, a {} other {}},
// 한국어 조사 {name, particle, 을/를}. 중괄호 안 중괄호는 재귀로 읽는다. 작은따옴표는 특수 문자가 아니다.
type Node =
  | { t: 'text'; v: string }
  | { t: 'hash' }
  | { t: 'arg'; name: string }
  | { t: 'plural'; name: string; cases: Record<string, Node[]> }
  | { t: 'select'; name: string; cases: Record<string, Node[]> }
  | { t: 'particle'; name: string; pair: string };

const cache = new Map<string, Node[]>();

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}
  parse(): Node[] {
    const nodes = this.message(false);
    return nodes;
  }
  private message(inBranch: boolean): Node[] {
    const out: Node[] = [];
    let text = '';
    const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '{') { flush(); out.push(this.argument()); continue; }
      if (c === '}') { if (inBranch) break; text += c; this.i += 1; continue; }
      if (c === '#' && inBranch) { flush(); out.push({ t: 'hash' }); this.i += 1; continue; }
      text += c; this.i += 1;
    }
    flush();
    return out;
  }
  private argument(): Node {
    this.i += 1; // {
    const name = this.until(',}').trim();
    if (this.s[this.i] === '}') { this.i += 1; return { t: 'arg', name }; }
    this.i += 1; // ,
    const type = this.until(',}').trim();
    if (this.s[this.i] === '}') { this.i += 1; return { t: 'arg', name }; }
    this.i += 1; // ,
    if (type === 'particle') {
      const pair = this.until('}').trim();
      this.i += 1;
      return { t: 'particle', name, pair };
    }
    const cases: Record<string, Node[]> = {};
    while (this.i < this.s.length) {
      this.skipSpace();
      if (this.s[this.i] === '}') { this.i += 1; break; }
      const selector = this.until('{ \t\n}').trim();
      this.skipSpace();
      if (this.s[this.i] !== '{') break;
      this.i += 1;
      cases[selector] = this.message(true);
      this.i += 1; // }
    }
    return { t: type === 'plural' ? 'plural' : 'select', name, cases };
  }
  private until(stops: string): string {
    const start = this.i;
    while (this.i < this.s.length && !stops.includes(this.s[this.i])) this.i += 1;
    return this.s.slice(start, this.i);
  }
  private skipSpace() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1; }
}

function parse(template: string): Node[] {
  let nodes = cache.get(template);
  if (!nodes) { nodes = new Parser(template).parse(); cache.set(template, nodes); }
  return nodes;
}

const groupFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 20 });
export function groupNumber(n: number, maximumFractionDigits = 20): string {
  if (maximumFractionDigits === 20) return groupFmt.format(n);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(n);
}

const DIGIT_BATCHIM = new Set(['0', '1', '3', '6', '7', '8']);
const LETTER_BATCHIM = new Set(['l', 'm', 'n', 'r']);
/** 마지막 글자에 받침이 있는지(한글, 숫자 읽기, 몇몇 알파벳 읽기). 닫는 괄호·공백은 건너뛴다. */
export function hasBatchim(word: string): boolean {
  const chars = Array.from(word.replace(/[\s)\]}>”’"'.,!?…·]+$/u, ''));
  const last = chars[chars.length - 1];
  if (!last) return false;
  const code = last.codePointAt(0) ?? 0;
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  if (DIGIT_BATCHIM.has(last)) return true;
  if (/[a-z]/i.test(last)) return LETTER_BATCHIM.has(last.toLowerCase());
  return false;
}
function particleFor(word: string, pair: string): string {
  const [withBatchim, without] = pair.split('/');
  if (without === undefined) return '';
  return hasBatchim(word) ? withBatchim : without;
}

function render(nodes: Node[], locale: Locale, params: MessageParams, hash: string | null): string {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += n.v; break;
      case 'hash': out += hash ?? '#'; break;
      case 'arg': { const v = params[n.name]; out += v === undefined ? '' : String(v); break; }
      case 'particle': {
        const v = params[n.name];
        const word = v === undefined ? '' : String(v);
        out += word + (word ? particleFor(word, n.pair) : '');
        break;
      }
      case 'select': {
        const v = params[n.name];
        const branch = (v !== undefined && n.cases[String(v)]) || n.cases.other;
        if (branch) out += render(branch, locale, params, hash);
        break;
      }
      case 'plural': {
        const v = params[n.name];
        const num = typeof v === 'number' ? v : Number(v);
        if (v === undefined || Number.isNaN(num)) { const o = n.cases.other; if (o) out += render(o, locale, params, hash); break; }
        const category = new Intl.PluralRules(locale).select(num);
        const branch = n.cases[`=${num}`] ?? n.cases[category] ?? n.cases.other;
        if (branch) out += render(branch, locale, params, groupNumber(num));
        break;
      }
    }
  }
  return out;
}

export function formatMessage(template: string, locale: Locale, params: MessageParams = {}): string {
  return render(parse(template), locale, params, null);
}
