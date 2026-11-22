import { defineBundle, useBundle } from '../../../i18n';

const copy = defineBundle({
  id: 'widget.tax-records',
  ko: {
    payments: '납부 기록', review: '확인 완료로 표시하기', loading: '저장 중이에요', noData: '자료가 없어요', cashReceiptsUnavailable: '앱에서는 볼 수 없어요',
    deletePayment: '납부 기록을 지울까요?', deleteFile: '첨부한 증빙을 빼겠어요?', file: '증빙 파일', attach: '첨부하기',
    attached: '증빙 있음', missing: '증빙 없음', files: '증빙 파일 보기', fileNumber: '증빙 파일 {n}',
    detach: '첨부 빼기', uploadError: '증빙을 첨부하지 못했어요', exportError: '파일을 받지 못했어요',
    previewChanged: '자료가 바뀌었어요. 미리보기를 다시 확인해 주세요',
    unverified: '자료 합계가 장부와 일치하지 않아요', format: '파일 형식', downloaded: '파일을 받았어요',
    paidTotal: '납부 완료 금액', unpaidTotal: '납부 전 금액',
    classifiedExpenses: '증빙 종류를 적은 지출', unclassifiedExpenses: '증빙 종류를 적지 않은 지출',
    paymentsWithFiles: '증빙 파일을 붙인 납부 기록',
  },
  en: {
    payments: 'Payment records', review: 'Mark as reviewed', loading: 'Saving', noData: 'No data available', cashReceiptsUnavailable: 'Not available in the app',
    deletePayment: 'Delete this payment record?', deleteFile: 'Remove this attachment?', file: 'Evidence file', attach: 'Attach',
    attached: 'Evidence attached', missing: 'No evidence', files: 'View evidence files', fileNumber: 'Evidence file {n}',
    detach: 'Remove attachment', uploadError: 'Could not attach evidence', exportError: 'Could not download the file',
    previewChanged: 'The records changed. Review the new preview',
    unverified: 'The totals differ from the ledger', format: 'File format', downloaded: 'File downloaded',
    paidTotal: 'Amount paid', unpaidTotal: 'Amount due',
    classifiedExpenses: 'Expenses with an evidence type', unclassifiedExpenses: 'Expenses without an evidence type',
    paymentsWithFiles: 'Payments with an attached file',
  },
  'zh-Hans': {
    payments: '缴纳记录', review: '标记为已核对', loading: '正在保存', noData: '没有资料', cashReceiptsUnavailable: '应用内无法查看',
    deletePayment: '删除这条缴纳记录吗？', deleteFile: '移除此凭证附件吗？', file: '凭证文件', attach: '添加附件',
    attached: '有凭证', missing: '无凭证', files: '查看凭证文件', fileNumber: '凭证文件 {n}',
    detach: '移除附件', uploadError: '无法添加凭证', exportError: '无法下载文件',
    previewChanged: '记录有变化，请查看新的预览', unverified: '合计金额与账本不符', format: '文件格式', downloaded: '已下载文件',
    paidTotal: '已缴金额', unpaidTotal: '待缴金额',
    classifiedExpenses: '已记录凭证类型的支出', unclassifiedExpenses: '未记录凭证类型的支出',
    paymentsWithFiles: '已添加凭证文件的缴纳记录',
  },
  'zh-Hant': {
    payments: '繳納紀錄', review: '標記為已核對', loading: '正在儲存', noData: '沒有資料', cashReceiptsUnavailable: '應用程式內無法查看',
    deletePayment: '刪除這筆繳納紀錄嗎？', deleteFile: '移除此憑證附件嗎？', file: '憑證檔案', attach: '加入附件',
    attached: '有憑證', missing: '無憑證', files: '查看憑證檔案', fileNumber: '憑證檔案 {n}',
    detach: '移除附件', uploadError: '無法加入憑證', exportError: '無法下載檔案',
    previewChanged: '紀錄有變動，請查看新的預覽', unverified: '合計金額與帳本不符', format: '檔案格式', downloaded: '已下載檔案',
    paidTotal: '已繳金額', unpaidTotal: '待繳金額',
    classifiedExpenses: '已記錄憑證類型的支出', unclassifiedExpenses: '未記錄憑證類型的支出',
    paymentsWithFiles: '已加入憑證檔案的繳納紀錄',
  },
});

export const useTaxCopy = () => useBundle(copy).t;
