// N19 briefing, CCTV and store environment. Facts, answers and card text come from the stored selectors or from fixed
// localized strings in this file. Every write is a proposal; nothing here commits on typed text.
import type { DetailRef, FeatureId, Locale, QueryCondition, RunState } from '../../../contracts';
import { handlers, type HandlerContext, type HandlerResult } from '../../../data/commands/handlers';
import { selectCctvReviewTarget } from '../../../data/commands/management-guards';
import type { DataCommand } from '../../../data/commands/types';
import { CCTV_SNAPSHOT } from '../../../data/cctv/snapshot';
import { isIsoDate, TODAY } from '../../../data/db/time';
import type { DataSnapshot } from '../../../data/db/types';
import { selectStoreEnvironment, type StoreEnvironmentModel } from '../../../data/iteration7/environment';
import { dataSourceFor } from '../../../data/reality/00';
import { ackKey } from '../../../data/reality/12/ack';
import { cameraMeasurement, insightHours, insightPeak } from '../../../data/reality/10/observations';
import { NORMAL_VARIANT, resolveDataText, selectWidget } from '../../../data/widget-data';
import { createTranslator, type MessageBundle, type Translator } from '../../../i18n';
import { validateAgentCommandArgs, validateAgentDraft, validateAgentToolArgs, type AgentFact, type AgentReadArgs, type AgentReadProjection, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { cnnBaseUrl } from '../../cctv/live/config';
import { getLiveClient } from '../../cctv/live/hooks';
import { cctvBundle } from '../../cctv/messages';
import { getCctvMode, setCctvMode } from '../../cctv/live/mode';
import { mgmtMoneyBundle } from '../../widgets/mgmt-money/messages';
import { baseBundles } from '../../../i18n';
import { dataBundles } from '../../../data/widget-data';
import { navisTranslator } from '../messages';
import { normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisNumber } from '../navis-input';
import type { AgentProposalPreview } from '../navis-conversation';
import type { CommandAdapter, DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots, RecordAdapter, RecordSearch, RecordTargets, ReadToolAdapter, RunCommandAdapter, RunPreflight } from './registry';

/** D-327 Q5: Live is available only while a paired camera is connected now (the live client's own state), not merely when the server address is set.
 * The client holds its connection while the CCTV screen shows Live, so from the sample view this reads as no connected camera. */
const cameraConnected = () => getLiveClient().getSnapshot().connection === 'live';
const liveReady = () => cnnBaseUrl() !== null && cameraConnected();
const BRIEFING = 'briefing' as const;
const CCTV = 'customer-analysis' as const;
const ENV = 'store-environment' as const;
const features: readonly FeatureId[] = [BRIEFING, CCTV, ENV];

const pick = (locale: Locale, ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => !!value && typeof value === 'object' && !Array.isArray(value);
const dayOf = (snapshot: DataSnapshot) => snapshot.pos?.businessDate ?? TODAY;
const hhmm = (hour: number) => `${String(hour).padStart(2, '0')}:00`;
const realCctv = (snapshot: DataSnapshot) => snapshot.tables.storeEnvironment.source === 'manual' || dataSourceFor('cctv') === 'http';

/** Fixed sentences. Numbers and names are inserted from the selectors at the call site. */
function copy(locale: Locale) {
  const l = (ko: string, en: string, hans: string, hant: string) => pick(locale, ko, en, hans, hant);
  return {
    // facts
    temperature: l('매장 온도', 'Store temperature', '店内温度', '店內溫度'),
    humidity: l('매장 습도', 'Store humidity', '店内湿度', '店內濕度'),
    measuredAt: l('마지막 측정', 'Last measured', '最后测量', '最後測量'),
    sensor: l('온도 센서', 'Temperature sensor', '温度传感器', '溫度感測器'),
    sensorConnected: l('연결됨', 'Connected', '已连接', '已連線'), sensorDisconnected: l('연결 끊김', 'Disconnected', '连接中断', '連線中斷'), sensorNone: l('센서 없음', 'No sensor', '没有传感器', '沒有感測器'),
    environment: l('매장 환경', 'Store environment', '店内环境', '店內環境'),
    within: l('적정 범위 안', 'Within range', '在适宜范围内', '在適宜範圍內'), outside: l('적정 범위 벗어남', 'Out of range', '超出适宜范围', '超出適宜範圍'),
    hottest: l('오늘 가장 높았던 온도', "Today's highest temperature", '今天最高温度', '今天最高溫度'),
    coolest: l('오늘 가장 낮았던 온도', "Today's lowest temperature", '今天最低温度', '今天最低溫度'),
    tempRange: l('적정 온도 범위', 'Comfortable temperature range', '适宜温度范围', '適宜溫度範圍'),
    humidityRange: l('적정 습도 범위', 'Comfortable humidity range', '适宜湿度范围', '適宜濕度範圍'),
    playing: l('음악 재생', 'Music', '音乐播放', '音樂播放'), playingOn: l('재생 중', 'Playing', '播放中', '播放中'), playingOff: l('일시정지', 'Paused', '已暂停', '已暫停'),
    volume: l('음량', 'Volume', '音量', '音量'), track: l('재생 중인 곡', 'Current track', '当前曲目', '目前曲目'),
    playlist: l('지금 재생목록', 'Current playlist', '当前播放列表', '目前播放清單'), playlistOption: l('재생목록', 'Playlist', '播放列表', '播放清單'),
    musicDevice: l('음악 장치', 'Music device', '音乐设备', '音樂裝置'), deviceNone: l('연결된 장치 없음', 'No device', '没有设备', '沒有裝置'),
    trackReady: l('재생할 곡', 'Track ready', '可播放曲目', '可播放曲目'), yes: l('있음', 'Yes', '有', '有'), no: l('없음', 'No', '没有', '沒有'),
    // CCTV facts
    businessDate: l('기준 날짜', 'Business date', '营业日', '營業日'),
    visitsTotal: l('오늘 방문 감지', "Today's detected visits", '今日检测到的到访', '今日偵測到的到訪'),
    peakHour: l('방문이 가장 많은 시간', 'Busiest hour', '到访最多的时段', '到訪最多的時段'),
    peakVisits: l('피크 시간 방문', 'Peak-hour visits', '高峰时段到访', '高峰時段到訪'), peakStaff: l('피크 시간 근무', 'Peak-hour staff', '高峰时段在岗', '高峰時段在崗'),
    quietHour: l('가장 한산한 시간', 'Quietest hour', '最清闲的时段', '最清閒的時段'), quietVisits: l('한산한 시간 방문', 'Quietest-hour visits', '清闲时段到访', '清閒時段到訪'),
    coverage: l('집계한 시간대', 'Hours counted', '统计的时段', '統計的時段'),
    gapHour: l('방문 감지가 빠진 시간', 'Hour with missing detections', '检测缺失的时段', '偵測缺失的時段'), noGap: l('빠진 시간 없음', 'No missing hours', '没有缺失时段', '沒有缺失時段'),
    gapCount: l('방문 감지가 빠진 시간 수', 'Hours with missing detections', '检测缺失的时段数', '偵測缺失的時段數'),
    partly: l('일부만 집계', 'partly counted', '仅部分统计', '僅部分統計'), notCounted: l('집계 안 됨', 'not counted', '未统计', '未統計'),
    cameraUnit: (n: number) => l(`${n}대`, `${n}`, `${n} 台`, `${n} 台`),
    camera: l('카메라', 'Camera', '摄像头', '攝影機'), cameras: l('카메라 수', 'Cameras', '摄像头数量', '攝影機數量'),
    cameraProblem: l('확인이 필요한 카메라', 'Cameras to check', '需检查的摄像头', '需檢查的攝影機'),
    connected: l('연결됨', 'connected', '已连接', '已連線'), disconnected: l('연결 끊김', 'disconnected', '连接中断', '連線中斷'),
    recording: l('녹화 중', 'recording', '录像中', '錄影中'), stopped: l('녹화 중지', 'stopped', '已停止录像', '已停止錄影'),
    checkedAt: l('마지막 확인', 'last checked', '最后确认', '最後確認'),
    inStore: l('지금 매장 안(예시 장면)', 'In the store now (sample scene)', '店内人数（示例场景）', '店內人數（示範場景）'),
    occupants: l('지금 자리에 앉은 손님(예시 장면)', 'Seated guests (sample scene)', '就座顾客（示例场景）', '就座顧客（示範場景）'),
    tablesOccupied: l('사용 중인 테이블(예시 장면)', 'Tables in use (sample scene)', '使用中的桌子（示例场景）', '使用中的桌子（示範場景）'),
    tablesToClear: l('정리할 테이블', 'Tables to clear', '需整理的桌子', '需整理的桌子'),
    tablesEmpty: l('빈 테이블(예시 장면)', 'Empty tables (sample scene)', '空桌（示例场景）', '空桌（示範場景）'),
    dwell: l('평균 머문 시간(분, 예시 장면)', 'Average stay in minutes (sample scene)', '平均停留分钟（示例场景）', '平均停留分鐘（示範場景）'),
    mode: l('CCTV 보기 방식', 'CCTV view mode', 'CCTV 查看方式', 'CCTV 檢視方式'), modeMock: l('예시', 'Sample', '示例', '示範'), modeLive: l('실시간', 'Live', '实时', '即時'),
    liveAvailable: l('실시간 보기 사용 가능', 'Live view available', '可使用实时查看', '可使用即時檢視'),
    reviewMark: l('검토 표시', 'Review mark', '复查标记', '複查標記'), reviewMarked: l('표시함', 'Marked', '已标记', '已標記'), reviewOpen: l('표시 없음', 'Not marked', '未标记', '未標記'),
    // briefing facts
    importantAlerts: l('중요 알림', 'Important alerts', '重要提醒', '重要提醒'),
    arrivalItem: l('출근 브리핑 항목', 'Arrival briefing item', '到岗简报项目', '到崗簡報項目'),
    tierToday: l('오늘 할 일', "Today's work", '今日要做', '今日要做'), tierLoss: l('놓치면 손해', 'Costly to miss', '错过会有损失', '錯過會有損失'), tierInfo: l('알아두면 좋아요', 'Good to know', '值得了解', '值得了解'),
    reservationsToday: l('오늘 예약', "Today's reservations", '今日预约', '今日預約'), reservationChanges: l('변경 및 취소', 'Changes and cancellations', '变更及取消', '變更及取消'),
    reservationsCanceled: l('취소된 예약', 'Canceled reservations', '已取消的预约', '已取消的預約'),
    closingStatus: l('마감 상태', 'Closing status', '打烊状态', '打烊狀態'), notClosed: l('마감 전', 'Not closed yet', '尚未打烊', '尚未打烊'), closed: l('마감 확정', 'Closed', '已打烊', '已打烊'),
    closingSales: l('오늘 매출(마감 전 기준)', "Today's net sales (before closing)", '今日营业额（打烊前）', '今日營業額（打烊前）'),
    closingProfit: l('오늘 순이익', "Today's net profit", '今日净利润', '今日淨利潤'),
    tomorrowReservations: l('내일 예약', "Tomorrow's reservations", '明日预约', '明日預約'), tomorrowPickup: l('내일 픽업', "Tomorrow's pickups", '明日自取', '明日自取'),
    tomorrowSchedule: l('내일 일정', "Tomorrow's schedule", '明日日程', '明日行程'),
    yesterdaySales: l('어제 매출', "Yesterday's net sales", '昨日营业额', '昨日營業額'), yesterdayDelta: l('지난주 같은 요일 대비', 'Vs. the same weekday last week', '较上周同一天', '較上週同一天'),
    acknowledged: l('오늘 브리핑 읽음', 'Briefing read', '今日简报已读', '今日簡報已讀'),
    // answers
    alreadyMode: (live: boolean) => live ? l('이미 실시간 보기예요', 'Already in Live view', '已经是实时查看', '已經是即時檢視') : l('이미 예시 보기예요', 'Already in Demo view', '已经是示例查看', '已經是示範檢視'),
    liveSetup: l('실시간 보기는 CCTV 화면에서 카메라 서버를 먼저 연결해야 써요', 'Connect the camera server on the CCTV screen before using Live', '请先在 CCTV 画面中连接摄像头服务器，再使用实时查看', '請先在 CCTV 畫面中連接攝影機伺服器，再使用即時檢視'),
    liveNumbers: l('실시간 숫자는 CCTV 화면에서 직접 확인해 주세요', 'Check live numbers on the CCTV screen', '实时数字请在 CCTV 画面中查看', '即時數字請在 CCTV 畫面中查看'),
    onlyToday: l('CCTV 방문은 오늘 자료만 읽을 수 있어요', 'CCTV visits can only be read for today', 'CCTV 到访只能读取今天的资料', 'CCTV 到訪只能讀取今天的資料'),
    notComparable: l('지난주 같은 요일과는 비교하지 않아요. 오늘은 일부 시간대만 집계돼요', 'Last week is not compared: today counts only part of the day', '不与上周同一天比较：今天只统计了部分时段', '不與上週同一天比較：今天只統計了部分時段'),
    noDemographics: l('손님 나이대나 성별 자료는 없어요. CCTV는 방문 수, 머문 시간, 테이블 상태만 읽어요', 'There is no age or gender data. CCTV reads visits, stay time and table states only', '没有顾客年龄或性别资料。CCTV 只读取到访数、停留时间和桌位状态', '沒有顧客年齡或性別資料。CCTV 只讀取到訪數、停留時間和桌位狀態'),
    reconnectByOwner: l('카메라 다시 연결은 CCTV 화면에서 직접 해 주세요', 'Reconnect the camera on the CCTV screen', '请在 CCTV 画面中重新连接摄像头', '請在 CCTV 畫面中重新連接攝影機'),
    todayHoursOnly: l('오늘 시간대만 검토 표시할 수 있어요', 'Only hours of today can be marked for review', '只能标记今天的时段', '只能標記今天的時段'),
    noUnmark: l('검토 표시를 풀 수는 없어요. 방금 한 표시는 되돌리기로만 풀려요', 'A review mark cannot be removed here. Use undo right after marking', '无法在这里取消复查标记，只能在刚标记后使用撤销', '無法在這裡取消複查標記，只能在剛標記後使用復原'),
    alreadyMarked: (hour: number) => l(`${hhmm(hour)} 구간은 이미 검토 표시돼 있어요`, `${hhmm(hour)} is already marked for review`, `${hhmm(hour)} 时段已标记`, `${hhmm(hour)} 時段已標記`),
    askHour: (range: string) => l(`표시할 수 있는 시간은 ${range}예요. 어느 시간으로 할까요?`, `You can mark ${range}. Which hour?`, `可标记的时段为 ${range}。选哪个时段？`, `可標記的時段為 ${range}。選哪個時段？`),
    pickHour: l('어느 시간으로 할까요?', 'Which hour?', '选哪个时段？', '選哪個時段？'),
    noClear: l('정리할 테이블이 없어요', 'No tables to clear', '没有需要整理的桌子', '沒有需要整理的桌子'),
    // music answers
    alreadyPlaying: l('이미 재생 중이에요', 'It is already playing', '已经在播放了', '已經在播放了'),
    alreadyPaused: l('이미 일시정지예요', 'It is already paused', '已经暂停了', '已經暫停了'),
    alreadyVolume: (n: number) => l(`이미 ${n}%예요`, `The volume is already ${n}%`, `音量已经是 ${n}%`, `音量已經是 ${n}%`),
    alreadyPlaylist: (name: string) => l(`이미 ${name}이에요`, `Already on ${name}`, `已经是 ${name}`, `已經是 ${name}`),
    alreadyTrack: (name: string) => l(`이미 ${name}을 재생 중이에요`, `${name} is already the current track`, `已经在播放 ${name}`, `已經在播放 ${name}`),
    noDevice: l('연결된 음악 장치가 없어요', 'No music device is connected', '没有连接音乐设备', '沒有連接音樂裝置'),
    volumeQuestion: (current: number) => l(`음량을 몇 %로 할까요? 지금은 ${current}%예요`, `What volume? It is ${current}% now`, `音量调到多少？现在是 ${current}%`, `音量調到多少？現在是 ${current}%`),
    volumeRange: l('음량은 0~100% 사이로 말해 주세요', 'Volume must be between 0 and 100%', '音量请设在 0~100% 之间', '音量請設在 0~100% 之間'),
    choosePlaylist: l('어느 재생목록으로 할까요?', 'Which playlist?', '选哪个播放列表？', '選哪個播放清單？'),
    noSuchPlaylist: l('그런 재생목록은 없어요. 어느 재생목록으로 할까요?', 'There is no such playlist. Which playlist?', '没有这个播放列表。选哪个播放列表？', '沒有這個播放清單。選哪個播放清單？'),
    threshold: l('온도·습도 알림 기준은 여기서 바꿀 수 없어요', 'Alert thresholds cannot be changed here', '无法在这里更改温湿度提醒标准', '無法在這裡更改溫濕度提醒標準'),
    // briefing answers
    acknowledgedAlready: l('오늘 브리핑은 이미 읽음 처리돼 있어요', "Today's briefing is already marked as read", '今日简报已标记为已读', '今日簡報已標記為已讀'),
    notComparableDay: l('어제와의 방문 비교는 읽을 수 없어요', 'The comparison with yesterday is not available', '无法读取与昨天的到访对比', '無法讀取與昨天的到訪對比'),
    // cards
    cardMusic: l('매장 음악 (화면 속 플레이어)', 'Store music (on-screen player)', '店内音乐（屏幕内播放器）', '店內音樂（螢幕內播放器）'),
    cardReview: l('방문 검토 표시', 'Visit review mark', '到访复查标记', '到訪複查標記'),
    cardMode: l('CCTV 보기 방식', 'CCTV view mode', 'CCTV 查看方式', 'CCTV 檢視方式'),
    cardBriefing: l('오늘 브리핑', "Today's briefing", '今日简报', '今日簡報'),
    visitStaff: l('방문 · 근무', 'Visits · staff', '到访 · 在岗', '到訪 · 在崗'),
    unread: l('읽지 않음', 'Unread', '未读', '未讀'), read: l('읽음 처리', 'Marked as read', '标记为已读', '標記為已讀'),
    noRepeat: l('다시 띄우지 않아요', 'Will not pop up again', '不会再次弹出', '不會再次彈出'),
    liveNote: l('카메라가 연결돼 있어야 실제 숫자가 보여요', 'Real numbers need a connected camera', '需要连接摄像头才能看到实际数字', '需要連接攝影機才能看到實際數字'),
    note: l('참고', 'Note', '参考', '參考'), playbackContinues: l('재생은 계속돼요', 'Playback continues', '继续播放', '繼續播放'),
    previousWraps: l('처음 곡이라 마지막 곡으로 가요', 'First track: goes to the last one', '当前是第一首，将跳到最后一首', '目前是第一首，將跳到最後一首'),
    nextWraps: l('마지막 곡이라 처음 곡으로 가요', 'Last track: goes to the first one', '当前是最后一首，将回到第一首', '目前是最後一首，將回到第一首'),
    track2: l('곡', 'Track', '曲目', '曲目'), playlist2: l('재생목록', 'Playlist', '播放列表', '播放清單'),
    count: (n: number) => l(`${n}건`, `${n}`, `${n} 次`, `${n} 次`),
    people: (n: number) => l(`${n}명`, `${n}`, `${n} 人`, `${n} 人`),
    items: (n: number) => l(`${n}개`, `${n}`, `${n} 个`, `${n} 個`),
    hourWord: (hour: number) => l(`${hour}시`, `${hhmm(hour)}`, `${hour} 时`, `${hour} 時`),
  };
}
type Copy = ReturnType<typeof copy>;

const fact = (key: string, label: string, value: string | number, display: string, extra: Partial<AgentFact> = {}): AgentFact =>
  ({ key, label, value, unit: '', display, ...extra });

// ───────────── selectors ─────────────
const view = <F extends FeatureId>(snapshot: DataSnapshot, id: F) => selectWidget(snapshot, id, { kind: 'default' }, NORMAL_VARIANT);
function environmentOf(snapshot: DataSnapshot): StoreEnvironmentModel | undefined {
  if (realCctv(snapshot)) return snapshot.tables.storeEnvironment.source === 'manual' ? selectStoreEnvironment(snapshot) : undefined;
  const read = view(snapshot, ENV);
  return read.status === 'ready' ? read.model : undefined;
}
function cctvOf(snapshot: DataSnapshot) {
  const read = view(snapshot, CCTV);
  return read.status === 'ready' ? read.model : undefined;
}
function storedCctvRecord(snapshot: DataSnapshot) {
  const insight = snapshot.tables.realInsight;
  if (!insight) return;
  const hours = insightHours(insight, snapshot);
  return { date: insight.date, hours, peak: insightPeak(hours), totalVisits: null };
}
function reviewTarget(snapshot: DataSnapshot, date: string, hour: number) {
  if (!realCctv(snapshot)) return selectCctvReviewTarget(snapshot.tables, date, hour);
  const record = storedCctvRecord(snapshot);
  if (record?.date !== date) return { reason: 'outside_hours' } as const;
  const row = record.hours.find(item => item.hour === hour);
  return row && row.max !== null ? { row: { ...row, max: row.max } } : { reason: 'unobserved' } as const;
}
function briefingOf(snapshot: DataSnapshot) {
  const read = view(snapshot, BRIEFING);
  return read.status === 'ready' ? read.model : undefined;
}
const translators = new Map<Locale, Translator>();
function translator(locale: Locale): Translator {
  const existing = translators.get(locale);
  if (existing) return existing;
  const next = createTranslator(locale, mgmtMoneyBundle as unknown as MessageBundle<string>, cctvBundle as unknown as MessageBundle<string>, ...baseBundles as unknown as MessageBundle<string>[], ...dataBundles as unknown as MessageBundle<string>[]);
  translators.set(locale, next);
  return next;
}
const fmt = (locale: Locale) => navisTranslator(locale).format;
const degrees = (value: number) => `${(Math.round(value * 10) / 10).toFixed(1)}°C`;

// ───────────── environment facts ─────────────
const sensorLabel = (c: Copy, status: StoreEnvironmentModel['sensorStatus']) => status === 'connected' ? c.sensorConnected : status === 'disconnected' ? c.sensorDisconnected : c.sensorNone;
function environmentState(model: StoreEnvironmentModel): 'normal' | 'out_of_range' | 'sensor_disconnected' {
  if (model.source === 'manual') return model.alerts.length ? 'out_of_range' : 'normal';
  if (model.sensorStatus !== 'connected' || !model.current) return 'sensor_disconnected';
  const { temperatureC, humidityPct } = model.current;
  const { temperature, humidity } = model.ranges;
  return temperatureC < temperature[0] || temperatureC > temperature[1] || humidityPct < humidity[0] || humidityPct > humidity[1] ? 'out_of_range' : 'normal';
}
function environmentFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] | undefined {
  const model = environmentOf(snapshot);
  if (!model) return;
  const c = copy(locale), date = model.source === 'manual' ? model.current?.measuredAt.slice(0, 10) ?? dayOf(snapshot) : dayOf(snapshot), { music, ranges } = model;
  const out: AgentFact[] = [];
  if (model.current) {
    out.push(
      fact('environment.temperature', c.temperature, model.current.temperatureC, degrees(model.current.temperatureC), { date }),
      fact('environment.humidity', c.humidity, model.current.humidityPct, `${model.current.humidityPct}%`, { date }),
      fact('environment.measuredAt', c.measuredAt, model.current.measuredAt.slice(11, 16), model.current.measuredAt.slice(11, 16), { date }),
    );
  }
  const state = environmentState(model);
  out.push(
    fact('environment.sensor.status', c.sensor, model.sensorStatus, sensorLabel(c, model.sensorStatus), { date }),
    ...(model.source === 'manual' && !model.current ? [] : [fact('environment.status', c.environment, state, state === 'normal' ? c.within : state === 'out_of_range' ? c.outside : c.sensorDisconnected, { date })]),
    fact('environment.temperature.range', c.tempRange, `${ranges.temperature[0]}~${ranges.temperature[1]}`, `${ranges.temperature[0]}~${ranges.temperature[1]}°C`),
    fact('environment.humidity.range', c.humidityRange, `${ranges.humidity[0]}~${ranges.humidity[1]}`, `${ranges.humidity[0]}~${ranges.humidity[1]}%`),
  );
  const today = model.trend.filter(row => row.measuredAt.slice(0, 10) === date);
  if (today.length) {
    const high = today.reduce((best, row) => row.temperatureC >= best.temperatureC ? row : best), low = today.reduce((best, row) => row.temperatureC < best.temperatureC ? row : best);
    out.push(
      fact('environment.temperature.max', c.hottest, high.temperatureC, `${degrees(high.temperatureC)} · ${high.measuredAt.slice(11, 16)}`, { date }),
      fact('environment.temperature.min', c.coolest, low.temperatureC, `${degrees(low.temperatureC)} · ${low.measuredAt.slice(11, 16)}`, { date }),
    );
  }
  if (model.source === 'manual') {
    out.push(fact('music.device.status', c.musicDevice, 'none', c.deviceNone, { date }));
    if (model.current) out.push(fact('environment.source', '측정 출처', 'manual', '직접 측정', { date }));
    return out;
  }
  const playlist = music.playlists.find(item => item.id === music.playlistId);
  out.push(
    fact('music.device.status', c.musicDevice, music.deviceStatus, music.deviceStatus === 'connected' ? c.sensorConnected : c.deviceNone, { date }),
    fact('music.playing', c.playing, music.playing ? 1 : 0, music.playing ? c.playingOn : c.playingOff, { date }),
    fact('music.volume', c.volume, music.volumePct, `${music.volumePct}%`, { date, unit: 'percent' }),
    fact('music.track.ready', c.trackReady, music.track ? 1 : 0, music.track ? c.yes : c.no, { date }),
    ...(music.track ? [fact('music.track', c.track, music.track.title, music.track.title, { date })] : []),
    ...(playlist ? [fact('music.playlist', c.playlist, playlist.id, playlist.name, { date })] : []),
    ...music.playlists.map(item => fact('music.playlist.option', c.playlistOption, item.id, item.name, { date })),
  );
  return out;
}

// ───────────── CCTV facts ─────────────
const toClearTables = () => CCTV_SNAPSHOT.tables.filter(table => CCTV_SNAPSHOT.tablesToClear.includes(table.id));
function storedCctvFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] | undefined {
  const insight = snapshot.tables.realInsight;
  if (!insight) return;
  const { date, cameras } = insight, c = copy(locale);
  const hours = insightHours(insight, snapshot), peak = insightPeak(hours);
  const count = cameras.filter(camera => camera.deviceStatus === 'unavailable').length;
  const facts = [
    fact('cctv.businessDate', c.businessDate, date, fmt(locale).date(date, 'short'), { date }),
    fact('cctv.visits.total', c.visitsTotal, 'none', '방문 수 미측정', { date }),
    fact('cctv.cameras.count', c.cameras, cameras.length, c.cameraUnit(cameras.length), { date }),
    fact('cctv.cameras.problem', c.cameraProblem, count, c.cameraUnit(count), { date }),
    ...cameras.map((camera, index) => fact('cctv.camera.status', `카메라 ${index + 1}`, camera.measurementStatus, cameraMeasurement(camera), { date })),
  ];
  if (peak && peak.max !== null) {
    facts.push(fact('cctv.peak.hour', '최대 관측 시간대', peak.hour, c.hourWord(peak.hour), { date, unit: 'hour' }),
      fact('cctv.peak.observed', '최대 관측 인원', peak.max, c.people(peak.max), { date, unit: 'person' }));
    if (peak.staff !== null) facts.push(fact('cctv.peak.staff', c.peakStaff, peak.staff, c.people(peak.staff), { date, unit: 'person' }));
  }
  for (const row of hours) {
    facts.push(fact(`cctv.hour.${row.hour}.observed`, '시간대 최대 관측', row.max ?? 'none', row.max === null ? '미측정' : c.people(row.max), { date }));
    if (row.max !== null) facts.push(fact(`cctv.review.${row.hour}`, c.reviewMark, row.reviewMarked ? 'marked' : 'open', row.reviewMarked ? c.alreadyMarked(row.hour) : c.reviewOpen, { date }));
  }
  return facts;
}

function cctvFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] | undefined {
  if (realCctv(snapshot)) return storedCctvFacts(snapshot, locale);
  const model = cctvOf(snapshot);
  if (!model) return;
  const c = copy(locale), t = fmt(locale), l = translator(locale), date = model.date;
  const hourLabel = (hour: number) => c.hourWord(hour);
  const visits = (n: number | null, status: 'ok' | 'partial' | 'none') => n === null || status === 'none' ? c.notCounted
    : status === 'partial' ? `${c.count(n)} (${c.partly})` : c.count(n);
  const counted = model.hours.filter(row => row.visits !== null && row.status === 'ok');
  const quiet = counted.length ? counted.reduce((best, row) => (row.visits ?? 0) < (best.visits ?? 0) ? row : best) : undefined;
  const problems = model.cameras.filter(camera => camera.connection !== 'connected');
  const out: AgentFact[] = [
    fact('cctv.businessDate', c.businessDate, date, t.date(date, 'short'), { date }),
    fact('cctv.visits.total', c.visitsTotal, model.totalVisits, c.count(model.totalVisits), { date, unit: 'visit' }),
    fact('cctv.coverage', c.coverage, `${model.coverage.startHour}~${model.coverage.endHour}`, `${hhmm(model.coverage.startHour)}~${hhmm(model.coverage.endHour)}`, { date }),
  ];
  if (model.peak) {
    out.push(
      fact('cctv.peak.hour', c.peakHour, model.peak.hour, hourLabel(model.peak.hour), { date, unit: 'hour' }),
      fact('cctv.peak.visits', c.peakVisits, model.peak.visits ?? 0, c.count(model.peak.visits ?? 0), { date, unit: 'visit' }),
      ...(model.peak.staff !== null ? [fact('cctv.peak.staff', c.peakStaff, model.peak.staff, c.people(model.peak.staff), { date, unit: 'person' })] : []),
    );
  }
  if (quiet) out.push(
    fact('cctv.quiet.hour', c.quietHour, quiet.hour, hourLabel(quiet.hour), { date, unit: 'hour' }),
    fact('cctv.quiet.visits', c.quietVisits, quiet.visits ?? 0, c.count(quiet.visits ?? 0), { date, unit: 'visit' }),
  );
  for (const row of model.hours) {
    out.push(fact(`cctv.hour.${row.hour}.visits`, `${hourLabel(row.hour)}`, row.visits ?? 'none', visits(row.visits, row.status), { date, unit: 'visit' }));
    const target = selectCctvReviewTarget(snapshot.tables, date, row.hour);
    if ('row' in target) out.push(fact(`cctv.review.${row.hour}`, c.reviewMark, target.row.reviewMarked ? 'marked' : 'open',
      target.row.reviewMarked ? c.alreadyMarked(row.hour) : `${hourLabel(row.hour)} · ${c.reviewOpen}`, { date }));
  }
  out.push(fact('cctv.gapHours', c.gapCount, model.gapHours.length, model.gapHours.length ? c.items(model.gapHours.length) : c.noGap, { date }));
  for (const hour of model.gapHours) {
    const row = model.hours.find(item => item.hour === hour);
    out.push(fact('cctv.gapHour', c.gapHour, hour, `${hourLabel(hour)} · ${row?.status === 'none' ? c.notCounted : c.partly}`, { date }));
  }
  out.push(fact('cctv.cameras.count', c.cameras, model.cameras.length, c.cameraUnit(model.cameras.length), { date }));
  out.push(fact('cctv.cameras.problem', c.cameraProblem, problems.length, c.cameraUnit(problems.length), { date }));
  for (const camera of model.cameras) {
    out.push(fact('cctv.camera.status', resolveDataText(l.t.bind(l), camera.name), camera.connection,
      `${camera.connection === 'connected' ? c.connected : c.disconnected} · ${camera.operation === 'recording' ? c.recording : c.stopped} · ${c.checkedAt} ${camera.lastCheckedAt.slice(11, 16)}`, { date }));
  }
  const used = CCTV_SNAPSHOT.occupiedTables.length, clear = CCTV_SNAPSHOT.tablesToClear.length;
  out.push(
    fact('cctv.inStore.now', c.inStore, CCTV_SNAPSHOT.inStore, c.people(CCTV_SNAPSHOT.inStore), { date, unit: 'person' }),
    fact('cctv.occupants.now', c.occupants, CCTV_SNAPSHOT.occupants, c.people(CCTV_SNAPSHOT.occupants), { date, unit: 'person' }),
    fact('cctv.tables.occupied', c.tablesOccupied, used, c.items(used), { date, unit: 'table' }),
    fact('cctv.tables.toClear', c.tablesToClear, clear, c.items(clear), { date, unit: 'table' }),
    fact('cctv.tables.empty', c.tablesEmpty, CCTV_SNAPSHOT.tables.length - used - clear, c.items(CCTV_SNAPSHOT.tables.length - used - clear), { date, unit: 'table' }),
    ...toClearTables().map(table => fact('cctv.table.toClear', c.tablesToClear, table.id, table.name, { date })),
    fact('cctv.dwell.avgToday', c.dwell, Math.round(CCTV_SNAPSHOT.avgInStore * 10) / 10 === 0 ? 0 : 0, '', { date }),
  );
  out.pop();
  return out;
}

