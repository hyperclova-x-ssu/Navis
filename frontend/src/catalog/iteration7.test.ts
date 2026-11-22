import { describe, expect, it } from 'vitest';
import { getLayerCatalog, getRegistration, listFeatures } from './index';

describe('M3 catalog (API-279)', () => {
  it('adds the staff schedule to management and finds both aliases', () => {
    expect(getLayerCatalog('A', 'management')).toHaveLength(17);
    expect(getLayerCatalog('A', 'marketing')).toHaveLength(12);
    expect(getRegistration('staff-schedule')).toMatchObject({ label: '직원 스케줄표', layer: 'management', groupId: 'misc' });
    for (const query of ['근무표', '시간표']) {
      expect(listFeatures({ presetId: 'A', layer: 'management', query }).map(f => f.id)).toContain('staff-schedule');
    }
  });
  it('registers member money in its own member group with all account aliases', () => {
    expect(getRegistration('credit-receivable')).toMatchObject({ label: '충전금·외상 관리', layer: 'management', groupId: 'members', detail: { frame: 'large', kind: 'list-work' } });
    for (const query of ['충전', '외상', '미수금']) expect(listFeatures({ presetId: 'A', layer: 'management', query }).map(f => f.id)).toContain('credit-receivable');
  });
  it('places the three landed widgets in their specified layers and groups', () => {
    for (const [id, label, layer, groupId, alias] of [
      ['notice-send', '공지 발송', 'marketing', 'news', '휴무'],
      ['store-environment', '매장 환경', 'management', 'store', '온도'],
      ['custom-order', '주문제작', 'management', 'products', '맞춤 주문'],
    ] as const) {
      expect(getRegistration(id)).toMatchObject({ label, layer, groupId });
      expect(listFeatures({ presetId: 'A', layer, query: alias }).map(f => f.id)).toContain(id);
    }
  });
});
