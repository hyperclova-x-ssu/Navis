import { defineBundle, useBundle } from '../../../i18n';

const copy = defineBundle({
  id: 'real-manuals',
  ko: { 'manuals.publish': '게시하기', 'manuals.publishQuestion': '매뉴얼을 게시할까요?', 'manuals.deleteQuestion': '이 문서를 지울까요?' },
  en: { 'manuals.publish': 'Publish', 'manuals.publishQuestion': 'Publish this manual?', 'manuals.deleteQuestion': 'Delete this document?' },
  'zh-Hans': { 'manuals.publish': '发布', 'manuals.publishQuestion': '发布这份手册？', 'manuals.deleteQuestion': '删除这份文档？' },
  'zh-Hant': { 'manuals.publish': '發布', 'manuals.publishQuestion': '發布這份手冊？', 'manuals.deleteQuestion': '刪除這份文件？' },
});

export const useManualsCopy = () => useBundle(copy);
