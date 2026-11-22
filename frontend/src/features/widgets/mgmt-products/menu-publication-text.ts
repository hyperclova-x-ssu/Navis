import { useBundle, type MessageBundle } from '../../../i18n';

const labels = {
  ko: ['미리보기', '닫기', '불러오고 있어요', '다시 시도하기', '정보를 불러올 수 없어요', '올릴 변경 사항이 없어요', '정보가 바뀌었거나 시간이 지났어요. 다시 미리보기를 열어 주세요', '결과를 확인하지 못했어요', '같은 요청 다시 확인하기', '확인하고 있어요', '요청을 처리할 수 없어요', '변경 전', '변경 후', '사진 삭제 확인', '이 사진을 플레이스 업체 정보에서 뺄까요?', '확인하고 실행하기'],
  en: ['Preview', 'Close', 'Loading', 'Retry', 'Could not load the information', 'There are no changes to publish', 'The information changed or the preview expired. Open a new preview.', 'The result could not be verified', 'Check the same request again', 'Checking', 'Could not process this request', 'Before', 'After', 'Confirm photo removal', 'Remove these photos from the Place business listing?', 'Confirm action'],
  'zh-Hans': ['预览', '关闭', '正在加载', '重试', '无法加载信息', '没有要发布的更改', '信息已更改或预览已过期，请重新预览', '无法确认结果', '重新确认同一请求', '正在确认', '无法处理此请求', '之前', '之后', '确认移除照片', '要从 Place 商家信息中移除这些照片吗？', '确认执行'],
  'zh-Hant': ['預覽', '關閉', '正在載入', '重試', '無法載入資訊', '沒有要發布的變更', '資訊已變更或預覽已過期，請重新預覽', '無法確認結果', '重新確認同一請求', '正在確認', '無法處理此請求', '之前', '之後', '確認移除照片', '要從 Place 商家資訊中移除這些照片嗎？', '確認執行'],
};
const keys = ['preview', 'close', 'loading', 'retry', 'readError', 'noChanges', 'stale', 'uncertain', 'recheck', 'checking', 'failure', 'before', 'after', 'confirmRemoval', 'removePrompt', 'confirmAction'] as const;
const messages = (values: string[]) => Object.fromEntries(keys.map((key, index) => [key, values[index]]));
const bundle: MessageBundle<string> = { id: 'gap-inv.card', ko: messages(labels.ko), en: messages(labels.en), 'zh-Hans': messages(labels['zh-Hans']), 'zh-Hant': messages(labels['zh-Hant']) };
export const usePublicationText = () => useBundle(bundle).t;
