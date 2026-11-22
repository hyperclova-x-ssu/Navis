import { createHash } from 'node:crypto';

/** One ledger line of the accountant export. Every row carries one signed figure in `amount`. */
export type ExportRow = {
  kind: 'sales' | 'deposit' | 'expense' | 'tax-payment';
  date: string; item: string; detail: string; amount: number; evidence: string;
  evidenceFiles: number | null; paidOn: string | null; memo: string; sourceId: string;
};
export type SummaryRow = readonly [label: string, value: string | number];

export const exportHeader = ['구분', '날짜', '항목', '세부', '금액(원)', '증빙', '증빙 파일 수', '납부일', '메모', '원천 ID'] as const;
export const kindLabels: Record<ExportRow['kind'], string> = { sales: '매출', deposit: '입금', expense: '지출', 'tax-payment': '세금 납부' };

function cells(row: ExportRow): (string | number | null)[] {
  return [kindLabels[row.kind], row.date, row.item, row.detail, row.amount, row.evidence, row.evidenceFiles, row.paidOn, row.memo, row.sourceId];
}

/** Owner text is neutralized so a spreadsheet never evaluates it as a formula. */
function csvText(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function csvCell(value: string | number | null) {
  if (value === null) return '';
  return typeof value === 'number' ? String(value) : csvText(value);
}

/** UTF-8 with BOM and CRLF (RFC 4180) so Korean text opens correctly in Excel. */
export function encodeCsv(rows: readonly ExportRow[]) {
  const lines = [exportHeader.map(csvText).join(','), ...rows.map(row => cells(row).map(csvCell).join(','))];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]);
}

// eslint-disable-next-line no-control-regex -- Strip characters forbidden by XML 1.0.
const xmlInvalid = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
function xml(value: string) {
  return value.replace(xmlInvalid, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function column(index: number) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function sheetXml(rows: readonly (readonly (string | number | null)[])[], moneyColumns: readonly number[]) {
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const ref = `${column(c)}${r + 1}`;
    if (value === null || value === '') return '';
    if (typeof value === 'number') return `<c r="${ref}"${r > 0 && moneyColumns.includes(c) ? ' s="1"' : ''}><v>${value}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Deterministic ZIP with stored (uncompressed) entries and UTF-8 names. */
export function zip(entries: readonly { name: string; data: Buffer }[], at: Date) {
  const time = (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2);
  const date = ((Math.max(at.getUTCFullYear(), 1980) - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate();
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Two sheets: `장부` (the same rows and columns as the CSV) and `요약` (the verified preview totals). */
export function encodeXlsx(rows: readonly ExportRow[], summary: readonly SummaryRow[], at: Date) {
  const ledger = sheetXml([[...exportHeader], ...rows.map(cells)], [4]);
  const totals = sheetXml([['항목', '값'], ...summary.map(([label, value]) => [label, value])], [1]);
  const part = (text: string) => Buffer.from(text, 'utf8');
  return zip([
    { name: '[Content_Types].xml', data: part(`${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: part(`${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: part(`${header}<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="장부" sheetId="1" r:id="rId1"/><sheet name="요약" sheetId="2" r:id="rId2"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: part(`${header}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: part(`${header}<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`) },
    { name: 'xl/worksheets/sheet1.xml', data: part(ledger) },
    { name: 'xl/worksheets/sheet2.xml', data: part(totals) },
  ], at);
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
