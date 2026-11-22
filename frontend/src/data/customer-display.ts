const memberCodePattern = /^M-\d{4,}$/i;
const cafeMemberLabel = /^손님 (M-\d{4,})$/i;
const unknownNames = new Set(['손님', '예약자', '고객', '회원', '예시 회원']);

/** The visible member number comes from a customer record. Technical IDs never become display codes. */
export function memberDisplayId(memberId?: string | null, code?: string | null, memberName?: string | null): string {
  const values = [code, memberId, cafeMemberLabel.exec(memberName?.trim() ?? '')?.[1]];
  return values.find((value): value is string => !!value && memberCodePattern.test(value))?.toUpperCase() ?? '';
}

/** Use the same masked name for a customer in lists, payments and details. */
export function formatMaskedCustomer(name?: string | null, memberId?: string | null, code?: string | null, separator = ' · '): string {
  const source = name?.trim().normalize('NFC') ?? '';
  const [initial, next] = Array.from(source);
  const surname = next && /^\p{L}$/u.test(initial) && !unknownNames.has(source) ? initial : '손';
  const number = memberDisplayId(memberId, code, source);
  return `${surname}○○${number ? separator + number : ''}`;
}
