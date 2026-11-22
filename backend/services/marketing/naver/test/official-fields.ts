/**
 * Official W field lists copied from the NCP and NAVER documentation pages (accessed 2026-11-21 KST),
 * independent of the adapter shapes. Sources: naver-api-hub-search-{blog,cafearticle,local,news},
 * naver-api-hub-search-trend, application-maps-geocoding, sens-sms-send, sens-alimtalk-send,
 * sens-brandmessage-send, sens-mail-request-create (api.ncloud-docs.com) and
 * github.com/navertalk/chatbot-api README (보내기 API).
 */
export const OFFICIAL = {
  searchEnvelope: ['lastBuildDate', 'total', 'start', 'display', 'items'],
  blog: ['title', 'link', 'description', 'bloggername', 'bloggerlink', 'postdate'],
  cafearticle: ['title', 'link', 'description', 'cafename', 'cafeurl'],
  local: ['title', 'link', 'category', 'description', 'telephone', 'address', 'roadAddress', 'mapx', 'mapy'],
  news: ['title', 'originallink', 'link', 'description', 'pubDate'],
  trend: ['startDate', 'endDate', 'timeUnit', 'results', 'results[].title', 'results[].keywords', 'results[].data', 'results[].data[].period', 'results[].data[].ratio'],
  geocode: ['status', 'meta', 'meta.totalCount', 'meta.page', 'meta.count', 'addresses', 'errorMessage', 'addresses[].roadAddress', 'addresses[].jibunAddress',
    'addresses[].englishAddress', 'addresses[].addressElements', 'addresses[].x', 'addresses[].y', 'addresses[].distance',
    'addresses[].addressElements[].types', 'addresses[].addressElements[].longName', 'addresses[].addressElements[].shortName', 'addresses[].addressElements[].code'],
  smsRequest: ['type', 'contentType', 'countryCode', 'from', 'subject', 'content', 'messages', 'files', 'reserveTime', 'reserveTimeZone', 'messages[].to', 'messages[].subject', 'messages[].content'],
  smsAccepted: ['requestId', 'requestTime', 'statusCode', 'statusName'],
  alimtalkRequest: ['plusFriendId', 'templateCode', 'messages', 'reserveTime', 'reserveTimeZone', 'messages[].countryCode', 'messages[].to', 'messages[].title',
    'messages[].content', 'messages[].headerContent', 'messages[].itemHighlight', 'messages[].item', 'messages[].buttons', 'messages[].useSmsFailover', 'messages[].failoverConfig'],
  brandRequest: ['plusFriendId', 'messageType', 'targeting', 'isAdult', 'messages', 'reserveTime', 'reserveTimeZone', 'messages[].countryCode', 'messages[].to',
    'messages[].content', 'messages[].buttons', 'messages[].coupon', 'messages[].useSmsFailover', 'messages[].failoverConfig'],
  mailRequest: ['senderAddress', 'senderName', 'templateNo', 'title', 'body', 'individual', 'confirmAndSend', 'advertising', 'parameters', 'reservationDateTime',
    'attachFileIds', 'recipients', 'recipientGroupFilter', 'useBasicUnsubscribeMessage', 'unsubscribeMessage', 'recipients[].address', 'recipients[].name',
    'recipients[].type', 'recipients[].parameters'],
  chatbotSend: ['event', 'user', 'textContent', 'textContent.text', 'options'],
};

/** Paths present in a wire value that the official list does not contain. */
export const outside = (actual: string[], official: readonly string[]) => actual.filter(path => !official.includes(path));
