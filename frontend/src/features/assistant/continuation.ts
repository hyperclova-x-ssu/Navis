import {
  convertNavisQuantity, isNavisApproximate, isNavisTimeAmbiguous, navisMoneySpans, normalizeNavisInput, parseNavisDate, parseNavisMoney,
  parseNavisOrdinal, parseNavisPeriod, parseNavisQuantity, parseNavisTime, parsePendingResponse, resolveNavisAlias, resolveNavisName,
  type NavisUnit,
} from './navis-input';

/**
 * G-004: one typed slot update at a time. This module is pure. It never commits, never calls a tool and keeps
 * no raw text: an outcome carries only the parsed value, a chosen id or the next thing to ask. A write still
 * happens only when the owner presses its card (D-323–D-326).
 */

export type NavisSlotValue = string | number | boolean | { readonly start: string; readonly end: string };
export interface NavisChoice {
  readonly id: string;
  readonly label: string;
  /** Returned instead of the id when set, e.g. the numeric price behind a rounding chip. */
  readonly value?: string | number | boolean;
}

export type NavisContinuationSlot =
  | { readonly kind: 'money'; readonly min?: number; readonly max?: number }
  | { readonly kind: 'quantity'; readonly unit?: NavisUnit; readonly min?: number; readonly max?: number; readonly packSize?: number }
  | { readonly kind: 'date' }
  | { readonly kind: 'time' }
  | { readonly kind: 'period' }
  | { readonly kind: 'choice'; readonly choices: readonly NavisChoice[] }
  | { readonly kind: 'confirm' };

/** Everything a response has to match. `target` is a verified record handle, `stepId` is `${planId}#${index}`. */
export interface NavisContinuationScope {
  readonly runId: string;
  readonly revision: number;
  readonly target?: string;
  readonly stepId?: string;
}

export interface NavisContinuation {
  readonly id: string;
  /** The slot name the caller resumes with the returned value. */
  readonly field: string;
  readonly slot: NavisContinuationSlot;
  readonly scope: NavisContinuationScope;
  /** The turn ends in a write card. An affirmative never commits it. */
  readonly mutation: boolean;
  /** Every slot is filled and only the owner's go-ahead is missing. */
  readonly ready?: boolean;
}

export interface NavisContinuationContext {
  readonly scope: NavisContinuationScope;
  /** Asia/Seoul business date and clock of the current run. */
  readonly businessDate: string;
  readonly businessNow?: string;
}

export type NavisContinuationReply = { readonly text: string } | { readonly chipId: string };

export type NavisContinuationOutcome =
  | { readonly kind: 'resume'; readonly field: string; readonly value: NavisSlotValue; readonly via: 'chip' | 'ordinal' | 'typed'; readonly correction: boolean }
  | { readonly kind: 'reask'; readonly reason: 'stale' | 'ambiguous' | 'invalid' | 'missing' | 'packSize'; readonly field: string; readonly candidates?: readonly NavisChoice[] }
  /** The slots are complete and the owner agreed. The caller builds a fresh preview card. */
  | { readonly kind: 'present-card'; readonly field: string }
  | { readonly kind: 'cancel' }
  /** A standalone read or other request. The continuation stays available and nothing is consumed. */
  | { readonly kind: 'leave' };

const readRequest = /[?？]\s*$|알려|보여|얼마|어때|몇|언제|어떻게|무엇|어느|있어|없어|매출|현황|조회|궁금/u;
/** "얼마가 좋을까" asks the assistant to pick the pending value, so it is not a lookup either. */
const valueDeferral = /얼마(?:가|로)?\s*(?:좋|할까)|뭐가\s*좋/u;
/** A question or lookup, not an answer to the pending slot. */
export function isNavisStandaloneRead(text: string): boolean {
  const value = normalizeNavisInput(text);
  return readRequest.test(value) && !valueDeferral.test(value);
}

const sameScope = (a: NavisContinuationScope, b: NavisContinuationScope) =>
  a.runId === b.runId && a.revision === b.revision && a.target === b.target && a.stepId === b.stepId;

