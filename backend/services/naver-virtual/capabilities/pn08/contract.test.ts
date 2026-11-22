import { expect, it, vi } from 'vitest';
import { deliverAiCallFixture } from './fixture.ts';

it('delivers documented V2 strings and keeps a fixture answer pending owner review', async () => {
  const callback = vi.fn<(_target: string, _init: RequestInit) => Promise<Response>>(
    async () => Response.json({ valid: 'reservationFailed' }),
  );
  const received = await deliverAiCallFixture(callback, new Date('2026-11-17T06:45:00Z'), 'fixture-callback');
  expect(received).toEqual({ valid: 'reservationFailed' });
  const [[target, init]] = callback.mock.calls;
  expect(target).toBe('aicall');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-callback');
  expect(JSON.parse(String(init.body))).toEqual({
    userId: 'persona-aicall-2026-11-18',
    userKey: 'persona-aicall-cafe',
    userVariables: {
      예약날짜_completed: { value: '{"year":2026,"month":11,"day":18,"name":"내일"}', typ: 'JSON' },
      예약시간_completed: { value: '{"hour":13,"minute":30}', typ: 'JSON' },
      예약인원_completed: { value: '2', typ: 'NUMBER' },
      전화번호_completed: { value: '01000004200', typ: 'TEXT' },
    },
  });
});

it('fails closed if a callback claims the review-only fixture completed a reservation', async () => {
  await expect(deliverAiCallFixture(async () => Response.json({ valid: 'reservationCompleted' }),
    new Date('2026-11-17T06:45:00Z'), 'fixture-callback')).rejects.toThrow();
  await expect(deliverAiCallFixture(async () => Response.json({ valid: true }),
    new Date('2026-11-17T06:45:00Z'), 'fixture-callback')).rejects.toThrow();
});
