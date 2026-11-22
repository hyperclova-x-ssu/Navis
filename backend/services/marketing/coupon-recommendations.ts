import { ownerHeaders } from './reality/14/clients.ts';
import { slotRegulars } from './reality/19/groups.ts';
import type { ExpiringLot, QuietSlot, TodaySources } from './reality/19/ports.ts';
import { addDays, isRecord } from './reality/19/wire.ts';

export function couponRecommendations(inventoryUrl: string, inventoryToken: string): Pick<TodaySources, 'quietSlots' | 'expiringLots'> {
  const inventory = new URL(inventoryUrl);
  return {
    async quietSlots(db, storeId, day, { timezone }) {
      // Use the same four closed weeks and 60% of the usual hourly volume as the slot coupon widget.
      const { rows: quietHours } = await db.query<{ date: string; hour: number }>(`
        WITH sales AS (
          SELECT s.business_date, extract(dow FROM s.business_date)::int AS weekday,
            extract(hour FROM s.occurred_at AT TIME ZONE $3)::int AS hour
          FROM marketing.r19_sale s
          WHERE s.store_id = $1 AND s.business_date >= $2::date - 28 AND s.business_date < $2::date
            AND s.amount + coalesce((SELECT sum(c.amount_delta) FROM marketing.r19_sale_correction c
              WHERE c.store_id = s.store_id AND c.settlement_id = s.settlement_id), 0) > 0
        ), observations AS (
          SELECT count(DISTINCT business_date) AS days FROM sales
        ), observed_weekdays AS (
          SELECT weekday, count(DISTINCT business_date) AS days FROM sales GROUP BY weekday HAVING count(DISTINCT business_date) >= 2
        ), observed_hours AS (
          SELECT hour, count(*) AS sales FROM sales GROUP BY hour
        ), hourly_weekdays AS (
          SELECT weekday, hour, count(*) AS sales FROM sales GROUP BY weekday, hour
        )
        SELECT ($2::date + future.day_offset)::text AS date, hour.hour
        FROM generate_series(1, 7) future(day_offset)
        JOIN observed_weekdays day ON day.weekday = extract(dow FROM $2::date + future.day_offset)
        CROSS JOIN observations observed CROSS JOIN observed_hours hour
        LEFT JOIN hourly_weekdays history ON history.weekday = day.weekday AND history.hour = hour.hour
        WHERE coalesce(history.sales, 0) * observed.days * 100 < hour.sales * day.days * 60
        ORDER BY future.day_offset, hour.hour`, [storeId, day, timezone]);
      const slots: QuietSlot[] = [];
      for (const { date, hour } of quietHours) {
        const last = slots.at(-1);
        if (last?.date === date && last.endHour === hour) last.endHour = hour + 1;
        else slots.push({ slotId: `slot-${date}-${hour}`, date, startHour: hour, endHour: hour + 1, regulars: 0, handled: false });
      }
      if (!slots.length) return [];
      const { rows: handled } = await db.query<{ id: string }>(`
        SELECT value AS id FROM marketing.coupon c, jsonb_array_elements_text(c.origin_ref->'slotIds')
        WHERE c.store_id = $1 AND c.origin = 'slot' AND c.status <> 'ended' AND c.ends_on >= $2::date`, [storeId, day]);
      const handledIds = new Set(handled.map(row => row.id));
      for (const slot of slots) {
        slot.handled = handledIds.has(slot.slotId);
        if (slot.handled) continue;
        const weekday = new Date(slot.date).getUTCDay();
        slot.regulars = (await slotRegulars(db, storeId, { day: addDays(day, -1), weekday,
          startHour: slot.startHour, endHour: slot.endHour, timezone })).length;
      }
      return slots;
    },
    async expiringLots(db, storeId, day, actorId, { timezone, dayStart }) {
      const url = new URL(`/internal/v1/inventory/stores/${storeId}/coupon-expiring-lots`, inventory);
      url.searchParams.set('businessDate', day);
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2_500),
        headers: ownerHeaders(inventoryToken, { storeId, actorId, timezone, dayStart }) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Inventory expiry candidates unavailable');
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || !Array.isArray(body.items)) throw new Error('Invalid Inventory expiry candidates');
      const { rows: handled } = await db.query<{ lotKey: string }>(`
        SELECT lot_key AS "lotKey" FROM marketing.coupon WHERE store_id=$1 AND origin='expiry' AND business_date=$2::date`, [storeId, day]);
      const handledLots = new Set(handled.map(row => row.lotKey));
      return body.items.map((row: Omit<ExpiringLot, 'handled'>): ExpiringLot => ({ ...row, handled: handledLots.has(row.lotId) }));
    },
  };
}