const trailingFiller = /(?:으?로)?\s*(?:바꿔\s*줘|해\s*줘|수정|주세요|할래|할게|이요|입니다|이에요|예요|요)$/u;
const correctionLead = /^(?:아니(?:야|요)?|아냐)\s+/u;
const correctionSplit = /^(?:(?:아니(?:야|요)?|아냐)\s*)?(.+?)\s*말고\s+(.+)$/u;

/** Strip an explicit correction ("아니", "A 말고 B") and report the corrected remainder. */
function splitCorrection(value: string): { readonly text: string; readonly correction: boolean } {
  const split = correctionSplit.exec(value);
  if (split) return { text: split[2].trim(), correction: true };
  const lead = correctionLead.exec(value);
  return lead ? { text: value.slice(lead[0].length).trim(), correction: true } : { text: value, correction: false };
}

const resume = (field: string, value: NavisSlotValue, via: 'chip' | 'ordinal' | 'typed', correction = false): NavisContinuationOutcome =>
  ({ kind: 'resume', field, value, via, correction });
const reask = (field: string, reason: 'stale' | 'ambiguous' | 'invalid' | 'missing' | 'packSize', candidates?: readonly NavisChoice[]): NavisContinuationOutcome =>
  ({ kind: 'reask', reason, field, ...candidates && { candidates } });

function readChoice(continuation: NavisContinuation, choices: readonly NavisChoice[], value: string, correction: boolean): NavisContinuationOutcome {
  const { field } = continuation;
  const pick = (choice: NavisChoice, via: 'ordinal' | 'typed') => resume(field, choice.value ?? choice.id, via, correction);
  const ordinal = parseNavisOrdinal(value);
  if (ordinal !== undefined) {
    const choice = choices[ordinal === -1 ? choices.length - 1 : ordinal];
    return choice ? pick(choice, 'ordinal') : reask(field, 'invalid');
  }
  const named = resolveNavisName(value, choices, choice => choice.label);
  if (named.kind === 'exact' || named.kind === 'similar') return pick(named.matches[0], 'typed');
  if (named.kind === 'ambiguous') return reask(field, 'ambiguous', named.matches);
  const alias = resolveNavisAlias(value);
  if (alias) {
    const official = resolveNavisName(alias.official, choices, choice => choice.label);
    if (official.kind === 'exact' || official.kind === 'similar') return pick(official.matches[0], 'typed');
    if (official.kind === 'ambiguous') return reask(field, 'ambiguous', official.matches);
  }
  return reask(field, 'invalid');
}

function readMoney(continuation: NavisContinuation, slot: Extract<NavisContinuationSlot, { kind: 'money' }>, value: string, correction: boolean): NavisContinuationOutcome {
  const { field } = continuation;
  if (isNavisApproximate(value)) return reask(field, 'ambiguous');
  const spans = navisMoneySpans(value);
  if (spans.length > 1) return reask(field, 'ambiguous');
  const amount = spans.length ? spans[0].value : parseNavisMoney(value.replace(trailingFiller, '').trim());
  if (amount === undefined || !Number.isInteger(amount)) return reask(field, 'invalid');
  if (amount < (slot.min ?? 0) || slot.max !== undefined && amount > slot.max) return reask(field, 'invalid');
  return resume(field, amount, 'typed', correction);
}

function readQuantity(continuation: NavisContinuation, slot: Extract<NavisContinuationSlot, { kind: 'quantity' }>, value: string, correction: boolean): NavisContinuationOutcome {
  const { field } = continuation;
  if (isNavisApproximate(value)) return reask(field, 'ambiguous');
  const parsed = parseNavisQuantity(value);
  let amount: number | undefined;
  if (parsed) {
    const converted = slot.unit ? convertNavisQuantity(parsed, slot.unit, slot.packSize) : { value: parsed.value };
    if (!converted) return reask(field, 'invalid');
    if ('needs' in converted) return reask(field, 'packSize');
    amount = converted.value;
  } else if (slot.unit) {
    // A bare number is taken in the slot's own unit.
    const bare = parseNavisMoney(value.replace(trailingFiller, '').trim());
    amount = bare;
  }
  if (amount === undefined) return reask(field, 'invalid');
  if (amount < (slot.min ?? 0) || slot.max !== undefined && amount > slot.max) return reask(field, 'invalid');
  return resume(field, amount, 'typed', correction);
}

