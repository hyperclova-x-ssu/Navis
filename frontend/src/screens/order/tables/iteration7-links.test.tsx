import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UiProvider } from '../../../ui';
import { screenPresets } from '../../../layout/presets';
const fixture=vi.hoisted(()=>({table:{tableId:'T1',number:1,seats:2,state:'empty',total:0,elapsed:0,orderCount:0,billIds:[]},read:{scenario:'normal',pos:{bills:[],tableSessions:[]}}}));
vi.mock('../../../pos/react',()=>({usePosSnapshot:()=>fixture.read}));
vi.mock('../../../pos/tables',async orig=>({...await orig<typeof import('../../../pos/tables')>(),selectTableMap:()=>({layout:{tables:[{tableId:'T1',number:1,seats:2,column:0,row:0}]},tables:[fixture.table]})}));
import { TableMap } from './TableMap';
afterEach(cleanup);
it('shows a reciprocal clearing warning and removes it when CCTV reports empty',()=>{
 const link={zoneId:'z1',tableId:'T1',occupancyState:'cups_left' as const,occupancyObservedAt:'2026-10-26T15:45',linkedOrderStatus:'empty' as const,needsClearingBadge:true};
 const wrap=(linkedTables:readonly typeof link[])=><UiProvider screenPreset={screenPresets.A} reducedMotion><TableMap onPick={()=>{}} linkedTables={linkedTables}/></UiProvider>;
 const {rerender}=render(wrap([link]));
 expect(screen.getByRole('button',{name:/T1,.*치울 테이블/})).toBeInTheDocument();
 rerender(wrap([{...link,occupancyState:'empty' as never,needsClearingBadge:false}]));
 expect(screen.queryByText('치울 테이블')).not.toBeInTheDocument();
 expect(screen.getByText('빈 자리')).toBeInTheDocument();
 rerender(wrap([]));expect(screen.queryByText('빈 자리')).not.toBeInTheDocument();
});
it('shows both the cup observation and the clearing warning while cups remain',()=>{
 const link={zoneId:'z1',tableId:'T1',occupancyState:'cups_left' as const,occupancyObservedAt:null,linkedOrderStatus:'empty' as const,needsClearingBadge:true};
 render(<UiProvider screenPreset={screenPresets.A} reducedMotion><TableMap onPick={()=>{}} linkedTables={[link]}/></UiProvider>);
 expect(screen.getByText('치울 컵')).toBeInTheDocument();
 expect(screen.getByText('치울 테이블')).toBeInTheDocument();
});
