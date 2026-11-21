import type { MessageBundle } from '../../../i18n';

const ko = {
  'table.move': '옮기기', 'table.merge': '합석', 'table.separate': '분리',
  'table.movePrompt': 'T{n} 계산서를 옮길 테이블을 골라 주세요',
  'table.mergePrompt': '합칠 테이블을 골라 주세요',
  'table.separatePrompt': '새 계산서를 놓을 빈 테이블을 골라 주세요',
  'table.here': '여기로', 'table.close': '닫기', 'table.next': '다음',
  'table.separateTitle': '계산서 분리',
  'table.noDestination': '옮길 빈 테이블이 없어요',
  'table.partialLocked': '부분 결제 중에는 합치거나 나눌 수 없어요',
  'table.moved': 'T{n}로 옮겼어요', 'table.merged': '{table, particle, 과/와} 합쳤어요', 'table.separated': 'T{n}로 나눴어요',
  'table.shared': '{tables, particle, 과/와} 나눔',
} as const;
export const tableTransferBundle: MessageBundle<keyof typeof ko> = { id: 'pos-table-transfer', ko, en: {}, 'zh-Hans': {}, 'zh-Hant': {} };
