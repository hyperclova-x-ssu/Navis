import { describe, expect, it } from 'vitest';
import type { SessionGate, TableLayout } from '../contracts';
import { getRegistry } from '../catalog';
import { createTableLayout, moveTable, resizeTableCount, setTableSeats } from '../layout/table-layout';
import { screenPresets } from '../layout/presets';
import { testTime } from '../layout/test-policy';
import { createRunStore } from './index';

const options = { screenPreset: screenPresets.A, catalog: getRegistry('A'), time: testTime, clock: () => 0, theme: 'light' as const };
const setup = (sessionGate?: SessionGate) => {
  const run = createRunStore({ ...options, sessionGate });
  run.actions.chooseBusiness('cafe');
  run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
  return run;
};
const identity = (run: ReturnType<typeof createRunStore>) => {
  const { runId, transitionToken } = run.getState();
  return { runId, transitionToken };
};

describe('온보딩 테이블 초안 포트', () => {
  it('이동, 좌석 및 테이블 수 변경을 단계 전환 없이 즉시 반영하고 이전 이동 후 복원한다', () => {
    const run = setup(), token = identity(run), before = run.getState();
    let layout = moveTable(before.onboarding.draft.tableLayout!, 'T1', 0, 0)!;
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(true);
    layout = setTableSeats(run.getState().onboarding.draft.tableLayout!, 'T1', 12)!;
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(true);
    layout = resizeTableCount(run.getState().onboarding.draft.tableLayout!, 20)!;
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(true);
    layout = resizeTableCount(run.getState().onboarding.draft.tableLayout!, 1)!;
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(true);
    const edited = run.getState();
    expect(edited.onboarding.step).toBe('tables');
    expect(edited.transitionToken).toBe(token.transitionToken);
    expect(edited.runRevision).toBe(before.runRevision + 4);
    expect(edited.shopSettings).toBe(before.shopSettings);
    expect(edited.onboarding.draft.tableLayout!.tables).toEqual([{ tableId: 'T1', number: 1, seats: 12, column: 0, row: 0 }]);
    run.actions.onboardingBack();
    run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
    expect(run.getState().onboarding.draft.tableLayout).toEqual(edited.onboarding.draft.tableLayout);
    expect(run.actions.saveOnboardingTables(run.getState().onboarding.draft.tableLayout!)).toBe(true);
    expect(run.actions.onboardingBack()).toBe(true);
    expect(run.getState().onboarding.draft.tableLayout).toEqual(edited.onboarding.draft.tableLayout);
  });

  it('범위, 중복 좌표와 잘못된 배치를 거절하고 상태와 통지를 바꾸지 않는다', () => {
    const run = setup(), token = identity(run), before = run.getState(), layout = before.onboarding.draft.tableLayout!;
    let notifications = 0; run.subscribe(() => notifications++);
    const variants: TableLayout[] = [
      { ...layout, tables: [] },
      { ...layout, tables: Array.from({ length: 21 }, (_, i) => ({ tableId: `X${i}`, number: i + 1, seats: 2, column: i % 9, row: Math.floor(i / 9) })) },
      ...[0, 13, 1.5].map(seats => ({ ...layout, tables: [{ ...layout.tables[0], seats }] })),
      { ...layout, tables: [{ ...layout.tables[0], column: 9 }] },
      { ...layout, tables: [{ ...layout.tables[0], row: -1 }] },
      { ...layout, tables: [layout.tables[0], { ...layout.tables[1], column: layout.tables[0].column, row: layout.tables[0].row }] },
      { ...layout, tables: [layout.tables[0], { ...layout.tables[1], tableId: layout.tables[0].tableId }] },
      { ...layout, tables: [layout.tables[0], { ...layout.tables[1], number: layout.tables[0].number }] },
    ];
    for (const invalid of variants) expect(run.actions.updateOnboardingTableDraft(invalid, token)).toBe(false);
    expect(run.getState()).toBe(before);
    expect(notifications).toBe(0);
  });

  it('오래된 실행과 전환 토큰, 다른 단계와 트랜잭션 중 편집을 거절한다', () => {
    const gate: { phase: SessionGate['phase']; transactionId: string | null } = { phase: 'idle', transactionId: null };
    const run = setup(gate), token = identity(run), layout = createTableLayout();
    const before = run.getState();
    expect(run.actions.updateOnboardingTableDraft(layout, { ...token, runId: 'old-run' })).toBe(false);
    expect(run.actions.updateOnboardingTableDraft(layout, { ...token, transitionToken: 'old-token' })).toBe(false);
    gate.phase = 'flushing';
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(false);
    gate.phase = 'idle';
    expect(run.getState()).toBe(before);
    run.actions.onboardingBack();
    const payment = run.getState();
    expect(run.actions.updateOnboardingTableDraft(layout, identity(run))).toBe(false);
    expect(run.getState()).toBe(payment);
    run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
    const again = run.getState();
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(false);
    expect(run.getState()).toBe(again);
    run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' });
    const fresh = run.getState();
    expect(run.actions.updateOnboardingTableDraft(layout, token)).toBe(false);
    expect(run.getState()).toBe(fresh);
    run.actions.chooseBusiness('cafe');
    run.actions.setOnboardingAnswer({ paymentStyle: 'postpaid' });
    const newTables = run.getState();
    expect(run.actions.updateOnboardingTableDraft(layout, { runId: token.runId, transitionToken: newTables.transitionToken })).toBe(false);
    expect(run.getState()).toBe(newTables);
  });

  it('입력 객체를 복사하고 다시 불러온 새 실행은 초안을 초기화한다', () => {
    const run = setup(), token = identity(run), original = createTableLayout();
    const mutable = { ...original, tables: original.tables.map(table => ({ ...table })) };
    mutable.tables[0].seats = 8;
    expect(run.actions.updateOnboardingTableDraft(mutable, token)).toBe(true);
    mutable.tables[0].seats = 1;
    expect(run.getState().onboarding.draft.tableLayout!.tables[0].seats).toBe(8);
    const reloaded = createRunStore(options);
    expect(reloaded.getState().onboarding).toMatchObject({ step: 'business', draft: { businessType: null, paymentStyle: null, tableLayout: null } });
  });
});
