import './test-setup';
import '@testing-library/jest-dom/vitest';
import { afterEach,expect,it } from 'vitest';
import { cleanup,render,screen } from '@testing-library/react';
import { UiProvider,FunctionDrawer,FunctionRow,DataList } from './index';
import { screenPresets } from '../layout/presets';
import { drawerContentHeight,drawerRowHeight } from './drawer-layout';
afterEach(cleanup);
it('sizes natural rows from wrapping, placed state and text scale without filling the maximum height',()=>{
 expect(drawerRowHeight({titleLines:1,placed:false,textScale:100})).toBe(72);
 expect(drawerRowHeight({titleLines:2,placed:true,textScale:100})).toBe(96);
 expect(drawerRowHeight({titleLines:2,placed:true,textScale:125})).toBe(116);
 expect(drawerContentHeight({maxHeight:640,bodyHeight:72,hintHeight:56})).toBe(234);
 expect(drawerContentHeight({maxHeight:760,bodyHeight:5*88+4*8,hintHeight:70})).toBe(648);
});
it('preserves full row names and natural content while text size changes',()=>{
 const content=<FunctionDrawer open title="운영" onClose={()=>{}}><FunctionRow label="사진으로 자리 배치" icon="floor-plan" placed/></FunctionDrawer>;
 const view=render(<UiProvider screenPreset={screenPresets.A} textScale={100}>{content}</UiProvider>);
 const row=screen.getByRole('button',{name:/사진으로 자리 배치/});view.rerender(<UiProvider screenPreset={screenPresets.A} textScale={125}>{content}</UiProvider>);
 expect(screen.getByRole('button',{name:/사진으로 자리 배치/})).toBe(row);expect(row).toHaveTextContent('이미 있어요');
});
it('keeps compact list items and their complete text',()=>{
 render(<DataList compact items={[{id:'one',title:'오후부터 비 소식'},{id:'two',title:'이번 주 동네 행사'}]}/>);
 expect(screen.getAllByRole('listitem')).toHaveLength(2);expect(screen.getByText('이번 주 동네 행사')).toBeVisible();
});
