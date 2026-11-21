// Curated Korean excerpts from the mock seed and its localized messages.
// The server does not read the browser snapshot, reviewer identities, or edits.
import manifest from '../../src/data/db/generated/manifest.json' with { type: 'json' };
import drafts from '../../src/data/db/generated/widget-drafts.json' with { type: 'json' };
import { storeHoursGroundingKo, sundayHoursSentenceKo } from './store-hours.mjs';

const lattePart = id => manifest.latteRecipe.find(part => part.itemId === id).quantityBase;
export const LATTE_RECIPE = Object.freeze({ beansG: lattePart('i-bean-house'), milkMl: lattePart('i-milk') });
const cafe = `${manifest.store.name}를 운영합니다.`;
const grant = (notice, plans) => ({
  facts: { ...notice, store: cafe, plans },
  sourceLabels: ['예시 지원 공고', '예시 매장 계획'],
});

const manual = (title, category, note, steps) => ({
  facts: { title, category, note, steps },
  sourceLabels: ['예시 메모', '매뉴얼 예시 자료'],
});

const reply = (type, original, guidance, approved) => ({
  facts: { type, original, guidance, approved },
  sourceLabels: guidance ? ['예시 원문', '예시 매장 안내'] : ['예시 원문'],
});

const praise = original => reply('리뷰', original, null, [
  '좋은 리뷰 남겨 주셔서 감사합니다.',
  '방문해 주셔서 감사합니다.',
  '다음에 또 들러 주세요.',
]);

export const legacyWidgetFixtures = {
  grants: {
    'g-stability': grant({
      title: '소상공인 경영안정 지원', agency: '소상공인 지원 기관', region: '전국',
      eligibility: '연 매출 3억 원 이하, 개업 1년 이상', deadline: '2026-10-30 18:00',
    }, ['운영 자금에 활용하려고 합니다.', '경영 상담을 받아 운영 계획을 점검하려고 합니다.']),
    'g-smart': grant({
      title: '스마트 상점 도입 지원', agency: '시 경제정책과', region: '서울 전 지역',
      eligibility: '직원 5명 미만, 키오스크·POS 도입 계획', deadline: '2026-11-06 18:00',
    }, ['POS 도입에 활용하려고 합니다.', '스마트 기기 도입 비용을 검토하려고 합니다.']),
    'g-digital': grant({
      title: '디지털 전환 지원', agency: '소상공인 지원 기관', region: '전국',
      eligibility: null, deadline: '2026-09-15 18:00',
    }, ['매장 운영 업무를 디지털화하려고 합니다.', '도입할 도구와 운영 절차를 검토하려고 합니다.']),
  },
  manuals: {
    'mn-open': manual('오픈 준비', 'opening', '오픈 전 조명·장비·재고 점검', [
      '조명과 음악을 켜요', '커피 머신을 예열하고 첫 샷은 버려요', '우유와 원두 재고를 확인해요',
      '진열대에 디저트를 채워요', 'POS를 켜고 거스름돈을 확인해요',
    ]),
    'mn-close': manual('마감 정리', 'closing', '마감 전 우유·청소·POS 확인', [
      '남은 우유는 냉장고에 넣어요', '커피 머신을 세척해요',
      '바닥을 청소하고 쓰레기를 내놓아요', 'POS를 마감하고 매출을 확인해요',
    ]),
    'mn-newstaff': manual('새 직원 안내', 'new-staff', '첫 출근 때 확인할 것', [
      '출근하면 근무표를 확인해요', '손을 씻고 앞치마를 입어요', '오픈 매뉴얼을 함께 봐요',
    ]),
    'mn-latte': manual('카페라테 레시피', 'recipe', '라테 샷과 우유 준비', [
      `원두 ${LATTE_RECIPE.beansG} g으로 샷 2잔을 내려요`, `우유 ${LATTE_RECIPE.milkMl} mL를 스팀해요`, '샷 위에 우유를 붓고 거품을 올려요',
    ]),
    'mn-americano': manual('아메리카노 레시피', 'recipe', '샷에 뜨거운 물을 더해요', [
      '샷 2잔을 내려요', '뜨거운 물 250 mL를 부어요',
    ]),
    'mn-machine': manual('커피 머신 세척', 'cleaning', '그룹 헤드와 스팀 노즐 세척', [
      '그룹 헤드에 물을 흘려보내요', '세제로 백플러싱해요', '스팀 노즐을 닦아요',
    ]),
    'mn-restroom': manual('화장실 청소', 'cleaning', '화장실 소모품과 바닥 확인', [
      '휴지와 핸드타월을 채워요', '세면대와 바닥을 닦아요',
    ]),
    'mn-recycling': manual('분리수거', 'cleaning', '컵을 비운 뒤 나눠요', [
      '컵과 뚜껑을 나눠 버려요', '음료는 비우고 헹궈서 버려요',
    ]),
    'mn-milk': manual('우유 보관 방법', 'cleaning', '우유는 받자마자 냉장고에', [
      '받은 우유는 바로 냉장고 아래 칸에 넣어요', '먼저 받은 우유부터 써요',
      '유통기한이 지난 우유는 버리고 기록해요',
    ]),
  },
  'ai-response': {
    'th-1': reply('메시지', '어제 산 원두가 너무 시어요. 환불받을 수 있을까요?', null, [
      '불편을 드려 죄송합니다.', '말씀해 주신 내용을 확인하겠습니다.',
    ]),
    'th-2': reply('메시지', '주차할 곳이 있나요?', '주차: 건물 뒤 2대', [
      '건물 뒤에 2대까지 주차할 수 있어요.', '건물 뒤 주차 공간은 2대까지 이용하실 수 있어요.',
    ]),
    // The published store-info manual takes precedence over the legacy draft.
    'th-3': reply('메시지', '일요일에도 문 여나요?', storeHoursGroundingKo(), [
      sundayHoursSentenceKo(), '일요일에도 영업해요.',
    ]),
    'th-4': reply('리뷰', '주말 오후에 갔는데 자리가 없어서 한참 기다렸어요.', null, [
      '오래 기다리시게 해서 죄송해요.', '기다리게 해 드려 죄송합니다.', '의견 남겨 주셔서 감사합니다.',
    ]),
    'th-5': reply('메시지', '지하철역에서 어떻게 가요?', '역 2번 출구에서 걸어서 5분', [
      '역 2번 출구에서 걸어서 5분이에요.', '역 2번 출구에서 오시면 돼요.',
    ]),
    'th-r1': praise('디카페인 라테도 고소해요! 저녁에도 부담 없이 마셔요.'),
    'th-r2': praise('크루아상이 바삭하고 버터 향이 좋아요.'),
    'th-r3': praise('직원분들이 친절하고 자리가 편해요.'),
    'th-r4': praise('라테 거품이 부드러워요. 단골 될 것 같아요.'),
    'th-r5': praise('창가 자리에서 책 읽기 좋아요.'),
    'th-r6': praise('아메리카노가 깔끔하고 가격도 괜찮아요.'),
    'th-empty': null,
  },
};