// ───────────── briefing facts ─────────────
function briefingFacts(snapshot: DataSnapshot, locale: Locale): readonly AgentFact[] | undefined {
  const model = briefingOf(snapshot);
  if (!model) return;
  const c = copy(locale), t = fmt(locale), l = translator(locale), date = dayOf(snapshot);
  const out: AgentFact[] = [fact('briefing.importantAlerts.count', c.importantAlerts, model.importantAlerts.count, c.count(model.importantAlerts.count), { date, unit: 'count' })];
  if (realCctv(snapshot)) for (const item of storedCctvFacts(snapshot, locale) ?? []) {
    if (item.key.startsWith('cctv.peak.')) out.push({ ...item, key: `briefing.${item.key}` });
  }
  const tax = view(snapshot, 'tax'), stock = view(snapshot, 'inventory-booking'), orders = view(snapshot, 'suppliers'), grants = view(snapshot, 'grants');
  for (const group of model.importantAlerts.groups) {
    for (const item of group.items) {
      const ref = item.ref as { itemId?: string };
      let text = l.t(item.messageKey, item.params as never);
      if (item.id.startsWith('tax:') && tax.status === 'ready') {
        const payment = tax.model.payments.find(row => row.taxPaymentId === ref.itemId);
        if (payment) text = l.t('widget.briefing.taxItem', { name: resolveDataText(l.t.bind(l), payment.type), amount: t.money(payment.amount, 'compact'), date: t.date(payment.dueOn, 'short') });
      } else if (item.id.startsWith('order:') && orders.status === 'ready') {
        const order = orders.model.orders.find(row => row.poId === ref.itemId), line = order?.lines[0];
        if (order && line && !order.overdue) text = l.t('widget.briefing.deliveryItem', { name: l.t(line.itemNameKey), quantity: t.quantity(line.remaining, line.unit) });
      } else if (item.id.startsWith('stock:') && stock.status === 'ready') {
        const out0 = stock.model.ingredients.find(row => row.outOfStock);
        if (out0) text = l.t('widget.briefing.stockItem', { count: stock.model.restockCount, name: out0.name ? resolveDataText(l.t.bind(l), out0.name) : l.t(out0.nameKey) });
      } else if (item.id.startsWith('grant:') && grants.status === 'ready') {
        const grant = grants.model.notices.find(row => row.noticeId === ref.itemId);
        if (grant) text = l.t('widget.briefing.grantItem', { name: l.t(grant.titleKey), date: t.date(grant.applyEndDate, 'short') });
      }
      out.push(fact('briefing.alert.item', l.t(`widget.briefing.${group.id}`), item.id, text, { date, text }));
    }
  }
  out.push(fact('briefing.arrival.count', c.arrivalItem, model.arrival.length, c.items(model.arrival.length), { date, unit: 'count' }));
  for (const item of model.arrival) {
    const label = item.tier === 'today' ? c.tierToday : item.tier === 'loss' ? c.tierLoss : c.tierInfo;
    out.push(fact('briefing.arrival.item', label, item.value, l.t(item.messageKey, item.params as never), { date, unit: item.unit }));
  }
  const { reservations, closingSummary: closing, tomorrowReservations: tomorrow, yesterday } = model;
  const canceled = reservations.rows.filter(row => row.status === 'canceled').length;
  out.push(
    fact('briefing.reservations.today', c.reservationsToday, reservations.count, `${c.count(reservations.count)} · ${c.people(reservations.partyTotal)}`, { date }),
    fact('briefing.reservations.changes', c.reservationChanges, reservations.changes, c.count(reservations.changes), { date }),
    fact('briefing.reservations.canceled', c.reservationsCanceled, canceled, c.count(canceled), { date }),
    fact('briefing.closing.status', c.closingStatus, closing.status, closing.status === 'closed' ? c.closed : c.notClosed, { date }),
    fact('briefing.closing.netSales', c.closingSales, closing.salesSnapshot.net, t.money(closing.salesSnapshot.net, 'compact'), { date, unit: 'KRW' }),
    fact('briefing.closing.profit', c.closingProfit, closing.netProfit, t.money(closing.netProfit, 'compact'), { date, unit: 'KRW' }),
    fact('briefing.tomorrow.reservations', c.tomorrowReservations, tomorrow.count, `${c.count(tomorrow.count)} · ${c.people(tomorrow.partyTotal)}`, { date: tomorrow.date }),
    fact('briefing.tomorrow.pickup', c.tomorrowPickup, model.schedules.tomorrowPickupCount, c.count(model.schedules.tomorrowPickupCount), { date: tomorrow.date }),
  );
  for (const entry of model.schedules.entries.filter(row => row.date === tomorrow.date)) {
    const title = resolveDataText(l.t.bind(l), entry.title);
    out.push(fact('briefing.tomorrow.schedule', c.tomorrowSchedule, entry.id, entry.time ? `${entry.time} ${title}` : title, { date: tomorrow.date }));
  }
  out.push(fact('briefing.yesterday.sales.net', c.yesterdaySales, yesterday.netSales, t.money(yesterday.netSales, 'compact'), { date: yesterday.date, unit: 'KRW' }));
  if (yesterday.delta) {
    const value = yesterday.delta.value;
    out.push(fact('briefing.yesterday.sales.delta', c.yesterdayDelta, value, `${value > 0 ? '+' : ''}${value}%`, { date: yesterday.date, unit: 'percent' }));
  }
  return out;
}