const meridiemLabel = (time: string) => {
  const [hour, minute] = time.split(':').map(Number);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour < 12 ? '오전' : '오후'} ${twelve}시${minute ? ` ${minute}분` : ''}`;
};

function readTime(continuation: NavisContinuation, value: string, context: NavisContinuationContext, correction: boolean): NavisContinuationOutcome {
  const { field } = continuation;
  if (isNavisTimeAmbiguous(value)) {
    const morning = parseNavisTime(`오전 ${value}`, context.businessNow), evening = parseNavisTime(`오후 ${value}`, context.businessNow);
    return morning && evening
      ? reask(field, 'ambiguous', [morning, evening].map(time => ({ id: time, label: meridiemLabel(time), value: time })))
      : reask(field, 'ambiguous');
  }
  const time = parseNavisTime(value, context.businessNow);
  return time ? resume(field, time, 'typed', correction) : reask(field, 'invalid');
}

/**
 * Resolve one owner reply against the open continuation. A chip, an ordinal or a typed value resumes only when
 * the run, snapshot revision, verified target and plan step all still match; otherwise the missing value is
 * asked again. The result is a value or a next question, never a commit.
 */
export function resolveNavisContinuation(continuation: NavisContinuation, reply: NavisContinuationReply, context: NavisContinuationContext): NavisContinuationOutcome {
  const { field, slot } = continuation;
  if (!sameScope(continuation.scope, context.scope)) return reask(field, 'stale');

  if ('chipId' in reply) {
    if (slot.kind === 'confirm') {
      if (reply.chipId === 'yes') return resume(field, true, 'chip');
      return reply.chipId === 'no' ? { kind: 'cancel' } : reask(field, 'invalid');
    }
    if (slot.kind !== 'choice') return reask(field, 'invalid');
    const choice = slot.choices.find(item => item.id === reply.chipId);
    return choice ? resume(field, choice.value ?? choice.id, 'chip') : reask(field, 'invalid');
  }

  const value = normalizeNavisInput(reply.text).replace(/[.!?。！？]+$/u, '').trim();
  if (!value) return reask(field, 'missing');

  // An exact choice label wins over the read-word heuristic below ("매출 현황" can be a chip label).
  if (slot.kind === 'choice') {
    const exact = slot.choices.find(choice => normalizeNavisInput(choice.label) === value);
    if (exact) return resume(field, exact.value ?? exact.id, 'typed');
  }

  const response = parsePendingResponse(value);
  if (response === 'cancel' || response === 'no') return { kind: 'cancel' };
  if (response === 'yes') {
    if (slot.kind === 'confirm') return resume(field, true, 'typed');
    return continuation.mutation && continuation.ready ? { kind: 'present-card', field } : reask(field, 'missing');
  }
  if (response === 'edit') return reask(field, 'missing');

  const { text, correction } = splitCorrection(value);
  // Read detection looks at the reply as typed, so a trailing "?" still counts.
  if (isNavisStandaloneRead(reply.text)) return { kind: 'leave' };

  switch (slot.kind) {
    case 'choice': return readChoice(continuation, slot.choices, text, correction);
    case 'money': return readMoney(continuation, slot, text, correction);
    case 'quantity': return readQuantity(continuation, slot, text, correction);
    case 'time': return readTime(continuation, text, context, correction);
    case 'date': {
      const date = parseNavisDate(text, context.businessDate);
      return date ? resume(field, date, 'typed', correction) : reask(field, 'invalid');
    }
    case 'period': {
      const period = parseNavisPeriod(text, context.businessDate);
      return period ? resume(field, period, 'typed', correction) : reask(field, 'invalid');
    }
    case 'confirm': return reask(field, 'missing');
  }
}
