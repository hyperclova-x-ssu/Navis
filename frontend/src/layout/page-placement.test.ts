import { describe, expect, it } from 'vitest';
import type { Panel } from '../contracts';
import { nearestEmptyRect, screenPresets } from './index';

describe('nearest fully empty rectangle for sending a panel to a neighbor page (ARCHITECTURE 11.4-9)', () => {
  const grid = screenPresets.A.grid;
  it('keeps the original cell when it is empty', () => {
    expect(nearestEmptyRect([], grid, 2, 1, 3, 2)).toEqual({ column: 3, row: 2 });
  });
  it('chooses the smallest Manhattan distance, then row, then column', () => {
    const panels: readonly Panel[] = [{ featureId: 'ledger', column: 2, row: 1, width: 2, height: 2 }];
    // (2,1) is taken; distance-1 candidates: (1,1)? overlaps no -> (1,1) w2 overlaps column 2 -> taken; (2,0) row0 h2 overlaps row1 -> taken.
    expect(nearestEmptyRect(panels, grid, 1, 1, 2, 1)).toEqual({ column: 2, row: 0 });
    expect(nearestEmptyRect(panels, grid, 2, 2, 2, 1)).toEqual({ column: 0, row: 1 });
  });
  it('returns null when no empty rectangle of that size exists', () => {
    const full: readonly Panel[] = [{ featureId: 'ledger', column: 0, row: 0, width: 4, height: 4 }, { featureId: 'calendar', column: 4, row: 0, width: 2, height: 2 }];
    expect(nearestEmptyRect(full, grid, 2, 3, 0, 0)).toBeNull();
    expect(nearestEmptyRect(full, grid, 2, 2, 0, 0)).toEqual({ column: 4, row: 2 });
  });
});
