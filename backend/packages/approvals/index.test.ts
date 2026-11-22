import { describe, expect, it } from 'vitest';
import { approvalInput, approvalFingerprint, ApprovalError } from './index.ts';

describe('card approval wire', () => {
  const press = { stage: 'press', operation: 'works.delete', targetRef: 'shift', expectedRevision: 1, command: {} };
  it('only accepts an approval ID on confirmation', () => {
    expect(approvalInput(press)).toEqual(press);
    expect(() => approvalInput({ ...press, approvalId: 'supplied' })).toThrow(ApprovalError);
    expect(() => approvalInput({ ...press, stage: 'confirm' })).toThrow(ApprovalError);
    expect(() => approvalInput({ ...press, expectedRevision: -1 })).toThrow(ApprovalError);
  });
  it('canonically binds nested command fields and target', () => {
    expect(approvalFingerprint({ a: 1, b: { x: 2, y: 3 } })).toBe(approvalFingerprint({ b: { y: 3, x: 2 }, a: 1 }));
    expect(approvalFingerprint({ target: 'board-a' })).not.toBe(approvalFingerprint({ target: 'board-b' }));
  });
});
