/**
 * REAL-PLAN F06-2 — which booking a table order claims, and what the owner is told about it.
 * Pure helpers for the POS order screen: the table map already says which table has a booking in its window (`state: 'reserved'`).
 */
import type { PosTableView } from '../../../contracts/pos';
import type { DataSnapshot } from '../../db/types';
import type { PosBillLinkDto } from '../02/dto';
import type { FirstOrderReservation } from './first-order';

/**
 * The booking to claim for the first order of `table`: a confirmed local or phone booking in its window, at this table, with a known service revision,
 * and only when the table has no open bill yet (a later order of the same bill never claims again). A NAVER booking holds no seat and never matches.
 */
export function firstOrderFor(snapshot: DataSnapshot, table: PosTableView | undefined, hasOpenBill: boolean): FirstOrderReservation | undefined {
  if (!table || hasOpenBill || table.state !== 'reserved' || !table.reservation) return undefined;
  const meta = snapshot.tables.realBooking?.meta[table.reservation.reservationId];
  if (!meta || meta.origin === 'naver' || meta.candidate || meta.revision === undefined) return undefined;
  return { reservationId: table.reservation.reservationId, sourceVersion: meta.revision };
}

/** What the owner reads after the order: the booking followed the order, or it did not (and why not is the list's job). */
export function seatNote(receipt: PosBillLinkDto, requested: boolean): string {
  if (receipt.reservationLink) return '예약 손님의 첫 주문이에요. 예약도 방문 완료로 이어져요';
  if (requested && receipt.reservationSkipped) return '예약은 이어지지 않았어요. 예약 목록에서 방문 완료로 바꿔 주세요';
  return '';
}
