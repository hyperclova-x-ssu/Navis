import { defineBundle, useBundle } from '../../../i18n';

const copy = defineBundle({
  id: 'real-grants',
  ko: { 'funding.title': '네이버 금융센터 추천', 'funding.all': '전체', 'funding.filter': '공고 출처', 'funding.source': '네이버 금융센터', 'funding.basis': '기준일', 'funding.original': '공고 원문',
    'grants.noBizinfo': '기업마당 공고가 없어요', 'grants.regionHint': '매장이 있는 지역을 넣어 주세요', 'grants.industryHint': '매장 업종을 넣어 주세요',
    'grants.copyHint': '초안을 넣으면 복사할 수 있어요', 'grants.chooseNotice': '공고를 고르면 신청서 초안을 만들 수 있어요', 'funding.loading': '추천 공고를 불러오는 중이에요', 'funding.error': '네이버 금융센터 추천을 불러오지 못했어요', 'funding.disconnected': '네이버 금융센터가 연결되어 있지 않아요', 'funding.empty': '추천 공고가 없어요', 'funding.closed': '마감', 'funding.end': '마감일', 'funding.documents': '필요 서류', 'funding.open': '공식 안내 열기',
    'grants.sync': '공고 불러오기', 'grants.region': '지역', 'grants.industry': '업종', 'grants.match': '지역·업종이 맞는 공고',
    'grants.source': '기업마당', 'grants.updated': '공고를 가져온 시각', 'grants.start': '시작일', 'grants.noDate': '공식 공고에서 확인', 'grants.method': '신청 방법', 'grants.target': '지원 대상', 'grants.deleteQuestion': '이 신청 기록을 지울까요?' },
  en: { 'funding.title': 'NAVER Financial Center recommendations', 'funding.all': 'All', 'funding.filter': 'Notice source', 'funding.source': 'NAVER Financial Center', 'funding.basis': 'As of', 'funding.loading': 'Loading recommendations…', 'funding.error': 'Could not load the recommendation information.', 'funding.disconnected': 'NAVER Financial Center is disconnected.', 'funding.empty': 'There are no recommendations.', 'funding.closed': 'Closed', 'funding.end': 'Closing date', 'funding.documents': 'Required documents', 'funding.open': 'Open official guidance',
    'grants.sync': 'Load notices', 'grants.region': 'Region', 'grants.industry': 'Industry', 'grants.match': 'Notices matching your region and industry',
    'grants.source': 'Bizinfo', 'grants.updated': 'Retrieved at', 'grants.start': 'Start date', 'grants.noDate': 'See the official notice', 'grants.method': 'How to apply', 'grants.target': 'Eligibility', 'grants.deleteQuestion': 'Delete this application record?' },
  'zh-Hans': { 'funding.title': 'NAVER 金融中心推荐', 'funding.all': '全部', 'funding.filter': '公告来源', 'funding.source': 'NAVER 金融中心', 'funding.basis': '数据日期', 'funding.loading': '正在加载推荐公告', 'funding.error': '无法加载推荐公告', 'funding.disconnected': '尚未连接 NAVER 金融中心', 'funding.empty': '暂无推荐公告', 'funding.closed': '已截止', 'funding.end': '截止日期', 'funding.documents': '所需材料', 'funding.open': '打开官方指南',
    'grants.sync': '获取公告', 'grants.region': '地区', 'grants.industry': '行业', 'grants.match': '符合地区与行业的公告',
    'grants.source': 'Bizinfo', 'grants.updated': '获取时间', 'grants.start': '开始日期', 'grants.noDate': '请查阅官方公告', 'grants.method': '申请方式', 'grants.target': '适用对象', 'grants.deleteQuestion': '删除这条申请记录？' },
  'zh-Hant': { 'funding.title': 'NAVER 金融中心推薦', 'funding.all': '全部', 'funding.filter': '公告來源', 'funding.source': 'NAVER 金融中心', 'funding.basis': '資料日期', 'funding.loading': '正在載入推薦公告', 'funding.error': '無法載入推薦公告', 'funding.disconnected': '尚未連接 NAVER 金融中心', 'funding.empty': '暫無推薦公告', 'funding.closed': '已截止', 'funding.end': '截止日期', 'funding.documents': '所需文件', 'funding.open': '開啟官方指南',
    'grants.sync': '取得公告', 'grants.region': '地區', 'grants.industry': '產業', 'grants.match': '符合地區與產業的公告',
    'grants.source': 'Bizinfo', 'grants.updated': '取得時間', 'grants.start': '開始日期', 'grants.noDate': '請查閱官方公告', 'grants.method': '申請方式', 'grants.target': '適用對象', 'grants.deleteQuestion': '刪除這筆申請紀錄？' },
});

export const useGrantsCopy = () => useBundle(copy);
