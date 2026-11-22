import { describe, expect, it } from 'vitest';
import { attestation, draftPatch, publicationCard } from './wire.ts';

describe('promo confirmation inputs', () => {
  it('accepts a partial draft and rejects duplicate photo IDs', () => {
    expect(draftPatch({ memo: '', photoIds: [] })).toEqual({ memo: '', photoIds: [] });
    expect(() => draftPatch({ photoIds: ['same', 'same'] })).toThrow('BAD_REQUEST');
  });

  it('requires a separate channel card and extra confirmation for attestation', () => {
    expect(() => publicationCard({ confirmed: true, text: 'hello' }, 'clip')).toThrow('BAD_REQUEST');
    expect(() => attestation({ confirmed: true, route: 'clip', link: 'https://clip.naver.com/a' })).toThrow('BAD_REQUEST');
    expect(attestation({ confirmed: true, extraConfirmed: true, route: 'clip', link: 'https://clip.naver.com/a' }).route).toBe('clip');
    expect(() => attestation({ confirmed: true, extraConfirmed: true, route: 'clip', link: 'https://clip.naver.com.evil.example/a' })).toThrow('BAD_REQUEST');
  });
});