function projectWidget(snapshot: DataSnapshot, featureId: FeatureId, condition: QueryCondition, locale: Locale) {
  if (!features.includes(featureId)) return;
  if (condition.kind !== 'default') return { status: 'unsupported_period' as const };
  const facts = featureId === ENV ? environmentFacts(snapshot, locale) : featureId === CCTV ? cctvFacts(snapshot, locale) : briefingFacts(snapshot, locale);
  return facts ? { facts } : { status: 'unavailable' as const };
}

/** Player, mode and briefing state for the proposal preflight (get_ui_state, section display). */
function briefingAcknowledged(snapshot: DataSnapshot, run?: RunState): boolean {
  const briefing = snapshot.tables.realBriefing;
  return briefing ? !!briefing.acknowledgement : run?.briefing === 'dismissed';
}

function displayReading(snapshot: DataSnapshot, locale: Locale, run?: RunState): AgentReadProjection {
  const acknowledged = briefingAcknowledged(snapshot, run);
  if (realCctv(snapshot)) {
    const c = copy(locale), facts = [fact('music.device.status', c.musicDevice, 'none', c.deviceNone), fact('cctv.mode.liveAvailable', c.liveAvailable, 0, c.no)];
    if (run) facts.push(fact('briefing.acknowledged', c.acknowledged, Number(acknowledged), acknowledged ? c.yes : c.no));
    return { tool: 'get_ui_state', args: { section: 'display' }, facts } as AgentReadProjection;
  }
  const c = copy(locale), model = environmentOf(snapshot), mode = getCctvMode();
  const facts: AgentFact[] = [
    fact('music.device.status', c.musicDevice, model?.music.deviceStatus ?? 'none', model?.music.deviceStatus === 'connected' ? c.sensorConnected : c.deviceNone),
    fact('music.track.ready', c.trackReady, model?.music.track ? 1 : 0, model?.music.track ? c.yes : c.no),
    fact('music.playing', c.playing, model?.music.playing ? 1 : 0, model?.music.playing ? c.playingOn : c.playingOff),
    fact('music.volume', c.volume, model?.music.volumePct ?? 0, `${model?.music.volumePct ?? 0}%`),
    fact('cctv.mode', c.mode, mode, mode === 'live' ? c.modeLive : c.modeMock),
    // Live needs the configured camera server (the app's own 'not configured' state); mock is always available.
    fact('cctv.mode.liveAvailable', c.liveAvailable, liveReady() ? 1 : 0, liveReady() ? c.yes : c.no),
    ...(run ? [fact('briefing.acknowledged', c.acknowledged, Number(acknowledged), acknowledged ? c.yes : c.no)] : []),
  ];
  return { tool: 'get_ui_state', args: { section: 'display' }, facts } as AgentReadProjection;
}

// ───────────── command adapters (data store) ─────────────
const environmentCommands = ['environment.setPlaying', 'environment.skipTrack', 'environment.selectPlaylist', 'environment.selectTrack', 'environment.setVolume'] as const;
type EnvironmentCommand = Extract<DataCommand, { type: typeof environmentCommands[number] }>;
type OperationsCommand = EnvironmentCommand | Extract<DataCommand, { type: 'cctv.markPeakForReview' }>;
type Draft = { readonly command: OperationsCommand; readonly locale: Locale };

