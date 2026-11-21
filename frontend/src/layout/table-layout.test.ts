import { describe, expect, it } from 'vitest';
import { createTableLayout, moveTable, resizeTableCount, setTableSeats, validateTableLayout } from './table-layout';

describe('독립 9×6 테이블 배치', () => {
  it('기본 18석과 추가 우선 위치를 유지하고 큰 번호부터 줄인다', () => {
    const original = createTableLayout();
    expect(original.tables.map(t => [t.number, t.seats, t.column, t.row])).toEqual([
      [1,2,1,1], [2,2,4,1], [3,2,7,1], [4,4,1,3], [5,4,4,3], [6,4,7,3],
    ]);
    const nine = resizeTableCount(original, 9)!;
    expect(nine.tables.slice(6).map(t => [t.number,t.seats,t.column,t.row])).toEqual([[7,2,1,5],[8,2,4,5],[9,2,7,5]]);
    const twenty = resizeTableCount(nine, 20)!;
    expect(validateTableLayout(twenty)).toBe(true);
    expect(twenty.tables[9]).toMatchObject({number:10,column:0,row:0});
    expect(resizeTableCount(twenty, 2)!.tables.map(t => t.number)).toEqual([1,2]);
    expect(original.tables).toHaveLength(6);
  });

  it('불가능한 이동과 수량·좌석·식별자·격자 오류를 거절한다', () => {
    const layout = createTableLayout();
    expect(moveTable(layout, 'T1', 4, 1)).toBeNull();
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
    expect(moveTable(layout, 'T1', 0, 0)!.tables[0]).toMatchObject({column:0,row:0,seats:2});
    const changed = setTableSeats(resizeTableCount(layout, 8)!, null, 4)!;
    expect(setTableSeats(changed, 'T3', 2)!.tables.reduce((sum,t) => sum+t.seats,0)).toBe(30);
    expect(layout.tables[0]).toMatchObject({column:1,row:1,seats:2});
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
