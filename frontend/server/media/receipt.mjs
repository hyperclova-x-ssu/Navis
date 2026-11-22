import { MediaError } from './errors.mjs';

const REVIEW_THRESHOLD = 0.80;

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function won(value) {
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^₩\s*|\s*원$/g, '');
    if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(cleaned)) return null;
    value = Number(cleaned.replaceAll(',', ''));
  }
  return Number.isSafeInteger(value) ? value : null;
}

function quantity(value) {
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

function date(value) {
  let parts;
  if (typeof value === 'object' && value !== null) {
    parts = [value.year, value.month, value.day].map(part => String(part ?? ''));
  } else if (typeof value === 'string') {
    parts = /^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*(?:일|\.)?$/.exec(value.trim())?.slice(1)
      ?? /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim())?.slice(1);
  }
  if (!parts || !/^\d{4}$/.test(parts[0]) || parts[0] === '0000' || parts.slice(1).some(part => !/^\d{1,2}$/.test(part))) return null;
  const iso = parts.map(part => part.padStart(2, '0')).join('-');
  const parsed = new Date(iso + 'T00:00:00Z');
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function needsReview(score) {
  return !Number.isFinite(score) || score < REVIEW_THRESHOLD || score > 1;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function recognizedImage(payload) {
  const images = asArray(payload?.images);
  if (images.length !== 1 || images[0]?.inferResult !== 'SUCCESS') throw new MediaError('MEDIA_UNREADABLE');
  return images[0];
}

function receiptSuggestion(requestId, merchant, date, totalWon, items) {
  if (!merchant && !date && !totalWon && !items.length) throw new MediaError('MEDIA_UNREADABLE');
  return { requestId, merchant, date, totalWon, items };
}

function documentField(source, parse) {
  const formatted = source?.formatted;
  const value = parse(formatted?.value) ?? parse(formatted) ?? parse(source?.text);
  return value === null ? null : { value, needsReview: needsReview(source?.confidenceScore) };
}

export function documentReceiptResult(payload, requestId) {
  const result = recognizedImage(payload).receipt?.result;
  if (!result) throw new MediaError('MEDIA_UNREADABLE');

  const merchant = documentField(result.storeInfo?.name, text);
  const recognizedDate = documentField(result.paymentInfo?.date, date);
  const totalWon = documentField(result.totalPrice?.price, value => {
    const amount = won(value);
    return amount > 0 ? amount : null;
  });
  const items = asArray(result.subResults).flatMap(group => asArray(group?.items)).map(item => ({
    name: documentField(item?.name, text),
    quantity: documentField(item?.count, quantity),
    amountWon: documentField(item?.price?.price, won),
  })).filter(item => item.name || item.quantity || item.amountWon);
  return receiptSuggestion(requestId, merchant, recognizedDate, totalWon, items);
}

const DATE = /(?<![\d-])(\d{4}|\d{2})\s*(?:[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})(?![\d-])|년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일)/d;
const TRANSACTION_DATE = /(?:거래|구매|판매|결제|승인)\s*(?:일자|일시|일|시간)|^일자/;
const MERCHANT_LABEL = /^(?:상\s*호(?:\s*명)?|가맹점(?:\s*명)?|매장명|판매처|거래처|공급자)(?:\s*:\s*|\s+)(.+?)(?=\s+(?:(?:대표(?:자)?|전화(?:번호)?|TEL|주소)(?=\s|:)|사업자\s*(?:등록\s*)?번호)|$)/di;
const ITEM_HEADER = /^(?:품\s*목(?:\s*명)?|상\s*품\s*명|메뉴명|제품명|품\s*명|적\s*요)(?:\s|$)/;
const RECEIPT_HEADING = /^\[?\s*(?:(?:거래|납품)\s*명세서|(?:간이|구매|현금)?\s*영\s*수\s*증|(?:신용\s*)?카드\s*(?:매출)?\s*전표|공급자용|공급받는자|이용해|감사합니다)/;
const RECEIPT_IDENTIFIERS = /^(?:대표(?:자|전화|\s|:)|사업자|등록\s*번호|(?:가맹점|전표|거래|회원|포스)\s*번호|전화|연락처|주소|TEL\b|FAX\b|카드\s*(?:번호|사|종류)|승인\s*(?:번호|코드)|할부|일시불|계산원|POS\b|유효\s*기간)/i;
const RECEIPT_SUMMARY = /^(?:공급\s*가액|과세|면세|부가\s*세|세액|소계|할인|받은\s*금액|거스름돈|현금\s*(?:받|결제)|포인트\s*(?:적립|사용|잔액))/;
const PRIVATE_NUMBER = /(?:^|\s)(?:\d{2,3}\s*-\s*\d{2,4}\s*-\s*\d{4}|\d{3}\s*-\s*\d{2}\s*-\s*\d{5}|(?:[\d*]{4}[- ]?){3}[\d*]{4})(?!\d)/;
const STREET_ADDRESS = /(?:^|\s)[가-힣\d·.]+(?:대로|로|길)\s+\d+(?:-\d+)?(?:\s+(?:\([^)]+\)|\d+(?:층|호)).*)?$|(?:^|\s)[가-힣\d·.]+(?:동|읍|면|리)\s+\d+(?:-\d+|\s*번지)(?=\s|$)/;
const REGION_ADDRESS = /^(?:[가-힣]+시|[가-힣]+도)\s+[가-힣]+(?:시|군|구)(?:\s|$)/;
const PRICE = '₩?\\s*(?:-\\s*)?(?:\\d{1,3}(?:\\s*,\\s*\\d{3})+|\\d+)\\s*원?';
const TRAILING_PRICE = new RegExp('(?<!\\S)(' + PRICE + ')$', 'd');
const TOTAL_AMOUNT = new RegExp('^\\s*:?\\s*(' + PRICE + ')$', 'd');
const TOTAL_LABELS = [
  /^(?:최종\s*)?(?:총\s*)?결제\s*금액/,
  /^(?:카드\s*(?:결제|승인)|승인)\s*금액/,
  /^받을\s*금액/,
  /^총\s*액/,
  /^(?:총\s*)?합\s*계(?:\s*금액)?/,
];
const TRAILING_QUANTITY = /(?:^|\s)(?:[x×]\s*)?(\d{1,3}(?:\.\d+)?)\s*(?:개|병|팩|봉|박스|x|×)?$/di;

function verticalBounds(field) {
  const vertices = asArray(field?.boundingPoly?.vertices);
  if (vertices.length < 2 || vertices.some(vertex => !Number.isFinite(vertex?.y))) return null;
  const top = Math.min(...vertices.map(vertex => vertex.y));
  const bottom = Math.max(...vertices.map(vertex => vertex.y));
  return { center: (top + bottom) / 2, height: bottom - top };
}

function receiptLines(fields) {
  const lines = [];
  let line = { text: '', spans: [] };
  let previousBounds = null;
  let previousBreak;
  for (const field of asArray(fields)) {
    const token = text(field?.inferText)?.normalize('NFKC').replace(/\s+/g, ' ');
    if (!token) continue;
    const bounds = verticalBounds(field);
    // Use the provider's reading order and line breaks when present.
    const movedVertically = previousBounds && bounds &&
      Math.abs(previousBounds.center - bounds.center) > Math.max(previousBounds.height, bounds.height) / 2;
    if (previousBreak === true || (previousBreak === undefined && movedVertically)) {
      lines.push(line);
      line = { text: '', spans: [] };
    }
    const start = line.text.length ? line.text.length + 1 : 0;
    line.text += line.text.length ? ' ' + token : token;
    line.spans.push({ start, end: line.text.length, review: needsReview(field.inferConfidence) });
    previousBounds = bounds;
    previousBreak = field.lineBreak;
  }
  if (line.text) lines.push(line);
  return lines;
}

function generalField(line, [start, end], value) {
  return {
    value,
    needsReview: line.spans.some(span => span.review && span.start < end && span.end > start),
  };
}

function receiptDate(lines) {
  let firstDate = null;
  for (const line of lines) {
    if (RECEIPT_IDENTIFIERS.test(line.text) && !TRANSACTION_DATE.test(line.text)) continue;
    const match = DATE.exec(line.text);
    if (!match) continue;
    const [, year, month, day, koreanMonth, koreanDay] = match;
    const value = date({ year: year.length === 2 ? '20' + year : year, month: month ?? koreanMonth, day: day ?? koreanDay });
    if (!value) continue;
    const result = generalField(line, match.indices[0], value);
    if (TRANSACTION_DATE.test(line.text)) return result;
    firstDate ??= result;
  }
  return firstDate;
}

function generalWon(value) {
  return won(value.replace(/\s*,\s*/g, ',').replace(/-\s+/g, '-'));
}

function paymentTotal(lines) {
  let total = null;
  let priority = TOTAL_LABELS.length;
  for (const [index, line] of lines.entries()) {
    const rank = TOTAL_LABELS.findIndex(label => label.test(line.text));
    if (rank < 0 || rank > priority) continue;
    const label = TOTAL_LABELS[rank].exec(line.text)[0];
    const remainder = line.text.slice(label.length);
    const amountOnNextLine = /^\s*:?\s*$/.test(remainder);
    const amountLine = amountOnNextLine ? lines[index + 1] : line;
    if (!amountLine) continue;
    const amount = TOTAL_AMOUNT.exec(amountOnNextLine ? amountLine.text : remainder);
    if (!amount) continue;
    const value = generalWon(amount[1]);
    if (value > 0) {
      total = amountOnNextLine ? generalField(amountLine, amount.indices[1], value) : generalField(line, [0, line.text.length], value);
      if (amountOnNextLine) total.needsReview ||= generalField(line, [0, label.length], value).needsReview;
      priority = rank;
    }
  }
  return total;
}

function isMetadata(value) {
  return RECEIPT_HEADING.test(value) || RECEIPT_IDENTIFIERS.test(value) || RECEIPT_SUMMARY.test(value)
    || PRIVATE_NUMBER.test(value) || STREET_ADDRESS.test(value) || REGION_ADDRESS.test(value)
    || DATE.test(value) || TRANSACTION_DATE.test(value);
}

function merchantName(lines) {
  let firstTitle = null;
  for (const line of lines.slice(0, 12)) {
    if (ITEM_HEADER.test(line.text) || TOTAL_LABELS.some(label => label.test(line.text))) break;
    const labelled = MERCHANT_LABEL.exec(line.text);
    if (labelled && /\p{L}/u.test(labelled[1]) && !isMetadata(labelled[1])) {
      return generalField(line, labelled.indices[1], labelled[1].trim());
    }
    if (!firstTitle && /\p{L}/u.test(line.text) && !isMetadata(line.text) && !TRAILING_PRICE.test(line.text)) {
      firstTitle = generalField(line, [0, line.text.length], line.text);
    }
  }
  return firstTitle;
}

function itemLine(line, quantityFirst) {
  if (ITEM_HEADER.test(line.text) || MERCHANT_LABEL.test(line.text) || isMetadata(line.text)
    || TOTAL_LABELS.some(label => label.test(line.text))) return null;
  const amount = TRAILING_PRICE.exec(line.text);
  if (!amount) return null;
  const value = generalWon(amount[1]);
  if (value === null) return null;

  const prefix = line.text.slice(0, amount.index).trim();
  const lastCount = TRAILING_QUANTITY.exec(prefix);
  const lastPrice = TRAILING_PRICE.exec(prefix);
  const firstCount = lastPrice && TRAILING_QUANTITY.exec(prefix.slice(0, lastPrice.index).trim());
  // Receipts commonly print either quantity–unit price or unit price–quantity.
  const lastPriceIsUnit = firstCount && (quantityFirst || !lastCount);
  const count = lastPriceIsUnit ? firstCount : lastCount;
  const unitPrice = lastPriceIsUnit ? lastPrice : count && TRAILING_PRICE.exec(prefix.slice(0, count.index).trim());
  const qty = count ? quantity(count[1]) : null;
  const name = qty === null ? prefix : prefix.slice(0, Math.min(count.index, unitPrice?.index ?? count.index)).trim();
  if (!/\p{L}/u.test(name)) return null;
  const recognizedQuantity = qty === null ? null : generalField(line, count.indices[0], qty);
  if (recognizedQuantity && quantityFirst === undefined && firstCount && lastCount && firstCount[1] !== lastCount[1]) {
    recognizedQuantity.needsReview = true;
  }
  return {
    name: generalField(line, [0, name.length], name),
    quantity: recognizedQuantity,
    amountWon: generalField(line, amount.indices[1], value),
  };
}

export function generalReceiptResult(payload, requestId) {
  const lines = receiptLines(recognizedImage(payload).fields);
  const headerIndex = lines.findIndex(line => ITEM_HEADER.test(line.text));
  const header = lines[headerIndex]?.text ?? '';
  const quantityColumn = header.search(/수\s*량/);
  const unitColumn = header.search(/단\s*가/);
  const quantityFirst = quantityColumn >= 0 && unitColumn >= 0 ? quantityColumn < unitColumn : undefined;
  const items = lines.slice(headerIndex + 1).map(line => itemLine(line, quantityFirst)).filter(Boolean);
  return receiptSuggestion(requestId, merchantName(lines), receiptDate(lines), paymentTotal(lines), items);
}
