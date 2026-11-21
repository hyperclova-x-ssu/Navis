import { describe, expect, it } from 'vitest';
import { createTranslator } from './translator';
import { commonBundle, widgetNamesBundle } from './messages';
import type { MessageBundle } from './types';
import { getLayerCatalog, searchFeatures } from '../catalog';

const management = {
  menu: ['메뉴', '파는 메뉴의 판매가와 레시피, 메모를 한곳에서 관리해요. 메뉴를 누르면 레시피를 고치고 원가를 바로 볼 수 있어요.'],
  'inventory-booking': ['재고', '재료의 현재 재고와 안전 재고를 표로 보여 줘요. 칸을 눌러 바로 고치고, 모자란 품목은 발주에서 알려 드려요.'],
  suppliers: ['발주', '발주 조건과 발주사, 발주 내역을 관리해요. 받은 수량을 기록하면 재고에 바로 반영돼요.'],
  ledger: ['손익', '오늘 매출과 지출, 순이익을 보여 줘요. 지출을 바로 기록하고 마감 정산 상태도 확인해요.'],
  margin: ['마진', '품목마다 원가와 판매가, 남는 돈을 비교해 보여 줘요. 원가는 메뉴 레시피와 발주 단가로 계산해요.'],
  tax: ['세무관리', '세무사에게 보낼 자료를 모으고 세금 납부 기록을 관리해요. 납부 기한은 캘린더와 브리핑에서 알려 드려요.'],
  members: ['회원목록', '회원의 등급과 방문, 메모를 관리해요. 회원을 누르면 회원권 남은 횟수를 보고 1회 사용을 기록해요.'],
  'customer-analysis': ['CCTV 현황', '카메라가 잘 작동하는지와 손님이 몰리는 시간을 함께 보여 줘요. 화면은 예시 정지 화면이에요.'],
  manuals: ['매뉴얼 작성', '인수인계 문서와 매장 정보를 정리해 둬요. 오픈·마감은 체크리스트로 쓸 수 있어요.'],
  grants: ['정부지원', '우리 가게가 볼 만한 지원사업을 마감순으로 보여 줘요. 신청한 사업은 진행 상태까지 기록해요.'],
  calendar: ['캘린더', '매장 운영과 발주 납기, 세금 일정을 한곳에서 봐요. 월·주·일로 바꿔 보고 일정을 직접 더해요.'],
  'voice-booking': ['예약', '예약을 등록하고 상태를 관리해요. 테이블 배치가 있으면 맞는 테이블을 골라 드려요.'],
  briefing: ['브리핑', '오늘 일정과 예약, 중요 알림을 모아 출근·퇴근 때 알려 줘요. 항목을 누르면 그 패널로 가요.'],
} as const;

const managementAliases: Record<keyof typeof management, string> = {
  menu: '레시피|판매가|메뉴판',
  'inventory-booking': '입고|재료|판매 상품',
  suppliers: '입고|발주|주문',
  ledger: '매출|지출|장부|수입',
  margin: '마진|원가|원가 분석|마진율',
  tax: '세금|부가세|세무|신고',
  members: '회원|손님|등급|회원권',
  'customer-analysis': 'CCTV|손님 분석|방문',
  manuals: '세컨드브레인|오픈 준비|마감 정리|체크리스트',
  grants: '지원금|보조금|소상공인 교육|정책',
  calendar: '달력|일정|스케줄|To-Do',
  'voice-booking': '예약 확정|전화 예약|예약',
  briefing: '출근|퇴근',
};

describe('반복 5 한국어 fallback', () => {
  it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('%s 관리 이름과 설명 및 검색 별칭은 확정 한국어다', locale => {
    const t = createTranslator<string>(locale, widgetNamesBundle);
    for (const [id, [title, coach]] of Object.entries(management)) {
      expect(t.t(`widget.${id}.title`)).toBe(title);
      expect(t.t(`widget.${id}.coach`)).toBe(coach);
      expect(t.t(`widget.${id}.aliases`)).toBe(managementAliases[id as keyof typeof management]);
    }
  });
  it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('%s 관리 검색은 제목과 별칭을 찾고 옛 이름은 찾지 않는다', locale => {
    const t = createTranslator<string>(locale, widgetNamesBundle);
    const features = getLayerCatalog('A', 'management');
    const search = (query: string) => searchFeatures(features, query, feature => [
      t.t(feature.nameKey), ...t.t(feature.aliasesKey).split('|'),
    ]).map(feature => feature.id);

    for (const [id, aliases] of Object.entries(managementAliases)) {
      for (const query of [management[id as keyof typeof management][0], ...aliases.split('|')]) {
        expect(search(query), `${query} → ${id}`).toContain(id);
      }
    }
    for (const query of ['가계부', '마진·원가분석', '세금계산', 'CCTV 손님분석', '음성 예약확정', '재고관리', '거래처', '회원권 관리', '손님예측', '알바모집', '매장 인테리어', '사진으로 자리 배치', '뉴스레터', '알바 효율', '소식']) {
      expect(search(query), query).toEqual([]);
    }
    expect(search('회원권')).toContain('members');
  });
  it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('%s 새 관리 묶음 이름과 레일은 한국어다', locale => {
    const t = createTranslator<string>(locale, commonBundle);
    for (const [key, value] of Object.entries({ products:'상품', stock:'재고', finance:'재무', members:'회원', store:'매장', misc:'기타', schedule:'일정' })) {
      expect(t.t(`group.${key}`)).toBe(value);
      expect(t.t(`group.rail.${key}`)).toBe(value);
    }
  });
  it('기존 마케팅과 공통 번역은 유지한다', () => {
    expect(createTranslator<string>('en', widgetNamesBundle).t('widget.slot-coupon.title')).toBe('Quiet-hour coupons');
    expect(createTranslator<string>('ko', widgetNamesBundle).t('widget.slot-coupon.aliases')).toBe('쿠폰|한산한 시간|단골|빈 시간');
    expect(createTranslator<string>('en', widgetNamesBundle).t('widget.slot-coupon.aliases')).toBe('coupon|quiet hours|regulars|slow time');
    expect(createTranslator<string>('zh-Hant', commonBundle).t('common.undo')).toBe('復原');
    expect(createTranslator<string>('en', commonBundle).t('group.money')).toBe('Money');
  });
  it('한국어 fallback의 복수형은 선택 언어가 아닌 한국어 규칙을 따른다', () => {
    const b: MessageBundle<string> = { id:'plural', ko:{'x.count':'{n, plural, one {하나} other {기타}}'}, en:{}, 'zh-Hans':{}, 'zh-Hant':{} };
    expect(createTranslator('en', b).t('x.count', { n: 1 })).toBe('기타');
  });
});