const cafeGrants = Object.fromEntries(drafts.grants.map(row => [row.id, grant({
  title: row.title, agency: row.agency, region: row.region, eligibility: row.conditions.join(', '), deadline: `${row.applyEnd} 18:00`,
}, [row.summary])]));
const cafeManuals = Object.fromEntries(drafts.manuals.map(row =>
  [row.manualId, manual(row.title, row.category, row.cautions, row.steps)]));
const cafeThreads = Object.fromEntries(drafts.threads.map(row => {
  if (row.type === 'review' && row.sentiment === 'positive') return [row.threadId, praise(row.body)];
  const text = row.body;
  const type = row.type === 'review' ? '리뷰' : row.type === 'call' ? '전화' : '메시지';
  if (/일요일/.test(text) && /영업|열|문/.test(text)) {
    return [row.threadId, reply(type, text, storeHoursGroundingKo(), [sundayHoursSentenceKo()])];
  }
  if (/영업시간|몇 시에/.test(text) && row.type !== 'review') {
    return [row.threadId, reply(type, text, storeHoursGroundingKo(), [storeHoursGroundingKo()])];
  }
  return [row.threadId, reply(type, text, null, ['말씀해 주신 내용을 확인하겠습니다.', '의견 남겨 주셔서 감사합니다.'])];
}));

export const widgetFixtures = {
  grants: { ...legacyWidgetFixtures.grants, ...cafeGrants },
  manuals: { ...legacyWidgetFixtures.manuals, ...cafeManuals },
  'ai-response': { ...legacyWidgetFixtures['ai-response'], ...cafeThreads },
};
