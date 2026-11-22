import type { ReactNode } from 'react';
import { koreanScreenText } from '../../i18n';

/**
 * CHAT-UI M-05 / M-06 answer text. Presentation only: the validated sentence is never reworded or reordered
 * (C-30). Key figures get their own bold, unbreakable element, and lines the answer itself wrote as a numbered
 * or bulleted list become a real list. The text content of the answer is identical before and after.
 */

type Block =
  | { readonly kind: 'p'; readonly text: string }
  | { readonly kind: 'ol' | 'ul'; readonly items: readonly string[] };
interface Marker { readonly kind: 'ol' | 'ul'; readonly mark: string; readonly number?: number; readonly text: string }

const orderedLine = /^ {0,3}(\d{1,2})([.)])\s+(\S.*)$/u;
const bulletLine = /^ {0,3}([-•*])\s+(\S.*)$/u;

function markerOf(line: string): Marker | undefined {
  const ordered = orderedLine.exec(line);
  if (ordered) return { kind: 'ol', mark: ordered[2], number: Number(ordered[1]), text: ordered[3] };
  const bullet = bulletLine.exec(line);
  if (bullet) return { kind: 'ul', mark: bullet[1], text: bullet[2] };
  return undefined;
}

const sameList = (marker: Marker | undefined, first: Marker): marker is Marker =>
  marker !== undefined && marker.kind === first.kind && marker.mark === first.mark;

/**
 * A list is two or more consecutive items with the same marker; a numbered list counts 1, 2, 3 … without a gap.
 * A single marker line, a date such as "11. 22." and a list that does not start at 1 stay plain paragraphs.
 * Blank lines between items are fine when the next non-blank line continues the same list.
 */
function readList(lines: readonly string[], start: number, first: Marker): { readonly items: readonly string[]; readonly end: number } | undefined {
  const items: string[] = [];
  let index = start;
  let end = start;
  let expected = first.number;
  while (index < lines.length) {
    const marker = markerOf(lines[index]);
    if (!sameList(marker, first) || (first.kind === 'ol' && marker.number !== expected)) break;
    items.push(marker.text);
    if (expected !== undefined) expected += 1;
    index += 1;
    // An indented line right after an item continues that item.
    while (index < lines.length && /^ {2,}\S/u.test(lines[index]) && !markerOf(lines[index])) {
      items[items.length - 1] += `\n${lines[index].trim()}`;
      index += 1;
    }
    end = index;
    let next = index;
    while (next < lines.length && lines[next].trim() === '') next += 1;
    if (next === index) continue;
    const upcoming = next < lines.length ? markerOf(lines[next]) : undefined;
    if (!sameList(upcoming, first) || (first.kind === 'ol' && upcoming.number !== expected)) break;
    index = next;
  }
  return items.length >= 2 && (first.kind === 'ul' || first.number === 1) ? { items, end } : undefined;
}

export function answerBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'p', text: paragraph.join('\n') });
    paragraph = [];
  };
  let index = 0;
  while (index < lines.length) {
    const first = markerOf(lines[index]);
    const list = first && readList(lines, index, first);
    if (first && list) {
      flush();
      blocks.push({ kind: first.kind, items: list.items });
      index = list.end;
    } else if (lines[index].trim() === '') {
      flush();
      index += 1;
    } else {
      paragraph.push(lines[index]);
      index += 1;
    }
  }
  flush();
  return blocks;
}

const units = '원|명|건|개(?!월)|곳|잔|장|병|팩|박스|그릇|인분|%|퍼센트|배|회(?!원)|(?:kg|g|ml|mL|L)(?![A-Za-z])';
// optional ▲▼ + sign, then digits (grouped or plain, optional decimals), then an attached unit.
const figure = new RegExp(`(?<![\\p{L}\\p{N},.])([▲▼△▽][ \\u00a0]?)?([+\\-−])?(\\d{1,3}(?:,\\d{3})+(?!\\d)|\\d+)(\\.\\d+)?(${units})?`, 'gu');

/** A figure is "key" when it carries a unit, a thousands separator or a ▲/▼ direction. Dates, clock times and bare counts stay plain. */
function withFigures(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(figure)) {
    const [value, arrow, , digits, , unit] = match;
    if (!arrow && !unit && !digits.includes(',')) continue;
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(<strong className="ai-conversation__figure" key={match.index}>{value}</strong>);
    last = match.index + value.length;
  }
  if (last === 0) return [text];
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export interface AnswerTextOptions {
  /** The assistant's answers get figures and lists; the owner's own words stay as typed. */
  readonly structured: boolean;
  readonly korean: boolean;
}

export function renderAnswerText(text: string, { structured, korean }: AnswerTextOptions): ReactNode {
  const screen = (value: string) => structured && korean ? koreanScreenText(value) : value;
  if (!structured) return text.split(/\n\n/u).map((paragraph, index) => <p key={index} style={{ whiteSpace: 'pre-line' }}>{paragraph}</p>);
  return answerBlocks(text).map((block, index) => {
    if (block.kind === 'p') return <p key={index} style={{ whiteSpace: 'pre-line' }}>{withFigures(screen(block.text))}</p>;
    const items = block.items.map((item, itemIndex) => <li key={itemIndex} style={{ whiteSpace: 'pre-line' }}>{withFigures(screen(item))}</li>);
    return block.kind === 'ol' ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
  });
}
