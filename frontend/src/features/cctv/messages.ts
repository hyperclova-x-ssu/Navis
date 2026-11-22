/**
 * T-070 CCTV (실시간 / 목업) messages: widget, setup, editor and status texts (DS 13.3, SCREENS 9, LOCALES 12).
 * Bundle id `cctv`, keys `cctv.*`. Row shape: key -> [ko, en, zh-Hans, zh-Hant].
 * The phone camera page texts (DS 13.4) belong to the server's static page, not to this bundle.
 * Table state words follow D-377: "사용 중 / 빈 자리" (and "치울 테이블" for a table to clear).
 * Every en / zh row is a worker draft for R2 review; zh-Hans and zh-Hant are written separately.
 */
import type { MessageBundle } from '../../i18n';

type Row = readonly [string, string, string, string];

const rows = {
  /* mode toggle and unit lines */
  'cctv.mode.live': ['실시간', 'Live', '实时', '即時'],
  'cctv.mode.mock': ['예시', 'Demo', '示例', '示範'],
  'cctv.mode.toggleLabel': ['보기 방식', 'CCTV guest analysis view', 'CCTV 顾客分析查看方式', 'CCTV 顧客分析檢視方式'],
  'cctv.mode.selected': ['{mode} 선택됨', '{mode} selected', '已选择{mode}', '已選擇{mode}'],
  'cctv.mode.changedLive': ['실시간으로 바꿨어요', 'Switched to Live', '已切换为实时', '已切換為即時'],
  'cctv.mode.changedMock': ['예시로 바꿨어요', 'Switched to Demo', '已切换为示例', '已切換為示範'],
  'cctv.unit.mock': ['매장 안 손님', 'Guests in store', '店内顾客', '店內顧客'],
  'cctv.unit.live': ['매장 안 손님 · 실시간', 'Guests in store · Live', '店内顾客 · 实时', '店內顧客 · 即時'],
  'cctv.guests': ['{n}명', '{n, plural, one {# guest} other {# guests}}', '{n} 位', '{n} 位'],
  'cctv.guestsNow': ['지금 손님 {n}명', '{n, plural, one {# guest} other {# guests}} now', '现在 {n} 位顾客', '現在 {n} 位顧客'],

  /* 5-minute change */
  'cctv.change.label': ['5분 전보다', 'vs 5 min ago', '比 5 分钟前', '比 5 分鐘前'],
  'cctv.change.up': ['5분 전보다 ▲ {n}명', 'Up {n} from 5 min ago', '比 5 分钟前多 {n} 位', '比 5 分鐘前多 {n} 位'],
  'cctv.change.down': ['5분 전보다 ▼ {n}명', 'Down {n} from 5 min ago', '比 5 分钟前少 {n} 位', '比 5 分鐘前少 {n} 位'],
  'cctv.change.flat': ['5분 전보다 변화 없음', 'No change from 5 min ago', '与 5 分钟前相比无变化', '與 5 分鐘前相比無變化'],
  'cctv.change.none': ['5분 전보다 —', 'vs 5 min ago —', '比 5 分钟前 —', '比 5 分鐘前 —'],

  /* tables and numbers */
  'cctv.table.n': ['테이블 {n}', 'Table {n}', '桌位 {n}', '桌位 {n}'],
  'cctv.table.state.occupied': ['사용 중', 'In use', '使用中', '使用中'],
  'cctv.table.state.empty': ['빈 자리', 'Empty', '空位', '空位'],
  'cctv.table.state.clear': ['치울 테이블', 'To clear', '待清理', '待清理'],
  'cctv.table.drinkWait.waiting': ['음료 기다리는 중 {time}', 'Waiting for drinks {time}', '等饮品 {time}', '等飲品 {time}'],
  'cctv.table.drinkWait.received': ['사용 중 · 받기까지 {time}', 'In use · Drinks arrived after {time}', '使用中 · 等了 {time}', '使用中 · 等了 {time}'],
  'cctv.table.drinkWait.notMeasured': ['사용 중 · 받기까지 미측정', 'In use · Wait unmeasured', '使用中 · 等候时间未测量', '使用中 · 等候時間未測量'],
  'cctv.table.drinkWait.unknown': ['사용 중 · 시작 모름', 'In use · Start unknown', '使用中 · 开始时间不明', '使用中 · 開始時間不明'],
  'cctv.table.drinkWait.checking': ['자리 확인 중', 'Checking table', '正在确认桌位', '正在確認桌位'],
  'cctv.table.row': ['{name} · {state}', '{name} · {state}', '{name} · {state}', '{name} · {state}'],
  'cctv.tables.inUse': ['사용 중인 자리 {a}/{b}', 'Tables in use {a}/{b}', '使用中的桌位 {a}/{b}', '使用中的桌位 {a}/{b}'],
  'cctv.tables.toClear': ['치울 테이블 {n}개', '{n, plural, one {# table to clear} other {# tables to clear}}', '{n} 张桌子待清理', '{n} 張桌子待清理'],
  'cctv.tables.showStates': ['자리 상태 보기', 'Show table states', '查看桌位状态', '查看桌位狀態'],
  'cctv.avg.mock': ['시간대별 평균 머문 시간', 'Average stay by hour', '各时段平均停留时间', '各時段平均停留時間'],
  'cctv.avg.mockToday': ['오늘 평균 머문 시간 {n}분', 'Average stay today: {n} min', '今日平均停留 {n} 分钟', '今日平均停留 {n} 分鐘'],
  'cctv.avg.live': ['평균 머문 시간 · 카메라로 쟀어요', 'Average stay · measured by camera', '平均停留时间 · 摄像头测得', '平均停留時間 · 攝影機測得'],
  'cctv.avg.liveCaption': ['카메라로 쟀어요 · 사용 중이던 시간의 평균이에요', 'Measured by camera · average time in use', '摄像头测得 · 使用时间的平均值', '攝影機測得 · 使用時間的平均值'],
  'cctv.avg.none': ['아직 재는 중이에요', 'Still measuring', '仍在测量中', '仍在測量中'],
  'cctv.avg.minutes': ['{n}분', '{n} min', '{n} 分钟', '{n} 分鐘'],
  'cctv.avg.minutesSeconds': ['{m}분 {s}초', '{m} min {s} s', '{m} 分 {s} 秒', '{m} 分 {s} 秒'],
  'cctv.avg.seconds': ['{s}초', '{s} s', '{s} 秒', '{s} 秒'],
  'cctv.occupied.caption': ['최근 5분 중 사용 중이던 시간', 'Time in use in the last 5 min', '最近 5 分钟中的使用时间', '最近 5 分鐘中的使用時間'],
  'cctv.nowNumbers.mock': ['지금 숫자', 'Now', '当前数字', '目前數字'],
  'cctv.nowNumbers.live': ['지금 숫자 · 실시간', 'Now · Live', '当前数字 · 实时', '目前數字 · 即時'],
  'cctv.example': ['예시', 'Sample', '示例', '範例'],
  'cctv.dayRecord.title': ['하루 기록', 'Daily record', '当日记录', '當日記錄'],
  'cctv.dayRecord.notCamera': ['카메라 값이 아니에요', 'Not from the camera', '非摄像头数据', '非攝影機資料'],
  'cctv.legend.person': ['사람', 'Person', '人', '人'],
  'cctv.legend.occupied': ['사용 중', 'In use', '使用中', '使用中'],
  'cctv.legend.empty': ['빈 자리', 'Empty', '空位', '空位'],
  'cctv.legend.clear': ['치워요', 'Clear it', '请清理', '請清理'],

  /* mock table names (file data, cnn D-59) */
  'cctv.mockTable.t1': ['왼쪽 나무 테이블', 'Left wooden table', '左侧木桌', '左側木桌'],
  'cctv.mockTable.t2': ['가운데 흰 테이블', 'Center white table', '中间白桌', '中間白桌'],
  'cctv.mockTable.t3': ['주문대 옆 흰 테이블', 'White table by the counter', '点单台旁的白桌', '點餐櫃檯旁的白桌'],
  'cctv.mockTable.t4': ['긴 테이블 안쪽(창고 쪽) 자리', 'Inner seat at the long table (storeroom side)', '长桌里侧（仓库一侧）座位', '長桌內側（倉庫一側）座位'],

  /* connection states (DS 13.3, SCREENS 9.2) */
  'cctv.conn.none': ['연결된 카메라가 없어요', 'No camera connected', '尚未连接摄像头', '尚未連接攝影機'],
  'cctv.conn.connect': ['카메라 연결하기', 'Connect camera', '连接摄像头', '連接攝影機'],
  'cctv.conn.openSetup': ['연결 화면 열기', 'Open connection screen', '打开连接页面', '開啟連線頁面'],
  'cctv.conn.waiting': ['카메라를 기다리고 있어요', 'Waiting for the camera', '正在等待摄像头', '正在等待攝影機'],
  'cctv.conn.phoneOpened': ['휴대폰이 열렸어요. 영상을 기다리고 있어요', 'Phone opened. Waiting for video', '手机已打开，正在等待视频', '手機已開啟，正在等待影像'],
  'cctv.conn.allowCheck': ['휴대폰에서 카메라를 허용했는지 확인해 주세요', 'Check that you allowed camera access on your phone', '请确认手机已允许使用摄像头', '請確認手機已允許使用攝影機'],
  'cctv.conn.live': ['카메라가 연결됐어요', 'Camera connected', '摄像头已连接', '攝影機已連接'],
  'cctv.conn.liveStatus': ['카메라 연결됨', 'Camera connected', '摄像头已连接', '攝影機已連接'],
  'cctv.conn.reconnecting': ['다시 연결하는 중이에요', 'Reconnecting', '正在重新连接', '正在重新連接'],
  'cctv.conn.lost': ['카메라 연결이 끊겼어요', 'Camera disconnected', '摄像头连接已断开', '攝影機連線已中斷'],
  'cctv.conn.lostReason': ['휴대폰 화면이 꺼졌거나 Tailscale이 꺼졌는지 확인해 주세요', 'Check that the phone screen is on and Tailscale is running', '请确认手机屏幕未熄灭且 Tailscale 正在运行', '請確認手機螢幕未熄滅且 Tailscale 正在執行'],
  'cctv.conn.reconnect': ['다시 연결하기', 'Reconnect', '重新连接', '重新連接'],
  'cctv.conn.serverDown': ['카메라에 연결하지 못했어요', "Can't reach the server", '无法连接服务器', '無法連線伺服器'],
  'cctv.conn.serverUnreachable': ['카메라와 연결 장치가 켜져 있는지 확인해 주세요', 'Check that Tailscale and the server are on', '请确认 Tailscale 和服务器已开启', '請確認 Tailscale 與伺服器已開啟'],
  'cctv.conn.serverNotConfigured': ['실시간 연결이 아직 준비되지 않았어요. 예시 화면은 계속 볼 수 있어요', "The server address isn't set", '尚未设置服务器地址', '尚未設定伺服器位址'],
  'cctv.conn.serverBadOrigin': ['이 주소에서는 서버에 연결할 수 없어요', "The server can't be reached from this address", '无法从此地址连接服务器', '無法從此位址連線伺服器'],
  'cctv.conn.serverBack': ['서버에 다시 연결됐어요', 'Reconnected to the server', '已重新连接服务器', '已重新連線伺服器'],
  'cctv.conn.viewExample': ['예시로 보기', 'View demo', '查看示例', '查看示範'],
  'cctv.conn.retry': ['다시 시도하기', 'Try again', '重试', '重試'],
  'cctv.conn.stats': ['지연 {sec}초 · 초당 {fps}번', 'Delay {sec} s · {fps} per second', '延迟 {sec} 秒 · 每秒 {fps} 次', '延遲 {sec} 秒 · 每秒 {fps} 次'],
  'cctv.conn.liveVideo': ['실시간 화면', 'Live view', '实时画面', '即時畫面'],

  /* setup (QR) */
  'cctv.qr.guide': ['휴대폰에서 Tailscale을 켜고 QR을 찍어 주세요', 'Turn on Tailscale on your phone and scan the QR code', '请在手机上开启 Tailscale 并扫描二维码', '請在手機上開啟 Tailscale 並掃描 QR 碼'],
  'cctv.qr.copyLink': ['주소 복사', 'Copy link', '复制链接', '複製連結'],
  'cctv.qr.copied': ['주소를 복사했어요', 'Link copied', '已复制链接', '已複製連結'],
  'cctv.qr.code': ['코드', 'Code', '代码', '代碼'],
  'cctv.qr.expired': ['QR이 만료됐어요', 'The QR code expired', '二维码已过期', 'QR 碼已過期'],
  'cctv.qr.renew': ['새 QR 만들기', 'Make a new QR code', '生成新二维码', '產生新 QR 碼'],
  'cctv.qr.noSave': ['영상은 저장하지 않아요', "Video isn't saved", '视频不会被保存', '影像不會被儲存'],
  'cctv.setup.steps': ['카메라 연결 / 테이블 영역', 'Camera / Table areas', '连接摄像头 / 桌位区域', '連接攝影機 / 桌位區域'],
  'cctv.setup.stepCamera': ['카메라 연결', 'Camera', '连接摄像头', '連接攝影機'],
  'cctv.setup.stepZones': ['테이블 영역', 'Table areas', '桌位区域', '桌位區域'],

  /* zones */
  'cctv.zones.needed': ['테이블 영역을 정해 주세요', 'Set your table areas', '请设置桌位区域', '請設定桌位區域'],
  'cctv.zones.setup': ['테이블 정하기', 'Set up tables', '设置桌位', '設定桌位'],
  'cctv.zones.help1': ['점선으로 보이는 곳이 테이블이에요. 눌러서 쓰세요', 'Dotted areas are tables. Tap to use them', '虚线处是桌子，点按即可使用', '虛線處是桌子，點按即可使用'],
  'cctv.zones.help2': ['빠진 테이블은 손가락으로 빙 둘러 그려 주세요', 'Draw around any missing table with your finger', '漏掉的桌子请用手指圈出', '漏掉的桌子請用手指圈出'],
  'cctv.zones.help3': ['잘못된 곳은 지우개로 문지르거나 꾹 눌러 지워요', 'Rub with the eraser or press and hold to delete', '用橡皮擦涂抹或长按即可删除', '用橡皮擦塗抹或長按即可刪除'],
  'cctv.zones.helpTitle': ['처음이시죠?', 'First time?', '第一次使用？', '第一次使用？'],
  'cctv.zones.howTo': ['사용법', 'How to', '使用方法', '使用方法'],
  'cctv.zones.toolDraw': ['둘러 그리기', 'Draw around', '圈画', '圈畫'],
  'cctv.zones.toolErase': ['지우개', 'Eraser', '橡皮擦', '橡皮擦'],
  'cctv.zones.toolUndo': ['되돌리기', 'Undo', '撤销', '復原'],
  'cctv.zones.toolDone': ['완료', 'Done', '完成', '完成'],
  'cctv.zones.suggested': ['추천', 'Suggested', '推荐', '建議'],
  'cctv.zones.suggestedHint': ['추천 영역(점선) — 눌러서 쓰기', 'Suggested area (dotted) — tap to use', '推荐区域（虚线）— 点按使用', '建議區域（虛線）— 點按使用'],
  'cctv.zones.holdToDelete': ['길게 눌러 통째로 지우기', 'Press and hold to delete the whole area', '长按可整体删除', '長按可整個刪除'],
  'cctv.zones.finding': ['테이블을 찾고 있어요', 'Finding tables', '正在查找桌位', '正在尋找桌位'],
  'cctv.zones.noneFound': ['추천할 테이블을 찾지 못했어요. 손가락으로 둘러 그려 주세요', 'No tables found. Draw around them with your finger', '未找到桌位，请用手指圈出', '未找到桌位，請用手指圈出'],
  'cctv.zones.tooSmall': ['테이블을 빙 둘러 그려 주세요', 'Draw all the way around the table', '请完整圈出桌子', '請完整圈出桌子'],
  'cctv.zones.nothingToUndo': ['되돌릴 것이 없어요', 'Nothing to undo', '没有可撤销的操作', '沒有可復原的操作'],
  'cctv.zones.atLeastOne': ['테이블을 하나 이상 정해 주세요', 'Set at least one table', '请至少设置一张桌子', '請至少設定一張桌子'],
  'cctv.zones.saved': ['테이블 영역을 저장했어요', 'Table areas saved', '桌位区域已保存', '桌位區域已儲存'],
  'cctv.zones.saveFailed': ['저장하지 못했어요. 다시 시도해 주세요', "Couldn't save. Please try again", '保存失败，请重试', '儲存失敗，請重試'],
  'cctv.zoneSave.invalid': ['구역 정보에 문제가 있어요', 'The area details are invalid', '区域信息有误', '區域資訊有誤'],
  'cctv.zoneSave.checkDrawing': ['그린 구역을 확인해 주세요', 'Check the areas you drew', '请检查画出的区域', '請檢查畫出的區域'],
  'cctv.zoneSave.outline': ['구역 윤곽이 끊어져 있거나 너무 복잡해요', 'The area outline is disconnected or too complex', '区域轮廓断开或过于复杂', '區域輪廓斷開或過於複雜'],
  'cctv.zoneSave.redraw': ['한 구역을 한 번에 둘러 그려 주세요', 'Draw one continuous outline per area', '请为每个区域画一条连续的轮廓', '請為每個區域畫一條連續的輪廓'],
  'cctv.zoneSave.missingOutline': ['윤곽이 없는 기존 구역이 있어요', 'An existing area has no outline', '有一个现有区域没有轮廓', '有一個現有區域沒有輪廓'],
  'cctv.zoneSave.replaceOutline': ['목록에서 지우고 다시 그려 주세요', 'Remove it from the list and redraw it', '请从列表中删除后重画', '請從清單中刪除後重畫'],
  'cctv.zoneSave.cameraMissing': ['카메라를 찾을 수 없어요', 'The camera could not be found', '找不到摄像头', '找不到攝影機'],
  'cctv.zoneSave.checkCamera': ['카메라 연결을 확인해 주세요', 'Check the camera connection', '请检查摄像头连接', '請檢查攝影機連線'],
  'cctv.zoneSave.zoneMissing': ['저장된 구역을 찾을 수 없어요', 'A saved area could not be found', '找不到已保存的区域', '找不到已儲存的區域'],
  'cctv.zoneSave.stale': ['그사이 구역이 바뀌었어요', 'The areas changed in the meantime', '区域已发生变化', '區域已發生變更'],
  'cctv.zoneSave.reload': ['최신 구역을 불러와 주세요', 'Load the latest areas', '请加载最新区域', '請載入最新區域'],
  'cctv.zoneSave.loadLatest': ['최신 구역 불러오기', 'Load latest areas', '加载最新区域', '載入最新區域'],
  'cctv.zoneSave.confirmationRequired': ['구역을 지우려면 확인이 필요해요', 'Removing an area requires confirmation', '删除区域需要确认', '刪除區域需要確認'],
  'cctv.zoneSave.confirmDeletion': ['삭제를 확인한 뒤 저장해 주세요', 'Confirm the removal and save again', '请确认删除后重新保存', '請確認刪除後重新儲存'],
  'cctv.zoneSave.invalidRequest': ['저장 요청을 확인할 수 없어요', 'The save request could not be verified', '无法验证保存请求', '無法驗證儲存請求'],
  'cctv.zoneSave.outcomeUnknown': ['구역 저장 결과를 확인하지 못했어요. 다시 시도해 주세요', 'The save result could not be verified. Try again', '无法确认区域是否已保存。请重试', '無法確認區域是否已儲存。請重試'],
  'cctv.zoneSave.savedReload': ['구역을 저장했어요. 저장 결과를 다시 불러와 확인해 주세요', 'The areas were saved. Reload to check the result', '区域已保存。请重新加载以确认结果', '區域已儲存。請重新載入以確認結果'],
  'cctv.zones.deleted': ['테이블 {n}을 지웠어요 · 되돌리기', 'Table {n} deleted · Undo', '已删除桌位 {n} · 撤销', '已刪除桌位 {n} · 復原'],
  'cctv.zones.aspectMismatch': ['카메라 방향이 바뀐 것 같아요. 테이블 영역을 다시 확인해 주세요', 'The camera orientation seems to have changed. Please check your table areas', '摄像头方向似乎已改变，请重新确认桌位区域', '攝影機方向似乎已改變，請重新確認桌位區域'],

  /* player and detail */
  'cctv.player.pause': ['영상 멈추기', 'Pause video', '暂停画面', '暫停畫面'],
  'cctv.player.resume': ['다시 보기', 'Resume', '继续', '繼續'],
  'cctv.player.boxes': ['상자 보기', 'Show boxes', '显示方框', '顯示方框'],
  'cctv.video.failed': ['영상을 불러오지 못했어요', "Couldn't load the video", '无法加载视频', '無法載入影片'],
  'cctv.video.numbersKept': ['숫자는 그대로 볼 수 있어요', 'You can still see the numbers', '数字仍可查看', '數字仍可查看'],
  'cctv.video.reload': ['다시 불러오기', 'Reload', '重新加载', '重新載入'],
  'cctv.player.play': ['재생', 'Play', '播放', '播放'],
  'cctv.player.pauseMock': ['일시정지', 'Pause', '暂停', '暫停'],
  'cctv.player.replay': ['다시 재생', 'Play again', '重新播放', '重新播放'],
  'cctv.player.restart': ['처음부터', 'From the start', '从头开始', '從頭開始'],
  'cctv.player.position': ['재생 위치', 'Playback position', '播放位置', '播放位置'],
  'cctv.player.time': ['{m}분 {s}초', '{m} min {s} s', '{m} 分 {s} 秒', '{m} 分 {s} 秒'],
  'cctv.player.positionValue': ['{now} / {total}', '{now} / {total}', '{now} / {total}', '{now} / {total}'],
  'cctv.player.loop': ['반복 재생', 'Repeat', '循环播放', '循環播放'],
  'cctv.player.disabledWhy': ['영상이 없어서 쓸 수 없어요', "Unavailable because there's no video", '没有视频，无法使用', '沒有影片，無法使用'],
  'cctv.video.loading': ['영상을 불러오고 있어요', 'Loading the video', '正在加载视频', '正在載入影片'],
  'cctv.video.boxesFailed': ['상자 정보를 불러오지 못했어요', "Couldn't load the box data", '无法加载方框信息', '無法載入方框資訊'],
  'cctv.avg.hourLabel': ['{h}시대', '{h}:00', '{h} 时段', '{h} 時段'],
  'cctv.avg.hourBar': ['{h}시대 {n}분', '{h}:00 hour: {n} min', '{h} 时段 {n} 分钟', '{h} 時段 {n} 分鐘'],
  'cctv.seats.title': ['자리별 머문 시간', 'Time at each table', '各桌位停留时间', '各桌位停留時間'],
  'cctv.seats.row': ['{name} {time}', '{name} {time}', '{name} {time}', '{name} {time}'],
  'cctv.footer.mock': ['직접 찍은 매장 영상을 미리 분석했어요', 'We analyzed our own store footage in advance', '我们预先分析了自己拍摄的店内视频', '我們預先分析了自己拍攝的店內影片'],
  'cctv.footer.live': ['영상은 저장하지 않아요', "Video isn't saved", '视频不会被保存', '影像不會被儲存'],

  /* widget menu */
  'cctv.menu.label': ['더 보기', 'Widget menu', '小组件菜单', '小工具選單'],
  'cctv.menu.reconnect': ['카메라 다시 연결', 'Reconnect camera', '重新连接摄像头', '重新連接攝影機'],
  'cctv.menu.resetZones': ['테이블 다시 설정', 'Set up tables again', '重新设置桌位', '重新設定桌位'],
  'cctv.menu.needCamera': ['카메라를 먼저 연결해 주세요', 'Connect the camera first', '请先连接摄像头', '請先連接攝影機'],

  /* panel accessible names */
  'cctv.a11y.panelLive': ['CCTV 손님분석, 실시간, 지금 매장 안 손님 {n}명, 자세히 보기', 'CCTV guest analysis, Live, {n, plural, one {# guest} other {# guests}} in the store now, view details', 'CCTV 顾客分析，实时，店内现有 {n} 位顾客，查看详情', 'CCTV 顧客分析，即時，店內現有 {n} 位顧客，查看詳情'],
  'cctv.a11y.video': ['카메라 영상과 사람 위치', 'Camera video with people marked', '摄像头画面与人员位置', '攝影機畫面與人員位置'],

  /* zone editor (folded in from T-073) and setup (T-074) */
  'cctv.zoneEditor.stage': ['테이블 영역 편집 화면', 'Table area editor', '桌位区域编辑画面', '桌位區域編輯畫面'],
  'cctv.zoneEditor.adopted': ['{name}, 채택됨', '{name}, in use', '{name}，已采用', '{name}，已採用'],
  'cctv.zoneEditor.keepPressing': ['계속 누르세요', 'Keep holding', '请继续按住', '請繼續按住'],
  'cctv.zoneEditor.list': ['테이블 목록', 'Table list', '桌位列表', '桌位列表'],
  'cctv.zoneEditor.adopt': ['채택', 'Use', '使用', '使用'],
  'cctv.zoneEditor.delete': ['지우기', 'Delete', '删除', '刪除'],
  'cctv.zoneEditor.deleteZone': ['{name} 지우기', 'Delete {name}', '删除{name}', '刪除{name}'],
  'cctv.zoneEditor.added': ['{name, particle, 을/를} 만들었어요', '{name} added', '已添加{name}', '已新增{name}'],
  'cctv.zoneEditor.erased': ['지운 부분을 뺐어요', 'Erased part of the area', '已擦除部分区域', '已擦除部分區域'],
  'cctv.zoneEditor.summary': ['테이블 {a}개 · 추천 {b}개 남았어요', '{a, plural, one {# table} other {# tables}} · {b} suggested left', '{a} 张桌子 · 还剩 {b} 个推荐', '{a} 張桌子 · 還剩 {b} 個建議'],
  'cctv.zoneEditor.summaryTables': ['테이블 {a}개', '{a, plural, one {# table} other {# tables}}', '{a} 张桌子', '{a} 張桌子'],
  'cctv.zoneEditor.conflict': ['다른 곳에서 바뀌었어요. 다시 시도하면 지금 그린 영역으로 저장해요', 'Changed elsewhere. Try again to save what you drew', '已在别处更改。重试将保存当前绘制的区域', '已在別處變更。重試將儲存目前繪製的區域'],
  'cctv.zoneEditor.saving': ['저장하는 중이에요', 'Saving', '正在保存', '正在儲存'],
  'cctv.zones.conflict': ['다른 곳에서 영역이 바뀌었어요. 다시 불러와 주세요', 'The areas were changed elsewhere. Please reload them', '桌位区域已在别处更改，请重新加载', '桌位區域已在別處變更，請重新載入'],
  'cctv.zones.reload': ['다시 불러오기', 'Reload', '重新加载', '重新載入'],
  'cctv.conn.noFrame': ['카메라 화면을 기다리고 있어요', 'Waiting for the camera picture', '正在等待摄像头画面', '正在等待攝影機畫面'],
  'cctv.setup.qrAlt': ['카메라 연결 QR 코드', 'QR code to connect the camera', '连接摄像头的二维码', '連接攝影機的 QR 碼'],
  'cctv.setup.connected': ['카메라가 연결됐어요', 'Camera connected', '摄像头已连接', '攝影機已連接'],
  'cctv.setup.makingQr': ['QR을 만들고 있어요', 'Making the QR code', '正在生成二维码', '正在產生 QR 碼'],
  'cctv.setup.rateLimited': ['잠시 뒤에 다시 시도해 주세요', 'Please try again in a moment', '请稍后重试', '請稍後重試'],
  'cctv.setup.cameraBusy': ['이미 카메라가 연결돼 있어요', 'A camera is already connected', '已连接摄像头', '已連接攝影機'],
  'cctv.setup.close': ['닫기', 'Close', '关闭', '關閉'],
} as const satisfies Record<string, Row>;

export type CctvMessageKey = keyof typeof rows;

const pick = (i: 0 | 1 | 2 | 3): Readonly<Record<CctvMessageKey, string>> =>
  Object.freeze(Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, (row as Row)[i]]))) as Readonly<Record<CctvMessageKey, string>>;

/** The CCTV bundle (id `cctv`). */
export const cctvBundle: MessageBundle<CctvMessageKey> = Object.freeze({ id: 'cctv', ko: pick(0), en: pick(1), 'zh-Hans': pick(2), 'zh-Hant': pick(3) });

/** Message keys of the mock table names, by file table id. */
export const MOCK_TABLE_KEYS = Object.freeze({ t1: 'cctv.mockTable.t1', t2: 'cctv.mockTable.t2', t3: 'cctv.mockTable.t3', t4: 'cctv.mockTable.t4' } as const);