function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (!isObject(value)) return value;
  if (typeof value.slot === 'string') return slots[value.slot];
  if (typeof value.handle === 'string') return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, expand(item, slots, targets)]));
}
const slotValidators = {
  date: isIsoDate,
  hour: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23,
  volumePct: (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100,
  playlistQuery: (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200,
  trackQuery: (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 200,
};
function simulate(command: OperationsCommand, snapshot: DataSnapshot, proposalId: string) {
  const handler = handlers[command.type] as (context: HandlerContext, command: OperationsCommand) => HandlerResult;
  return handler({ snapshot, tables: snapshot.tables, nextId: prefix => `${prefix}-navis-${proposalId}` }, command);
}
const nameOf = (model: StoreEnvironmentModel, id: string | null) => model.music.playlists.find(item => item.id === id)?.name ?? '';

function environmentPreview(command: EnvironmentCommand, before: StoreEnvironmentModel, after: StoreEnvironmentModel, locale: Locale): AgentProposalPreview {
  const c = copy(locale), fields: { label: string; before: string; after: string }[] = [];
  const track = (model: StoreEnvironmentModel) => model.music.track?.title ?? c.no;
  const state = (model: StoreEnvironmentModel) => model.music.playing ? c.playingOn : c.playingOff;
  if (command.type === 'environment.setPlaying') fields.push({ label: c.playing, before: state(before), after: state(after) });
  else if (command.type === 'environment.setVolume') {
    fields.push({ label: c.volume, before: `${before.music.volumePct}%`, after: `${after.music.volumePct}%` });
    if (after.music.volumePct === 0 && after.music.playing) fields.push({ label: c.playing, before: state(before), after: `${state(after)} · ${c.playbackContinues}` });
  } else {
    fields.push({ label: c.track2, before: track(before), after: track(after) });
    if (before.music.playlistId !== after.music.playlistId) fields.push({ label: c.playlist2, before: nameOf(before, before.music.playlistId), after: nameOf(after, after.music.playlistId) });
    if (command.type === 'environment.skipTrack') {
      const list = before.music.playlists.find(item => item.id === before.music.playlistId)?.tracks ?? [];
      const index = list.findIndex(item => item.id === before.music.track?.id);
      if (command.direction === 'previous' && index === 0 && list.length > 1) fields.push({ label: c.note, before: c.no, after: c.previousWraps });
      if (command.direction === 'next' && index === list.length - 1 && list.length > 1) fields.push({ label: c.note, before: c.no, after: c.nextWraps });
    }
  }
  return { title: c.cardMusic, target: after.music.track?.title ?? nameOf(after, after.music.playlistId) ?? c.cardMusic, fields };
}

function commandAdapter(type: OperationsCommand['type']): CommandAdapter<OperationsCommand, Draft, AgentProposalPreview> {
  return {
    command: type, featureId: type === 'cctv.markPeakForReview' ? CCTV : ENV, slots: slotValidators,
    resolve(wire, slots, _snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (!isObject(args) || !validateAgentCommandArgs(type, args)) return;
      const locale = slots.navisLocale === 'en' || slots.navisLocale === 'zh-Hans' || slots.navisLocale === 'zh-Hant' ? slots.navisLocale : 'ko';
      return { command: { ...args, type } as OperationsCommand, locale };
    },
    preflight({ command: draft, locale }, { snapshot, proposalId, idempotencyKey }) {
      const command = { ...draft, idempotencyKey } as unknown as OperationsCommand;
      if (command.type === 'cctv.markPeakForReview') {
        const target = reviewTarget(snapshot, command.date, command.hour);
        if (!('row' in target) || !target.row) return { kind: 'invalid', field: 'hour' };
        const { row } = target;
        if (row.reviewMarked) return { kind: 'unchanged' };
        if (!('max' in row)) {
          const result = simulate(command, snapshot, proposalId);
          if (!result.ok) return { kind: result.code === 'CONFLICT' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
        }
        const c = copy(locale), staff = 'max' in row ? row.staff : cctvOf(snapshot)?.hours.find(item => item.hour === command.hour)?.staff;
        const info = `${'max' in row ? c.people(row.max) : c.count(row.entries ?? 0)}${staff === null || staff === undefined ? '' : ` · ${c.people(staff)}`}`;
        return { kind: 'ready', command, preview: { title: `${c.cardReview} · ${hhmm(command.hour)}~${hhmm(command.hour + 1)}`, target: `${hhmm(command.hour)}~${hhmm(command.hour + 1)}`, fields: [
          { label: 'max' in row ? '최대 관측 · 근무표' : c.visitStaff, before: info, after: info }, { label: c.reviewMark, before: c.reviewOpen, after: c.reviewMarked },
        ] } };
      }
      const before = environmentOf(snapshot);
      if (!before || before.music.deviceStatus !== 'connected') return { kind: 'invalid' };
      const result = simulate(command, snapshot, proposalId);
      if (!result.ok) return { kind: result.code === 'CONFLICT' ? 'conflict' : 'invalid', field: result.field, messageKey: result.messageKey };
      if (result.tables === snapshot.tables) return { kind: 'unchanged' };
      const after = selectStoreEnvironment({ tables: result.tables });
      return { kind: 'ready', command, preview: environmentPreview(command, before, after, locale) };
    },
    undoToken: result => result.undoToken,
  };
}

// ───────────── run commands (mode and briefing card) ─────────────
const busy = (state: RunState) => state.posUi.approval?.status === 'pending' || state.edit.gesture !== null || state.gesturePreview !== null || state.exitPendingToken !== null;
const modeCommand: RunCommandAdapter<{ mode: 'mock' | 'live'; locale: Locale }, AgentProposalPreview> = {
  command: 'ui.setCctvMode', slots: {},
  resolve(args, slots) {
    if (!validateAgentToolArgs('propose_action', { command: 'ui.setCctvMode', args }) || !isObject(args) || (args.mode !== 'mock' && args.mode !== 'live')) return;
    const locale = slots.navisLocale === 'en' || slots.navisLocale === 'zh-Hans' || slots.navisLocale === 'zh-Hant' ? slots.navisLocale : 'ko';
    return { mode: args.mode, locale };
  },
  preflight({ mode, locale }, { run, snapshot }): RunPreflight<AgentProposalPreview> {
    if (realCctv(snapshot)) return { kind: 'invalid', messageKey: 'cctv.conn.none' };
    const current = getCctvMode(), c = copy(locale);
    if (current === mode) return { kind: 'unchanged' };
    if (busy(run)) return { kind: 'busy' };
    if (mode === 'live' && !liveReady()) return { kind: 'invalid', messageKey: 'cctv.conn.none' };
    const label = (value: 'mock' | 'live') => value === 'live' ? c.modeLive : c.modeMock;
    return { kind: 'ready', preview: { title: c.cardMode, target: c.mode, fields: [
      { label: c.mode, before: label(current), after: label(mode) },
      ...(mode === 'live' ? [{ label: c.note, before: c.no, after: c.liveNote }] : []),
    ] }, execute(store) {
      if (busy(store.getState())) return { kind: 'busy' };
      if (getCctvMode() !== current) return { kind: 'conflict' };
      if (mode === 'live' && !liveReady()) return { kind: 'invalid', messageKey: 'cctv.conn.none' };
      setCctvMode(mode);
      return { kind: 'applied', notice: { kind: 'success', featureId: CCTV, messageKey: mode === 'live' ? 'data.notice.cctvModeLive' : 'data.notice.cctvModeMock' }, undo: () => { if (getCctvMode() !== mode) return false; setCctvMode(current); return true; } };
    } };
  },
};
const acknowledgeCommand: RunCommandAdapter<{ locale: Locale }, AgentProposalPreview> = {
  command: 'ui.acknowledgeBriefing', slots: {},
  resolve(args, slots) {
    if (!validateAgentToolArgs('propose_action', { command: 'ui.acknowledgeBriefing', args })) return;
    const locale = slots.navisLocale === 'en' || slots.navisLocale === 'zh-Hans' || slots.navisLocale === 'zh-Hant' ? slots.navisLocale : 'ko';
    return { locale };
  },
  preflight({ locale }, { run, snapshot }): RunPreflight<AgentProposalPreview> {
    const c = copy(locale);
    if (briefingAcknowledged(snapshot, run)) return { kind: 'unchanged' };
    // While the arrival card is on screen the owner closes it there; chat cannot replace that lifecycle.
    if (run.briefing === 'visible' || busy(run)) return { kind: 'busy' };
    const day = snapshot.tables.realBriefing?.businessDay;
    return { kind: 'ready', ...(day && {
      featureId: BRIEFING, realCommand: { type: 'briefing.acknowledge' as const, businessDay: day, idempotencyKey: ackKey(day) },
      noticeKey: 'data.notice.briefingAcknowledged',
      afterCommit(store) {
        if (store.getState().briefing === 'pending') store.actions.acknowledgeBriefing();
      },
    }), preview: { title: c.cardBriefing, target: c.cardBriefing, fields: [
      { label: c.acknowledged, before: c.unread, after: `${c.read} · ${c.noRepeat}` },
    ] }, execute(store) {
      if (store.getState().briefing !== 'pending') return { kind: 'conflict' };
      store.actions.acknowledgeBriefing();
      return store.getState().briefing === 'dismissed'
        ? { kind: 'applied', notice: { kind: 'success', featureId: BRIEFING, messageKey: 'data.notice.briefingAcknowledged' } } : { kind: 'busy' };
    } };
  },
};

// ───────────── records (playlist and track) ─────────────
const nameKey = (value: string) => normalizeNavisName(value);
function playlistRows(snapshot: DataSnapshot) {
  const model = environmentOf(snapshot);
  return (model?.music.playlists ?? []).map((item, index) => ({ id: item.id, name: item.name, handle: `playlist-${index + 1}`, tracks: item.tracks.length }));
}
function trackRows(snapshot: DataSnapshot) {
  const model = environmentOf(snapshot);
  return (model?.music.playlists ?? []).flatMap((list, p) => list.tracks.map((item, index) => ({
    id: item.id, title: item.title, handle: `track-${p + 1}-${index + 1}`, playlistId: list.id,
    current: model?.music.track?.id === item.id,
  })));
}
const matchName = (query: string, name: string) => {
  const key = nameKey(query), value = nameKey(name);
  return key.length > 1 && (value === key ? 'exact' as const : value.includes(key) || key.includes(value) ? 'similar' as const : undefined);
};
const playlistReader: RecordAdapter = {
  kind: 'playlist',
  search({ snapshot, query, privateLookup }: RecordSearch) {
    const rows = playlistRows(snapshot).flatMap(row => { const m = matchName(query, row.name); return m ? [{ row, m }] : []; });
    const exact = rows.filter(item => item.m === 'exact');
    return (exact.length ? exact : rows).map(({ row, m }) => ({
      handle: row.handle, match: m, ...(!privateLookup ? { label: row.name } : {}), fields: { hasTracks: row.tracks > 0 },
    }));
  },
  resolve: ({ snapshot }, handle) => playlistRows(snapshot).find(row => row.handle === handle)?.id,
  describe: (match, _locale, search) => search ? playlistRows(search.snapshot).find(row => row.handle === match.handle)?.name : undefined,
};
const trackReader: RecordAdapter = {
  kind: 'track',
  search({ snapshot, query, privateLookup }: RecordSearch) {
    const rows = trackRows(snapshot).flatMap(row => { const m = matchName(query, row.title); return m ? [{ row, m }] : []; });
    const exact = rows.filter(item => item.m === 'exact');
    return (exact.length ? exact : rows).map(({ row, m }) => ({
      handle: row.handle, match: m, ...(!privateLookup ? { label: row.title } : {}), fields: { playing: row.current },
    }));
  },
  resolve: ({ snapshot }, handle) => trackRows(snapshot).find(row => row.handle === handle)?.id,
  describe: (match, _locale, search) => search ? trackRows(search.snapshot).find(row => row.handle === match.handle)?.title : undefined,
};

// ───────────── review reading ─────────────
const reviewTool: ReadToolAdapter<'get_cctv_review'> = {
  tool: 'get_cctv_review',
  read(snapshot, args: AgentReadArgs['get_cctv_review'], locale, slots) {
    const date = slots[args.date.slot], hour = slots[args.hour.slot];
    if (typeof date !== 'string' || typeof hour !== 'number') return { status: 'unavailable' };
    const c = copy(locale), target = reviewTarget(snapshot, date, hour);
    const status = 'row' in target ? target.row.reviewMarked ? 'marked' : 'open' : target.reason;
    return { facts: [
      fact('cctv.review.date', c.businessDate, date, date), fact('cctv.review.hour', c.hourWord(hour), hour, c.hourWord(hour)),
      fact('cctv.review.status', c.reviewMark, status, status === 'marked' ? c.reviewMarked : realCctv(snapshot) && status !== 'open' ? '미측정' : c.reviewOpen),
    ] };
  },
};

// ───────────── routing ─────────────
const read = (featureId: FeatureId, factKeys: readonly string[]): DomainTurnInput => ({ intent: { kind: 'read', featureId, condition: { kind: 'default' } }, factKeys });
const answer = (text: string, cancelPending = false): DomainRoute => ({ kind: 'answer', answer: text, ...(cancelPending ? { cancelPending: true as const } : {}) });
const refusal = (text: string, reason: 'unsupported' | 'unavailable' | 'widget_only' = 'unsupported', featureId?: FeatureId): DomainRoute =>
  ({ kind: 'refusal', reason, answer: text, ...(featureId ? { alternative: { featureId } } : {}) });
const clarification = (field: string, text: string, choices?: readonly { id: string; label: string }[], resume?: (value: string) => DomainRoute | undefined): DomainRoute =>
  ({ kind: 'clarification', field, answer: text, ...(choices ? { choices } : {}), ...(resume ? { resume } : {}) });

function command(commandName: string, args: AgentWireArgs, slots: Record<string, string | number | boolean>, locale: Locale, extra: Partial<DomainTurnInput> = {}): DomainTurnInput {
  return { intent: { kind: 'command', command: commandName as never, args }, slots: { navisLocale: locale, ...slots }, ...extra };
}

/** Hour of the business day named in the text: 14시, 오후 2시, 점심, 피크. */
function hourIn(text: string): number | 'peak' | undefined {
  const match = /(?:(오전|오후|아침|새벽|점심|저녁|낮|밤)\s*)?([0-9]{1,2}|열\s*[한두세네]?|[한두세네]|다섯|여섯|일곱|여덟|아홉|열한|열두)\s*시(?!간)/u.exec(text);
  if (match) {
    const value = parseNavisNumber(match[2]);
    if (value === undefined || value > 24) return;
    const part = match[1];
    if (part === '오후' || part === '저녁' || part === '밤') return value < 12 ? value + 12 : value;
    if (!part && value >= 1 && value <= 7) return value + 12;
    return value;
  }
  if (/점심/u.test(text)) return 12;
  if (/피크|가장\s*바쁜/u.test(text)) return 'peak';
}

function routeCctv(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined {
  const real = realCctv(snapshot);
  const model = real ? storedCctvRecord(snapshot) : cctvOf(snapshot);
  if (!model) return;
  const c = copy(locale), date = model.date;
  const mark = markIntent(text);
  const mode = /(?:CCTV|카메라|씨씨티비)/iu.test(text) && /실시간|예시/u.test(text) && /바꿔|전환|돌려|볼래|열어/u.test(text)
    || /^(?:실시간|예시)\s*(?:보기|화면|모드)(?:로|으로)\s*(?:바꿔|해|전환|열어)/u.test(text) || /실시간\s*말고\s*예시/u.test(text);
  const camera = /(?:CCTV|카메라|씨씨티비)/iu.test(text) && /상태|연결|끊|문제|정상|살아|고장/u.test(text);
  const rows = model.hours;
  if (mark) {
    if (/풀어|해제|취소|지워|없애/u.test(text)) return refusal(c.noUnmark);
    const typedDate = parseNavisDate(text, date);
    if (typedDate && typedDate !== date || /어제|그저께|지난\s*주|저번\s*주|지난\s*달/u.test(text)) return refusal(c.todayHoursOnly);
    const markable = rows.filter(row => 'row' in reviewTarget(snapshot, date, row.hour)).map(row => row.hour);
    if (!markable.length) return answer(navisTranslator('ko').t('common.navis.noData'));
    const choices = markable.map(hour => ({ id: String(hour), label: c.hourWord(hour) }));
    const first = markable[0];
    const range = markable.every((hour, index) => hour === first + index)
      ? `${hhmm(first)}~${hhmm(first + markable.length)}` : choices.map(choice => choice.label).join(', ');
    const peak = model.peak?.hour;
    const pickHour = (missing: boolean): DomainRoute => {
      const ordered = !missing && peak !== undefined
        ? [...choices.filter(choice => choice.id === String(peak)), ...choices.filter(choice => choice.id !== String(peak))] : choices;
      return clarification('hour', missing ? c.askHour(range) : c.pickHour, ordered,
        value => markable.includes(Number(value)) ? markRoute(Number(value)) : undefined);
    };
    const markRoute = (hour: number): DomainRoute => {
      const target = reviewTarget(snapshot, date, hour);
      if (!('row' in target) || !target.row) return pickHour(true);
      if (target.row.reviewMarked) return read(CCTV, [`cctv.review.${hour}`]);
      return command('cctv.markPeakForReview', { date: { slot: 'date' }, hour: { slot: 'hour' } }, { date, hour }, locale,
        { reading: { tool: 'get_cctv_review', args: { date: { slot: 'date' }, hour: { slot: 'hour' } } } });
    };
    const requested = hourIn(text);
    const hour = requested === 'peak' ? peak : requested;
    if (hour === undefined) return pickHour(requested === 'peak');
    return markRoute(hour);
  }
  if (mode) {
    if (real) return refusal('CCTV 화면에서 카메라별 측정 기록을 볼 수 있어요', 'widget_only', CCTV);
    const live = /실시간/u.test(text) && !/실시간\s*말고/u.test(text);
    if (live && getCctvMode() === 'live') return answer(c.alreadyMode(true), true);
    if (!live && getCctvMode() === 'mock') return answer(c.alreadyMode(false), true);
    // No server address: the setup sentence. Address set but no camera connected now: the CCTV screen's own “no camera connected” text.
    if (live && !liveReady()) return refusal(cnnBaseUrl() === null ? c.liveSetup : translator(locale).t('cctv.conn.none'), 'unavailable', CCTV);
    return command('ui.setCctvMode', { mode: live ? 'live' : 'mock' }, {}, locale, { additionalReadings: [displayReading(snapshot, locale, run)] });
  }
  if (/나이대|연령|성별|남자\s*손님|여자\s*손님|[0-9]+\s*대\s*손님/u.test(text)) return answer(c.noDemographics);
  if (camera) {
    const reconnect = /다시\s*(?:연결|붙)|재연결|붙여\s*줘|연결해\s*줘/u.test(text);
    const keys = ['cctv.cameras.count', 'cctv.cameras.problem', 'cctv.camera.status'];
    if (reconnect) return { ...read(CCTV, keys), onMissing: { answer: c.reconnectByOwner, reason: 'widget_only', alternative: { featureId: CCTV } } };
    return read(CCTV, keys);
  }
  if (real) {
    if (/(?:CCTV|씨씨티비|카메라|매장)\s*영상/iu.test(text)) return refusal('카메라 영상 재생은 제공하지 않아요', 'unavailable', CCTV);
    if (/브리핑/u.test(text)) return undefined;
    if (/(?:최대|피크|붐빈|붐볐|가장\s*바쁜).*(?:관측|CCTV|시간|근무)|CCTV.*(?:피크|근무|최대)/iu.test(text)) return read(CCTV, ['cctv.peak.hour', 'cctv.peak.observed', 'cctv.peak.staff']);
    if (/시간대별|시간별/u.test(text) && /관측|매장\s*인원/u.test(text)) return read(CCTV, rows.map(row => `cctv.hour.${row.hour}.observed`));
    if (/(?:지금|현재).*(?:매장|가게|홀).*몇\s*명/u.test(text)) {
      return snapshot.tables.realInsight?.cameras.some(camera => camera.deviceStatus !== 'unavailable')
        ? refusal(c.liveNumbers, 'unavailable', CCTV)
        : answer('연결된 카메라가 없어서 지금 매장 인원은 확인할 수 없어요.');
    }
    if (/방문\s*(?:수|감지)|(?:손님|몇\s*명).*(?:몇\s*명|왔|들어)|지금.*(?:매장|홀).*몇\s*명/u.test(text)) return answer('카메라 5분 집계에서 최대 관측 인원을 볼 수 있어요. 방문 수는 미측정이에요');
    if (/(?:치울|정리할)\s*(?:자리|테이블)|(?:어떤|어느).*테이블.*(?:치워|정리)/u.test(text)) return answer('치울 테이블은 확인할 수 없어요');
    return undefined;
  }
  if (/빠진|구멍|못\s*센|비어/u.test(text) && /시간/u.test(text) && /방문|감지|CCTV|센서/u.test(text)) return read(CCTV, ['cctv.gapHours', 'cctv.gapHour', 'cctv.coverage']);
  if (/(?:어느|어떤|뭐|어디).*테이블.*(?:치워|정리)|치울\s*(?:자리|테이블)|정리할\s*테이블/u.test(text)) return read(CCTV, ['cctv.tables.toClear', 'cctv.table.toClear']);
  if (/(?:지금|현재).*(?:매장|가게|홀).*(?:몇\s*명|사람)|(?:매장|홀)에.*(?:몇\s*명|사람).*(?:있|실시간)/u.test(text)) {
    if (getCctvMode() === 'live') return refusal(c.liveNumbers, 'unavailable', CCTV);
    return read(CCTV, ['cctv.inStore.now', 'cctv.occupants.now']);
  }
  if (/시간대별|시간별/u.test(text) && /방문|손님|감지/u.test(text)) return read(CCTV, rows.map(row => `cctv.hour.${row.hour}.visits`));
  if (/(?:제일|가장)\s*(?:한산|조용|손님\s*없)|손님\s*(?:제일|가장)\s*없/u.test(text)) return read(CCTV, ['cctv.quiet.hour', 'cctv.quiet.visits']);
  if (/(?:어제|전날|지난\s*주|저번\s*주|일주일\s*전)/u.test(text) && /손님|방문|CCTV/iu.test(text) && !/매출|예약|재고/u.test(text)) {
    const compare = /비교|보다|늘었|줄었|많아|적어/u.test(text);
    const today = /오늘/u.test(text);
    if (today) return { ...read(CCTV, ['cctv.visits.total', 'cctv.coverage']), onMissing: { answer: c.onlyToday } };
    return answer(`${compare ? c.notComparable : c.onlyToday}. ${c.visitsTotal} ${c.count(model.totalVisits ?? 0)}`);
  }
  const hour = hourIn(text);
  if (typeof hour === 'number' && /몇\s*건\s*(?:왔|들어|있었|이야)|몇\s*명\s*(?:왔|들어)|방문\s*(?:이|은)?\s*(?:얼마|몇)|손님\s*감지|방문\s*감지|감지/u.test(text)
    && !/완료|처리|바꿔|예약|도착|취소|변경|표시|열어|보여\s*줘$/u.test(text)) {
    return rows.some(row => row.hour === hour) ? read(CCTV, [`cctv.hour.${hour}.visits`])
      : clarification('hour', c.pickHour, rows.map(row => ({ id: String(row.hour), label: c.hourWord(row.hour) })),
        value => rows.some(row => row.hour === Number(value)) ? read(CCTV, [`cctv.hour.${Number(value)}.visits`]) : undefined);
  }
  return undefined;
}

type Named = { readonly kind: 'playlist' | 'track'; readonly id: string; readonly name: string };
function matchPlaylist(text: string, model: StoreEnvironmentModel): Named | 'mood' | 'none' | 'bare' | { readonly covered: boolean; readonly list: readonly { id: string; name: string }[] } {
  const key = nameKey(text);
  const tracks = model.music.playlists.flatMap(list => list.tracks).filter(item => key.includes(nameKey(item.title)));
  const lists = model.music.playlists.filter(item => key.includes(nameKey(item.name)));
  const longest = [...tracks.map(item => ({ kind: 'track' as const, id: item.id, name: item.title })), ...lists.map(item => ({ kind: 'playlist' as const, id: item.id, name: item.name }))]
    .sort((a, b) => nameKey(b.name).length - nameKey(a.name).length)[0];
  if (longest) return longest;
  if (/조용|잔잔|차분|고요|신나|흥겨|밝은|분위기/u.test(text)) return 'mood';
  const stop = new Set(['음악', '노래', '플레이리스트', '재생목록', '틀어줘', '틀어', '바꿔줘', '바꿔', '변경', '변경해줘', '해줘', '으로', '들어', '재생', '켜줘', '켜봐', '다시', '좀', '들려줘', '듣고', '싶어', '넘겨줘', '플리', '재생해줘', '바꿔주세요', '틀어주세요']);
  const words = text.normalize('NFKC').split(/[^\p{L}\p{N}]+/u).map(word => word.replace(/(?:으로|로|를|을|은|는)$/u, '')).filter(word => word.length >= 2 && !stop.has(word));
  const scored = model.music.playlists.map(list => {
    const tokens = list.name.split(/\s+/u).map(token => token.replace(/의$/u, ''));
    return { id: list.id, name: list.name, score: words.filter(word => tokens.some(token => token.length >= 2 && (token.includes(word) || word.includes(token)))).length };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score);
  if (!words.length) return 'bare';
  if (!scored.length) return 'none';
  const best = scored.filter(item => item.score === scored[0].score);
  const covered = words.every(word => scored.some(item => model.music.playlists.find(list => list.id === item.id)!.name.split(/\s+/u)
    .map(token => token.replace(/의$/u, '')).some(token => token.length >= 2 && (token.includes(word) || word.includes(token)))));
  return best.length === 1 && covered && (words.length >= 2 || scored[0].score >= 1)
    ? { kind: 'playlist', id: best[0].id, name: best[0].name } : { covered, list: best };
}

function routeEnvironment(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined {
  const model = environmentOf(snapshot);
  if (!model) return;
  const c = copy(locale), { music } = model, tr = fmt(locale);
  void tr;
  const asks = /[?？]\s*$|알려\s*줘|어때|있어|뭐야|뭐뭐|몇/u.test(text);
  const musicWords = /음악|노래|플레이리스트|재생\s*목록|재생목록|무슨\s*목록|볼륨|음량|소리|음소거|무음|^스킵[.!]?$|(?:곡|노래|음악)\s*스킵|(?:다음|이전|앞에|전)\s*(?:곡|노래)|이전곡|다음곡|전곡|\bBGM\b/iu.test(text);
  const climate = /온도|습도|센서|온도계|매장\s*환경|덥|건조|따뜻|더웠|몇\s*도/u.test(text);
  if (!musicWords && !climate) {
    // A stored playlist or track title with a request verb, or a mood or genre to play, is a music request.
    if (/영상|영화|동영상|CCTV|카메라|광고|홍보|유튜브|메뉴|쿠폰/iu.test(text)) return;
    const verb = /틀어|듣고\s*싶|넘겨|들려|바꿔|변경|해\s*줘|로\s*해|재생해/u.test(text);
    const named = matchPlaylist(text, model);
    const exactOrTokens = typeof named === 'object' && ('kind' in named);
    const mood = /(?:조용|잔잔|차분)/u.test(text) && verb;
    const play = /(?:틀어|들려|재생해)\s*(?:줘|주세요)/u.test(text) && (named === 'none' || typeof named === 'object' && !('kind' in named));
    if (exactOrTokens && (verb || (named as Named).kind === 'playlist' && nameKey(text).length > 3) || mood || play) return musicRoute(text, snapshot, locale, run, model);
    return;
  }
  if (musicWords) return musicRoute(text, snapshot, locale, run, model);
  // Climate
  if (/(?:알림|경고)\s*기준|적정\s*(?:온도|습도|범위).*(?:바꿔|설정|으로\s*해|올려|내려|낮춰)|(?:[0-9]+\s*도|[0-9]+\s*%).*(?:으로|로)\s*(?:바꿔|올려|내려|설정)/u.test(text) && !asks) return refusal(c.threshold);
  if (/(?:제일|가장)\s*(?:더웠|덥|따뜻|높았)|몇\s*시에\s*제일/u.test(text)) return read(ENV, ['environment.temperature.max', 'environment.temperature.min']);
  if (/적정\s*(?:온도|습도|범위)|몇\s*(?:도|%)\s*까지|(?:온도|습도).*범위/u.test(text)) return read(ENV, ['environment.temperature.range', 'environment.humidity.range']);
  if (/센서|온도계/u.test(text) && /연결|상태|살아|작동/u.test(text)) return read(ENV, ['environment.sensor.status']);
  if (/괜찮|이상|문제|덥거나|건조/u.test(text)) return read(ENV, ['environment.temperature', 'environment.humidity', 'environment.status', 'environment.temperature.range', 'environment.humidity.range']);
  if (/온도|몇\s*도/u.test(text) && asks) return read(ENV, ['environment.temperature', 'environment.measuredAt']);
  if (/습도/u.test(text) && asks) return read(ENV, ['environment.humidity', 'environment.measuredAt']);
  void music;
  return undefined;
}

function musicRoute(text: string, snapshot: DataSnapshot, locale: Locale, run: RunState | undefined, model: StoreEnvironmentModel): DomainRoute | undefined {
  const c = copy(locale), { music } = model;
  if (model.source === 'manual') return refusal(c.noDevice, 'unavailable', ENV);
  const reading = () => ({ additionalReadings: [displayReading(snapshot, locale, run)] });
  const noDevice = music.deviceStatus !== 'connected';
  const asks = /[?？]\s*$|알려\s*줘|뭐야|뭐뭐|보여\s*줘/u.test(text);
  // Reads first.
  if (/(?:플레이리스트|재생\s*목록|재생목록)/u.test(text) && /뭐뭐|목록\s*(?:알려|보여)|알려\s*줘|뭐\s*있|틀\s*수\s*있는/u.test(text) && !/지금|현재/u.test(text)) return read(ENV, ['music.playlist.option']);
  if (/(?:플레이리스트|재생\s*목록|재생목록|무슨\s*목록|어떤\s*목록)/u.test(text) && /지금|현재/u.test(text) && (asks || /틀고\s*있/u.test(text))) return read(ENV, ['music.playlist']);
  if (/틀\s*수\s*있는\s*음악/u.test(text)) return read(ENV, ['music.playlist.option']);
  if (/지금\s*무슨\s*(?:곡|노래)|재생\s*중인\s*(?:곡|노래)|(?:곡|노래)\s*뭐야/u.test(text)) return read(ENV, ['music.track', 'music.playing']);
  const wantsChange = !asks || /해\s*줘|틀어|바꿔|변경|넘겨|올려|키워|줄여|낮춰/u.test(text);
  if (noDevice && wantsChange) return refusal(c.noDevice, 'unavailable', ENV);
  // Volume.
  if (/볼륨|음량|소리|음소거|무음/u.test(text) && !/플레이리스트|재생\s*목록/u.test(text)) {
    const volume = (n: number): DomainRoute => {
      if (n === music.volumePct) return answer(c.alreadyVolume(n), true);
      return command('environment.setVolume', { volumePct: { slot: 'volumePct' } }, { volumePct: n }, locale, reading());
    };
    if (/음소거|무음|볼륨\s*(?:을\s*)?(?:0|영)\b|소리\s*(?:를\s*)?(?:끄|꺼)/u.test(text) && !/볼륨\s*(?:을\s*)?[1-9]/u.test(text)) return volume(0);
    const spoken = /(?:볼륨|음량|소리)\s*(?:를|을|은|는)?\s*([0-9]+|[가-힣]+?)\s*(?:%|퍼센트|퍼|으로|로|$)/u.exec(text);
    const parsed = spoken ? parseNavisNumber(spoken[1]) : undefined;
    const numeric = parsed ?? (() => { const m = /([0-9]{1,3})\s*(?:%|퍼센트|퍼)?/u.exec(text); return m ? Number(m[1]) : undefined; })();
    if (numeric !== undefined) {
      if (!Number.isInteger(numeric) || numeric < 0 || numeric > 100) {
        return clarification('volumePct', c.volumeRange, undefined, value => { const n = parseNavisNumber(value); return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 100 ? volume(n) : undefined; });
      }
      return volume(numeric);
    }
    if (/키워|올려|높여|크게|작아|줄여|낮춰|작게|커/u.test(text)) {
      const current = music.volumePct, up = !/줄여|낮춰|작게/u.test(text);
      const steps = [...new Set((up ? [10, 20, 30] : [-10, -20, -30]).map(step => Math.max(0, Math.min(100, current + step))))].filter(n => n !== current);
      return clarification('volumePct', c.volumeQuestion(current), steps.map(n => ({ id: String(n), label: `${n}%` })),
        value => { const n = parseNavisNumber(value); return n !== undefined && Number.isInteger(n) && n >= 0 && n <= 100 ? volume(n) : undefined; });
    }
    return undefined;
  }
  // Skip.
  if (/다음\s*(?:곡|노래)|다음곡|^스킵[.!]?$|(?:곡|노래|음악)\s*스킵|넘겨\s*줘/u.test(text) && !/플레이리스트|재생\s*목록|튜토리얼|코치|안내|팁/u.test(text)) {
    if (!music.track) return refusal(c.noDevice, 'unavailable', ENV);
    return command('environment.skipTrack', { direction: 'next' }, {}, locale, reading());
  }
  if (/이전\s*(?:곡|노래)|이전곡|앞에\s*(?:곡|노래)|전곡/u.test(text)) {
    if (!music.track) return refusal(c.noDevice, 'unavailable', ENV);
    return command('environment.skipTrack', { direction: 'previous' }, {}, locale, reading());
  }
  // Named playlist or track.
  const target = matchPlaylist(text, model);
  const playlistCommand = (id: string, name: string): DomainRoute => {
    const list = music.playlists.find(item => item.id === id);
    if (!list?.tracks.length) return refusal(c.noDevice, 'unavailable', ENV);
    if (music.playlistId === id && music.track?.id === list.tracks[0]?.id) return answer(c.alreadyPlaylist(name), true);
    return command('environment.selectPlaylist', { playlistId: { handle: 'pending' } as never }, { playlistQuery: name }, locale,
      { ...reading(), lookups: [{ kind: 'playlist', querySlot: 'playlistQuery', bind: ['playlistId'] }], intent: { kind: 'command', command: 'environment.selectPlaylist', args: {}, querySlot: 'playlistQuery' } });
  };
  const trackCommand = (id: string, name: string): DomainRoute => {
    if (music.track?.id === id) return answer(c.alreadyTrack(name), true);
    return command('environment.selectTrack', {}, { trackQuery: name }, locale,
      { ...reading(), lookups: [{ kind: 'track', querySlot: 'trackQuery', bind: ['trackId'] }], intent: { kind: 'command', command: 'environment.selectTrack', args: {}, querySlot: 'trackQuery' } });
  };
  const playlistChoices = (list: readonly { id: string; name: string }[]) => list.map(item => ({ id: item.id, label: item.name }));
  const pickPlaylist = (list: readonly { id: string; name: string }[], question: string): DomainRoute =>
    clarification('playlistId', question, playlistChoices(list), value => { const hit = list.find(item => item.id === value); return hit ? playlistCommand(hit.id, hit.name) : undefined; });
  const wantsList = typeof target === 'object' && 'kind' in target
    || /플레이리스트|재생\s*목록|재생목록|바꿔|변경|틀어|듣고|넘겨|들려|음악\s*으로|로\s*해/u.test(text);
  if (wantsList) {
    if (typeof target === 'object' && 'kind' in target) {
      return target.kind === 'track' ? trackCommand(target.id, target.name) : playlistCommand(target.id, target.name);
    }
    if (target === 'mood') return pickPlaylist(music.playlists, c.choosePlaylist);
    if (typeof target === 'object') return pickPlaylist(target.list, c.choosePlaylist);
    if (target === 'none' && /플레이리스트|재생\s*목록|재생목록|틀어|바꿔|들려|듣고/u.test(text) && !/멈춰|꺼|정지|켜/u.test(text)) return pickPlaylist(music.playlists, c.noSuchPlaylist);
  }
  // Play and pause.
  if (/멈춰|일시\s*정지|정지|(?:음악|노래)\s*(?:좀\s*)?(?:꺼|끄)|꺼\s*(?:줘|봐)/u.test(text)) {
    if (!music.track) return refusal(c.noDevice, 'unavailable', ENV);
    if (!music.playing) return answer(c.alreadyPaused, true);
    return command('environment.setPlaying', { playing: false }, {}, locale, reading());
  }
  if (/틀어|재생|켜\s*(?:줘|봐)|켜줘/u.test(text) && /음악|노래|재생/u.test(text)) {
    if (!music.track) return refusal(c.noDevice, 'unavailable', ENV);
    if (music.playing) return answer(c.alreadyPlaying, true);
    return command('environment.setPlaying', { playing: true }, {}, locale, reading());
  }
  return undefined;
}

function briefingTarget(snapshot: DataSnapshot, itemPrefix: string) {
  const model = briefingOf(snapshot);
  const item = model?.importantAlerts.groups.flatMap(group => group.items).find(entry => entry.id.startsWith(itemPrefix));
  return item?.ref as { featureId: string; itemId?: string } | undefined;
}

function routeBriefing(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined {
  const model = briefingOf(snapshot);
  if (!model) return;
  const c = copy(locale);
  const briefing = /브리핑|소식|알림/u.test(text);
  if (realCctv(snapshot) && briefing && /CCTV|카메라/iu.test(text) && /관측|근무|피크/u.test(text)) return read(BRIEFING, ['briefing.cctv.peak.hour', 'briefing.cctv.peak.observed', 'briefing.cctv.peak.staff']);
  if (briefing && /다\s*읽었|읽음|그만\s*띄워|다\s*확인했|확인했어/u.test(text) && !/열어|보여|다시/u.test(text)) {
    if (briefingAcknowledged(snapshot, run)) return answer(c.acknowledgedAlready, true);
    return command('ui.acknowledgeBriefing', {}, {}, locale, { additionalReadings: [displayReading(snapshot, locale, run)] });
  }
  if (/오늘\s*소식\s*다\s*확인했어/u.test(text)) {
    if (briefingAcknowledged(snapshot, run)) return answer(c.acknowledgedAlready, true);
    return command('ui.acknowledgeBriefing', {}, {}, locale, { additionalReadings: [displayReading(snapshot, locale, run)] });
  }
  if (/제일\s*급한|우선\s*순위|뭐부터|가장\s*중요|뭐가\s*제일\s*중요/u.test(text)) return read(BRIEFING, ['briefing.arrival.count', 'briefing.arrival.item']);
  if (/중요\s*알림|브리핑.*(?:뭐|읽어)|알림\s*내용|확인해야\s*할\s*거/u.test(text)) return read(BRIEFING, ['briefing.importantAlerts.count', 'briefing.alert.item']);
  if (/마감\s*아직\s*안\s*했|마감\s*상태\s*알려|정산\s*(?:이\s*)?끝났/u.test(text)) return read(BRIEFING, ['briefing.closing.status']);
  if (/퇴근|마감\s*전.*(?:요약|정리)|오늘\s*(?:결과|마감)\s*요약|마감\s*요약/u.test(text) && !/열어|탭|화면|띄워/u.test(text)) {
    return read(BRIEFING, ['briefing.closing.status', 'briefing.closing.netSales', 'briefing.closing.profit', 'briefing.tomorrow.reservations']);
  }
  if (/내일/u.test(text) && /준비|일정|예약|뭐\s*있|스케줄/u.test(text) && !/휴무|근무|직원/u.test(text)) {
    return read(BRIEFING, ['briefing.tomorrow.reservations', 'briefing.tomorrow.pickup', 'briefing.tomorrow.schedule']);
  }
  if (/예약\s*브리핑|브리핑.*예약/u.test(text)) return read(BRIEFING, ['briefing.reservations.today', 'briefing.reservations.changes']);
  if (/(?:취소|변경|바뀐|바뀐\s*거).*예약|예약.*(?:취소|변경|바뀐)/u.test(text) && /있어|있나|몇\s*건|있었/u.test(text)) {
    return read(BRIEFING, ['briefing.reservations.canceled', 'briefing.reservations.changes']);
  }
  if (/어제\s*(?:매출|얼마|장사)/u.test(text)) return read(BRIEFING, ['briefing.yesterday.sales.net', 'briefing.yesterday.sales.delta']);
  return undefined;
}

/** A quoted stored title is only a lookup key: unquote it when every quote names a stored playlist or track. */
function unquoteKnown(value: string, snapshot: DataSnapshot): string | undefined {
  const model = environmentOf(snapshot);
  const names = new Set((model?.music.playlists ?? []).flatMap(list => [nameKey(list.name), ...list.tracks.map(item => nameKey(item.title))]));
  let known = true;
  const plain = value.replace(/[“"'‘]([^“”"'‘’]{1,80})[”"'’]/gu, (_, inner: string) => { if (!names.has(nameKey(inner))) known = false; return inner; });
  return known && !/[“”"'‘’]/u.test(plain) ? plain : undefined;
}

function route(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined {
  let value = normalizeNavisInput(text);
  if (/하지\s*마|말아\s*줘|무시해|\b(?:don't|never|do not)\b/iu.test(value)) return undefined;
  if (/[“”"'‘’]/u.test(value)) {
    const plain = unquoteKnown(value, snapshot);
    if (!plain) return undefined;
    value = plain;
  }
  return routeCctv(value, snapshot, locale, run) ?? routeEnvironment(value, snapshot, locale, run) ?? routeBriefing(value, snapshot, locale, run);
}

/** 검토 표시 requests: an explicit hour, the peak, or "that/busy hour" without a number. */
function markIntent(value: string): boolean {
  if (/일정|캘린더|메모|할\s*일|메뉴|쿠폰|카테고리/u.test(value)) return false;
  return /검토/u.test(value) && /표시|마크|체크/u.test(value)
    || /표시/u.test(value) && (hourIn(value) !== undefined || /피크|구간/u.test(value))
    || /(?:그|붐비는|붐빈|붐볐던|바쁜)\s*(?:시간|구간)(?:대)?\s*(?:을|를)?\s*표시/u.test(value);
}
const writeVerbs = /추가|넣어|등록|잡아|지워|삭제|취소해|만들어|보내/u;
/** Requests that other domains also recognise by a shared word (예약, 일정, 표시) but that this slice owns. */
function strong(value: string, snapshot: DataSnapshot): boolean {
  if (writeVerbs.test(value) && !/표시|바꿔/u.test(value)) return false;
  const model = environmentOf(snapshot);
  const named = model && !/영상|영화|광고|홍보|메뉴|쿠폰/u.test(value) ? matchPlaylist(value, model) : undefined;
  const musicName = !!named && typeof named === 'object' && 'kind' in named
    && (/틀어|듣고\s*싶|넘겨|들려|바꿔|변경|해\s*줘|로\s*해|재생해/u.test(value) || named.kind === 'playlist' && nameKey(value).length > 3);
  return musicName || markIntent(value)
    || /(?:CCTV|카메라|씨씨티비)/iu.test(value) && /실시간|예시/u.test(value) && /바꿔|전환|돌려|볼래/u.test(value)
    || /^(?:실시간|예시)\s*(?:보기|화면|모드)(?:로|으로)/u.test(value)
    || /(?:취소|변경|바뀐)\w*\s*(?:된\s*)?예약.*(?:있|몇)|예약.*(?:변경|취소|바뀐).*(?:있|몇)/u.test(value) && !/[가-힣]{2,4}님/u.test(value)
    || /내일/u.test(value) && /(?:준비|일정|스케줄|예약)/u.test(value) && /(?:뭐\s*있|알려|정리|준비할)/u.test(value) && !/휴무|근무|직원|임시/u.test(value)
    || /브리핑|소식/u.test(value) && /다\s*읽었|그만\s*띄워|다\s*확인했|확인했어|읽음\s*처리/u.test(value)
    || /우선\s*순위|제일\s*급한|뭐부터\s*해/u.test(value) && !/답변|리뷰|쿠폰|발주|재고|문의/u.test(value)
    || /퇴근/u.test(value) && /정리|요약|브리핑|말해/u.test(value) && !/열어|탭|화면|띄워|근무|직원/u.test(value)
    || /마감\s*아직\s*안\s*했|마감\s*상태\s*알려|정산\s*(?:이\s*)?끝났/u.test(value);
}
function routePresentation(text: string, snapshot: DataSnapshot, locale: Locale, run?: RunState): DomainRoute | undefined {
  const value = normalizeNavisInput(text);
  return strong(value, snapshot) ? route(text, snapshot, locale, run) : undefined;
}

// ───────────── navigation ─────────────
function navigation(text: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const value = normalizeNavisInput(text);
  if (/[“”"'‘’]|하지\s*마|말아\s*줘|무시해|\b(?:don't|never|do not)\b/iu.test(value)) return undefined;
  const real = realCctv(snapshot), model = real ? storedCctvRecord(snapshot) : cctvOf(snapshot);
  const open = /열어|보여\s*줘|띄워|선택|틀어|재생|가줘|눌러|자세히|상세/u.test(value);
  if (model && /^(?:[ㅅᄉ]{2}[ㅌᄐ][ㅂᄇ]|씨씨티비)\s*(?:열어|켜|보여)/u.test(value)) return { args: { featureId: CCTV } };
  if (!real && model && /(?:카페|CCTV|씨씨티비|분석한|카메라)\s*영상/iu.test(value) && /틀어|재생|보여|열어/u.test(value)) return { args: { featureId: CCTV } };
  if (model && /구간|막대|선택/u.test(value) && /보여|열어|선택/u.test(value) && !/표시/u.test(value)) {
    const hour = hourIn(value);
    if (hour !== undefined) {
      const target = hour === 'peak' ? model.peak?.hour : hour;
      if (target !== undefined && model.hours.some(row => row.hour === target)) return { args: { featureId: CCTV, hour: target } };
      return null;
    }
  }
  const briefing = /브리핑|소식/u.test(value);
  const acknowledging = /다\s*읽었|읽음|그만|확인했/u.test(value);
  if (briefing && !acknowledging && /다시|또|아까\s*닫은|팝업|카드/u.test(value)) return { args: { featureId: BRIEFING, view: 'alerts' } };
  if (briefing && /퇴근|마감/u.test(value) && /열어|탭|화면|띄워/u.test(value)) return { args: { featureId: BRIEFING, view: 'closing' } };
  if (/마감\s*요약\s*탭|퇴근\s*탭/u.test(value)) return { args: { featureId: BRIEFING, view: 'closing' } };
  if (briefing && /출근/u.test(value) && open) return { args: { featureId: BRIEFING, view: 'alerts' } };
  if (/재고|보충\s*필요/u.test(value) && /자세히\s*보여|상세\s*(?:화면|창)|열어|띄워|눌러|가\s*줘|이동/u.test(value)
    && /브리핑|알림|보충\s*필요|부족/u.test(value)) return { args: { featureId: 'inventory-booking' } };
  if (/(?:원천세|세금)/u.test(value) && /알림|자세히|눌러|쪽|상세/u.test(value) && (briefing || /알림|상세/u.test(value))) {
    const target = briefingTarget(snapshot, 'tax:');
    if (target?.itemId) return { args: { featureId: 'tax', itemId: target.itemId }, target: { kind: 'taxPayment', id: target.itemId } };
  }
  // Facts, cards and answers this domain gives are not navigation.
  return route(text, snapshot, locale) ? null : undefined;
}

export const operationsDomain: DomainAdapter = {
  commands: ([...environmentCommands, 'cctv.markPeakForReview'] as const).map(type => commandAdapter(type)) as unknown as DomainAdapter['commands'],
  runCommands: [modeCommand, acknowledgeCommand] as unknown as DomainAdapter['runCommands'],
  reads: [playlistReader, trackReader],
  featureIds: features,
  tools: [reviewTool as unknown as ReadToolAdapter],
  projectWidget,
  routePresentation,
  route,
  navigation,
};

export type { DetailRef };
