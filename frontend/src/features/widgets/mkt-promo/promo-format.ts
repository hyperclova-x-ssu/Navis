/**
 * T-083 estimate lookup and display rules (API-21, SCR-55 Q-42 표기 규칙): time under 60 s rounds up to 10 s, from 60 s up
 * to 30 s; cost rounds up to 10 won and is always shown in won. Elapsed time (SCR-56) is shown in whole seconds.
 */
import type { Translator } from '../../../i18n';
import type { EstimateCell, EstimateModel } from './promo-api';

/** `table[length][photoCount]` (API-21); a count above the table uses its last row, below 0 the first. */
export function lookupEstimate(model: EstimateModel | null, lengthSec: number | null, photoCount: number): EstimateCell | null {
  const rows = model?.table[String(lengthSec)];
  if (!rows || rows.length === 0) return null;
  return rows.find((row) => row.photoCount === photoCount) ?? (photoCount > rows[rows.length - 1].photoCount ? rows[rows.length - 1] : rows[0]);
}

/** Q-42: under 60 s → next 10 s, otherwise → next 30 s. */
export function roundEstimateSeconds(seconds: number): number {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return Math.max(10, Math.ceil(s / 10) * 10);
  return Math.ceil(s / 30) * 30;
}
export const roundEstimateWon = (won: number): number => Math.max(0, Math.ceil(won / 10) * 10);

const group = new Intl.NumberFormat('en-US');

/** “40초”, “1분”, “1분 30초” (no “약”; the sentence key carries it). */
export function durationText(t: Translator<string>, totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(s / 60), seconds = s % 60;
  if (minutes === 0) return t.t('promo.dur.sec', { s: seconds });
  if (seconds === 0) return t.t('promo.dur.min', { m: minutes });
  return t.t('promo.dur.minSec', { m: minutes, s: seconds });
}
export const estimateTimeText = (t: Translator<string>, seconds: number) => durationText(t, roundEstimateSeconds(seconds));
export const estimateCostText = (t: Translator<string>, won: number) => t.t('promo.won', { n: group.format(roundEstimateWon(won)) });
export const groupNumber = (n: number) => group.format(n);
/** “0:07” for the player. */
export function clockText(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
