import { describe, expect, it } from 'vitest';
import { formatMaskedCustomer, memberDisplayId } from './customer-display';

describe('D-430 customer display', () => {
  it.each(['손님 M-0008', '손○○○○○○○2', '○○ 손님', '1○○', '손님'])('shows %s consistently when the member number is known', name => {
    expect(formatMaskedCustomer(name, undefined, 'M-0008')).toBe('손○○ · M-0008');
  });

  it('keeps the real surname and recognizes an already masked name', () => {
    expect(formatMaskedCustomer('김민지', 'M-0015')).toBe('김○○ · M-0015');
    expect(formatMaskedCustomer('김○지', 'M-0015', undefined, '\n')).toBe('김○○\nM-0015');
  });

  it('reads the authoritative café member label and withholds unknown identifiers', () => {
    const uuid = '03ef694b-9876-4999-8623-d551b67dcb26';
    expect(memberDisplayId(uuid, undefined, '손님 M-0008')).toBe('M-0008');
    expect(formatMaskedCustomer('손님 M-0008', uuid)).toBe('손○○ · M-0008');
    expect(formatMaskedCustomer('예약자', uuid, 'M-03EF694B')).toBe('손○○');
    expect(formatMaskedCustomer('김', uuid)).toBe('손○○');
  });
});
