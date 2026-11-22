import { describe, expect, it } from 'vitest';
import { createTableLayout, moveTable, resizeTableCount, setTableSeats, validateTableLayout } from './table-layout';

describe('독립 9×6 테이블 배치', () => {
  it('기본 11개 30석(예약 시드 T1~T11과 같은 자리)을 두고, 추가 우선 위치를 유지하며, 큰 번호부터 줄인다', () => {
    const original = createTableLayout();
    expect(original.tables.map(t => [t.number, t.seats, t.column, t.row])).toEqual([
      [1,2,0,0], [2,2,1,0], [3,2,2,0], [4,2,3,0], [5,2,4,0], [6,2,5,0], [7,2,6,0],
      [8,2,0,2], [9,4,1,2], [10,4,2,2], [11,6,3,2],
    ]);
    expect(original.tables.reduce((sum, t) => sum + t.seats, 0)).toBe(30);
    const fourteen = resizeTableCount(original, 14)!;
    expect(fourteen.tables.slice(11).map(t => [t.number,t.seats,t.column,t.row])).toEqual([[12,2,1,5],[13,2,4,5],[14,2,7,5]]);
    const twenty = resizeTableCount(fourteen, 20)!;
    expect(validateTableLayout(twenty)).toBe(true);
    expect(twenty.tables[14]).toMatchObject({number:15,column:7,row:0});
    expect(resizeTableCount(twenty, 2)!.tables.map(t => t.number)).toEqual([1,2]);
    expect(resizeTableCount(original, 9)!.tables.map(t => t.number)).toEqual([1,2,3,4,5,6,7,8,9]);
    expect(original.tables).toHaveLength(11);
  });

  it('불가능한 이동과 수량·좌석·식별자·격자 오류를 거절한다', () => {
    const layout = createTableLayout();
    expect(moveTable(layout, 'T1', 1, 0)).toBeNull();
    expect(moveTable(layout, 'T1', 9, 0)).toBeNull();
    expect(moveTable(layout, 'T1', 0, 6)).toBeNull();
    expect(moveTable(layout, 'T1', 0.5, 0)).toBeNull();
    expect(moveTable(layout, 'missing', 0, 0)).toBeNull();
    expect(resizeTableCount(layout, 0)).toBeNull();
    expect(resizeTableCount(layout, 21)).toBeNull();
    expect(setTableSeats(layout, 'T1', 0)).toBeNull();
    expect(setTableSeats(layout, 'T1', 13)).toBeNull();
    expect(validateTableLayout({...layout, columns:8})).toBe(false);
    expect(validateTableLayout({...layout, tables:[]})).toBe(false);
    expect(validateTableLayout({...layout, tables:[layout.tables[0],layout.tables[0]]})).toBe(false);
    expect(validateTableLayout({...layout, tables:[layout.tables[0],{...layout.tables[1],tableId:'T1'}]})).toBe(false);
    expect(validateTableLayout({...layout, tables:[layout.tables[0],{...layout.tables[1],number:1}]})).toBe(false);
    expect(moveTable(layout, 'T1', 8, 5)!.tables[0]).toMatchObject({column:8,row:5,seats:2});
    const changed = setTableSeats(resizeTableCount(layout, 8)!, null, 4)!;
    expect(setTableSeats(changed, 'T3', 2)!.tables.reduce((sum,t) => sum+t.seats,0)).toBe(30);
    expect(layout.tables[0]).toMatchObject({column:0,row:0,seats:2});
  });

  it('이미 큰 번호를 사용한 유효 배치도 겹치지 않는 새 번호로 늘린다',()=>{
    const original=createTableLayout();
    const layout={...original,tables:[{...original.tables[0],tableId:'T20',number:20}]};
    expect(validateTableLayout(layout)).toBe(true);
    const added=resizeTableCount(layout,2)!;
    expect(validateTableLayout(added)).toBe(true);
    expect(added.tables[0]).toEqual(layout.tables[0]);
    expect(new Set(added.tables.map(t=>t.number)).size).toBe(2);
  });
});
