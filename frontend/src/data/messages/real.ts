/**
 * REAL-PLAN F00: shared state and error sentences of HTTP (real) domains. Key → [ko, en, zh-Hans, zh-Hant].
 * Domain-specific backend reasons map to their own keys through `DomainAdapter.errorKeys`.
 */
import type { Row } from './sourced';
import { localRows } from '../reality/13/messages';
import { bookingRows } from '../reality/06/messages';
import { inboxRows } from '../reality/15/messages';
import { groupsRows } from '../reality/19/messages';

const rejected: Row = ['실행하지 못했어요 · {reason}', "Couldn't complete this · {reason}", '未能执行 · {reason}', '未能執行 · {reason}'];
const rejectedWithNext: Row = [`${rejected[0]}. {next}`, `${rejected[1]}. {next}`, `${rejected[2]}。{next}`, `${rejected[3]}。{next}`];
const invalid: Row = ['입력한 내용이 맞지 않아요', 'Some details are invalid', '部分输入有误', '部分輸入有誤'];
const checkInput: Row = ['입력값을 확인해 주세요', 'Check what you entered', '请检查输入内容', '請檢查輸入內容'];
const blocked: Row = ['현재 상태에선 진행할 수 없어요', 'The current state prevents this action', '当前状态下无法继续', '目前狀態下無法繼續'];
const checkState: Row = ['최신 내용을 확인해 주세요', 'Check the latest details', '请检查最新内容', '請檢查最新內容'];
const missing: Row = ['대상을 찾을 수 없어요', 'The item could not be found', '找不到该项目', '找不到該項目'];
const reopenList: Row = ['목록을 다시 열어 주세요', 'Reopen the list', '请重新打开列表', '請重新開啟清單'];
const unavailable: Row = ['지금은 처리할 수 없어요', 'This action is currently unavailable', '暂时无法处理', '暫時無法處理'];
const tryLater: Row = ['잠시 뒤 다시 시도해 주세요', 'Try again in a moment', '请稍后重试', '請稍後重試'];

function failureRow(reason: Row, next: Row): Row {
  const at = (index: 0 | 1 | 2 | 3) => rejectedWithNext[index].replace('{reason}', reason[index]).replace('{next}', next[index]);
  return [at(0), at(1), at(2), at(3)];
}

export const realRows = {
  ...localRows,
  ...bookingRows,
  ...inboxRows,
  ...groupsRows,
  'data.real.loading': ['불러오는 중이에요', 'Loading', '正在加载', '正在載入'],
  'data.real.error': ['자료를 불러오지 못했어요', "Couldn't load this", '无法加载数据', '無法載入資料'],
  'data.real.stale': ['최신 자료가 아닐 수 있어요', 'This may be out of date', '数据可能不是最新的', '資料可能不是最新的'],
  'data.real.partial': ['일부 자료만 보여드려요', 'Showing part of the data', '仅显示部分数据', '僅顯示部分資料'],
  'data.real.error.STALE_REVISION': ['그사이 내용이 바뀌었어요. 새로 불러왔으니 다시 확인해 주세요', 'This changed in the meantime. Reloaded; please check again', '内容已变化，已重新加载，请再确认', '內容已變更，已重新載入，請再確認'],
  'data.real.error.IDEMPOTENCY_MISMATCH': ['같은 요청이 다른 내용으로 들어왔어요. 처음부터 다시 해 주세요', 'The same request arrived with different content. Please start again', '相同请求带有不同内容，请重新开始', '相同請求帶有不同內容，請重新開始'],
  'data.real.error.IDEMPOTENCY_CONFLICT': ['같은 요청이 다른 내용으로 들어왔어요. 처음부터 다시 해 주세요', 'The same request arrived with different content. Please start again', '相同请求带有不同内容，请重新开始', '相同請求帶有不同內容，請重新開始'],
  'data.real.error.OUTCOME_UNKNOWN': ['처리 결과를 확인해 주세요', 'Check the result of the action', '请确认处理结果', '請確認處理結果'],
  'data.real.error.SESSION_ENDED': ['로그인이 끝났어요. 다시 들어와 주세요', 'You were signed out. Please sign in again', '登录已结束，请重新登录', '登入已結束，請重新登入'],
  'data.real.error.SOURCE_UNAVAILABLE': ['지금은 서버에 연결할 수 없어요', "Can't reach the server right now", '目前无法连接服务器', '目前無法連線伺服器'],
  'data.real.error.UNDO_EXPIRED': ['되돌릴 수 있는 시간이 지났어요', 'The time to undo has passed', '可撤销的时间已过', '可復原的時間已過'],
  'data.real.error.UNDO_UNAVAILABLE': ['지금은 되돌릴 수 없어요', "Can't undo this now", '现在无法撤销', '現在無法復原'],
  'data.real.error.ASYNC_REQUIRED': ['저장이 끝날 때까지 기다려야 하는 동작이에요', 'This action has to wait until it is saved', '此操作需等待保存完成', '此操作需等待儲存完成'],
  'data.real.error.NOT_FOUND': ['대상을 찾을 수 없어요', "Can't find this item", '找不到该项目', '找不到該項目'],
  'data.real.error.VALIDATION': ['입력한 내용을 확인해 주세요', 'Please check what you entered', '请检查输入的内容', '請檢查輸入的內容'],
  'data.real.error.FILE_INVALID': ['사진 파일을 올릴 수 없어요', "Can't upload this photo", '无法上传该照片', '無法上傳該照片'],
  'data.real.error.BAD_RESPONSE': ['서버 응답을 읽지 못했어요', "Couldn't read the server's answer", '无法读取服务器响应', '無法讀取伺服器回應'],
  'data.real.error.GENERIC': ['처리하지 못했어요', "Couldn't complete this", '无法完成处理', '無法完成處理'],
  'data.real.commandFailure.withReason': rejected,
  'data.real.commandFailure.withNext': rejectedWithNext,
  'data.real.commandFailure.reason.VALIDATION': invalid,
  'data.real.commandFailure.next.VALIDATION': checkInput,
  'data.real.commandFailure.result.VALIDATION': failureRow(invalid, checkInput),
  'data.real.commandFailure.reason.CONFLICT': blocked,
  'data.real.commandFailure.next.CONFLICT': checkState,
  'data.real.commandFailure.result.CONFLICT': failureRow(blocked, checkState),
  'data.real.commandFailure.reason.NOT_FOUND': missing,
  'data.real.commandFailure.next.NOT_FOUND': reopenList,
  'data.real.commandFailure.result.NOT_FOUND': failureRow(missing, reopenList),
  'data.real.commandFailure.reason.PREVIEW_FAILURE': unavailable,
  'data.real.commandFailure.next.PREVIEW_FAILURE': tryLater,
  'data.real.commandFailure.result.PREVIEW_FAILURE': failureRow(unavailable, tryLater),
  'data.real.receipt.previousChange': ['이전 변경을 되돌릴 수 있어요', 'You can undo the previous change', '可以撤销上一项更改', '可以復原上一項變更'],
} as const satisfies Readonly<Record<string, Row>>;
