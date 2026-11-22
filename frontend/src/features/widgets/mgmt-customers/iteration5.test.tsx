import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { createWidgetDataStore, selectMembers, selectMenus, selectReservations, TODAY } from '../../../data/widget-data';
import { MenuDetail } from '../mgmt-products/menu';
import { MembersDetail } from './members';
import { VoiceBookingDetail } from './voice-booking';
import { CustomerAnalysisDetail, CustomerAnalysisPanel } from './customer-analysis';
const makeHost = () => ({ layer:'management' as const, resetPreview:vi.fn(), openLinked:vi.fn(), openDetail:vi.fn(), notify:vi.fn(), acknowledgeBriefing:vi.fn(), openClosing:vi.fn(()=>true) });
const condition = {kind:'default' as const};
afterEach(cleanup);
it('adds and deletes recipe rows, changes price and archives with undo', async () => {
 const store=createWidgetDataStore(),host=makeHost();renderWithKit(<MenuDetail featureId="menu" condition={condition} detailRef={{featureId:'menu'}} host={host}/>,{store,reducedMotion:true});
 const americano=()=>selectMenus(store.getSnapshot(),{}).rows.find(r=>r.menuId==='m-americano')!;
 await userEvent.click(screen.getByRole('gridcell',{name:/^아메리카노, 원가,/}));const side=screen.getByRole('region',{name:'아메리카노'});
 await userEvent.click(within(side).getByRole('button',{name:'재료 추가하기'}));
 // the café stock (D-313): the first ingredient the recipe does not use yet is read from the list the panel offers
 const choice=within(side).getByLabelText('재료 선택'),offered=within(choice).getAllByRole('option')[0] as HTMLOptionElement,itemId=offered.value,itemName=offered.textContent!;
 await userEvent.selectOptions(choice,itemId);await userEvent.click(within(side).getByRole('button',{name:'재료 넣기'}));
 expect(americano().recipeLines.some(l=>l.itemId===itemId)).toBe(true);
 await userEvent.click(within(side).getByRole('button',{name:`${itemName} 지우기`}));expect(americano().recipeLines.some(l=>l.itemId===itemId)).toBe(false);
 const priceForm=within(side).getByRole('form',{name:'판매가'});const price=within(priceForm).getByLabelText('판매가');fireEvent.change(price,{target:{value:'4700'}});await userEvent.click(within(priceForm).getByRole('button',{name:'판매가 저장하기'}));expect(americano().price).toBe(4700);
 await userEvent.click(within(side).getByRole('button',{name:'메뉴 지우기'}));await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'지우기'}));act(()=>{store.undo(host.notify.mock.calls.at(-1)![0].undoToken!);});expect(selectMenus(store.getSnapshot(),{}).rows.find(r=>r.menuId==='m-americano')!.price).toBe(4700);
});
it('creates a menu and opens its missing-cost side panel',async()=>{
 const store=createWidgetDataStore(),menusBefore=selectMenus(store.getSnapshot(),{}).rows.length;renderWithKit(<MenuDetail featureId="menu" condition={condition} detailRef={{featureId:'menu',view:'register'}} host={makeHost()}/>,{store});await userEvent.type(screen.getByLabelText('메뉴 이름'),'새 메뉴');await userEvent.type(screen.getByLabelText('판매가'),'6000');await userEvent.click(screen.getByRole('button',{name:'메뉴 저장하기'}));expect(screen.getByRole('region',{name:'새 메뉴'})).toHaveTextContent('원가 미등록');expect(selectMenus(store.getSnapshot(),{}).rows).toHaveLength(menusBefore+1);
});
it('validates member information before saving an edited phone number',async()=>{
 const store=createWidgetDataStore(),host=makeHost();renderWithKit(<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members',itemId:'M-0001'}} host={host}/>,{store});const side=screen.getByRole('region');
 const phone=within(side).getByLabelText('연락처');await userEvent.clear(phone);await userEvent.type(phone,'010-1234-5678');const before=store.getSnapshot();await userEvent.click(within(side).getByRole('button',{name:'기본 정보 저장하기'}));expect(store.getSnapshot()).toBe(before);expect(within(side).getByRole('alert')).toBeInTheDocument();
 await userEvent.clear(phone);await userEvent.type(phone,'01012345678');await userEvent.click(within(side).getByRole('button',{name:'기본 정보 저장하기'}));expect(selectMembers(store.getSnapshot(),{query:'5678'}).rows.some(r=>r.memberId==='M-0001')).toBe(true);
});
it('updates and deletes member notes while preserving the existing note',async()=>{
 // The café sample has no seeded member note, so the note to preserve is added first (same member, through the same command the panel uses).
 const store=createWidgetDataStore(),host=makeHost(),memberId='M-0001';store.dispatch({type:'members.addNote',memberId,body:'단체 예약 자주 해요'});
 const keep=selectMembers(store.getSnapshot(),{}).rows.find(r=>r.memberId===memberId)!.notes;expect(keep).toHaveLength(1);
 renderWithKit(<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members',itemId:memberId}} host={host}/>,{store});const side=screen.getByRole('region');
 await userEvent.type(within(side).getByLabelText('메모 추가하기'),'단체 문의');await userEvent.click(within(side).getByRole('button',{name:'메모 저장하기'}));await userEvent.click(within(side).getByRole('button',{name:'단체 문의 고치기'}));await userEvent.clear(within(side).getByRole('textbox',{name:'메모 고치기'}));await userEvent.type(within(side).getByRole('textbox',{name:'메모 고치기'}),'예약 문의');await userEvent.click(within(within(side).getByRole('form',{name:'메모 고치기'})).getByRole('button',{name:'메모 저장하기'}));await userEvent.click(within(side).getByRole('button',{name:'예약 문의 지우기'}));expect(selectMembers(store.getSnapshot(),{}).rows.find(r=>r.memberId===memberId)!.notes).toEqual(keep);
});
it('links the selected member to coupons and filters all four grades',async()=>{
 const store=createWidgetDataStore(),host=makeHost();renderWithKit(<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members',itemId:'M-0001'}} host={host}/>,{store});const side=screen.getByRole('region');
 await userEvent.click(within(side).getByRole('button',{name:'쿠폰 보내기'}));expect(host.openLinked).toHaveBeenCalledWith(expect.objectContaining({featureId:'customer-groups',focus:'action'}));await userEvent.click(within(side).getByRole('button',{name:'닫기'}));await userEvent.click(screen.getByRole('radio',{name:'오랜 기간 미방문'}));expect(screen.getByRole('grid',{name:'회원목록'}).querySelectorAll('tbody > tr')).toHaveLength(selectMembers(store.getSnapshot(),{grade:'inactive'}).rows.length);
});
it('keeps frequent and occasional visit chips neutral with an icon', () => {
 renderWithKit(<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members'}} host={makeHost()}/>);
 const grid = within(screen.getByRole('grid', { name: '회원목록' }));
 for (const label of ['자주 방문', '가끔 방문']) {
  const chip = grid.getAllByText(label)[0]!.closest('.ui-status-chip')!;
  expect(chip).toHaveAttribute('data-tone', 'neutral');
  expect(chip.querySelector('svg')).toBeNull();
  expect(chip.querySelector('[aria-hidden="true"]')).toHaveTextContent('●');
 }
});
it('restores focus on close and removes a filtered-out side panel',async()=>{
 renderWithKit(<MenuDetail featureId="menu" condition={condition} detailRef={{featureId:'menu'}} host={makeHost()}/>,{reducedMotion:true});await userEvent.click(screen.getByRole('gridcell',{name:/^아메리카노, 원가,/}));await userEvent.click(within(screen.getByRole('region',{name:'아메리카노'})).getByRole('button',{name:'닫기'}));expect(screen.getByRole('gridcell',{name:'아메리카노, 메뉴 이름, 아메리카노'})).toHaveFocus();await userEvent.click(screen.getByRole('gridcell',{name:/^아메리카노, 원가,/}));await userEvent.type(screen.getByRole('searchbox'),'없음');expect(screen.queryByRole('region',{name:'아메리카노'})).not.toBeInTheDocument();expect(document.activeElement).not.toBe(document.body);
});
it('edits reservations in a DataGrid, warns on capacity, confirms and cancels with undo',async()=>{
 const store = createWidgetDataStore(), host = makeHost();
 const today = selectReservations(store.getSnapshot(), { date: TODAY }), target = today.rows.find(r => r.status === 'confirmed')!, name = (target.name as { raw: string }).raw;
 renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={condition} detailRef={{featureId:'voice-booking'}} host={host}/>, { store });
 const grid = within(screen.getByRole('grid', { name: '예약 목록' }));
 await userEvent.click(grid.getByRole('gridcell', { name: new RegExp(`${name}.*예약 인원`) }));
 const panel = within(screen.getByRole('region', { name: `${target.time} · ${name}` }));
 const party = panel.getByLabelText('인원');
 await userEvent.clear(party);
 await userEvent.type(party, String(today.totalSeats + 10));
 await userEvent.click(panel.getByRole('button', { name: '예약 저장하기' }));
 expect(selectReservations(store.getSnapshot(), { date: TODAY }).rows.find(r => r.reservationId === target.reservationId)!.status).toBe('needs-check');
 expect(panel.getByText(`좌석 ${today.totalSeats}석을 넘어요`)).toBeVisible();
 await userEvent.click(panel.getByRole('button', { name: new RegExp(`${name}.*예약 확정`) }));
 const confirmed = store.getSnapshot();
 // D-384: both modes open the cancellation confirmation on the first press and commit only on the second.
 await userEvent.click(panel.getByRole('button', { name: '예약 취소하기' }));
 expect(store.getSnapshot()).toBe(confirmed);
 const confirm = panel.getByRole('group', { name: '이 예약을 취소할까요?' });
 expect(within(confirm).getByRole('button', { name: '예약 유지하기' })).toBeVisible();
 await userEvent.click(within(confirm).getByRole('button', { name: '예약 취소 확정하기' }));
 expect(selectReservations(store.getSnapshot(), { date: TODAY }).count).toBe(today.count - 1);
 act(() => { store.undo(host.notify.mock.calls.at(-1)![0].undoToken!); });
 expect(selectReservations(store.getSnapshot(), { date: TODAY }).count).toBe(today.count);
});
it('restores the CCTV preview video when the panel is expanded again',()=>{
 const props = {featureId:'customer-analysis' as const,condition,host:makeHost(),presetId:'A' as const,editing:false};
 const view = renderWithKit(<CustomerAnalysisPanel {...props} width={2} height={2} shape="S"/>);
 expect(screen.getByTestId('panel-video')).toBeInTheDocument();
 view.rerender(<CustomerAnalysisPanel {...props} width={1} height={1} shape="Q"/>);
 expect(screen.queryByTestId('panel-video')).not.toBeInTheDocument();
 view.rerender(<CustomerAnalysisPanel {...props} width={2} height={2} shape="S"/>);
 expect(screen.getByTestId('panel-video')).toBeInTheDocument();
});
it('explains why the selected interval table has no rows', () => {
 const store = createWidgetDataStore({ cctvHourly: [] });
 renderWithKit(<CustomerAnalysisDetail featureId="customer-analysis" condition={condition} detailRef={{ featureId: 'customer-analysis' }} host={makeHost()} />, { store });
 const interval = within(screen.getByRole('region', { name: '선택한 구간' }));
 expect(interval.getByText('선택한 구간에 기록된 방문·근무 자료가 없어요')).toBeVisible();
});
it.each(['menu','members'] as const)('empty %s resets only its own example and opens a new row without changing data',async featureId=>{
 const {useState}=await import('react');const {WidgetDataProvider}=await import('../../../data/react');const {MenuPanel}=await import('../mgmt-products/menu');const {MembersPanel}=await import('./members');
 const store=createWidgetDataStore(),before=store.getSnapshot();const events:string[]=[];
 function Harness(){const [preview,setPreview]=useState({family:'empty' as const,overrides:{menu:'no-menus',members:'no-members','customer-analysis':'camera-disconnected'}});const [register,setRegister]=useState(false);
 const host={...makeHost(),resetPreview:()=>{events.push('reset');setPreview(old=>({...old,overrides:{...old.overrides,[featureId]:'normal'}}));},openDetail:()=>{events.push('open');setRegister(true);}};
 return <WidgetDataProvider store={store} preview={preview}>{register?featureId==='menu'?<MenuDetail featureId="menu" condition={condition} detailRef={{featureId:'menu',view:'register'}} host={host}/>:<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members',view:'register'}} host={host}/>:featureId==='menu'?<MenuPanel featureId="menu" condition={condition} host={host} width={1} height={1} shape="Q" presetId="A" editing={false}/>:<MembersPanel featureId="members" condition={condition} host={host} width={1} height={1} shape="Q" presetId="A" editing={false}/>}<output aria-label="다른 예시">{preview.overrides['customer-analysis']}</output></WidgetDataProvider>;}
 renderWithKit(<Harness/>,{store});await userEvent.click(screen.getByRole('button',{name:featureId==='menu'?/메뉴 추가하기/:/회원 추가하기/}));expect(events).toEqual(['reset','open']);expect(screen.getByLabelText(featureId==='menu'?'메뉴 이름':'이름')).toHaveValue('');expect(screen.getByLabelText('다른 예시')).toHaveTextContent('camera-disconnected');expect(store.getSnapshot()).toBe(before);
});
it('menu panel saves the name once, rejects an invalid price and keeps the model on Escape', async () => {
  const user = userEvent.setup();
  const store = createWidgetDataStore(), host = makeHost();
  const menu = () => selectMenus(store.getSnapshot(), {}).rows.find(row => row.menuId === 'm-americano')!;
  const original = menu();
  renderWithKit(<MenuDetail featureId="menu" condition={condition} detailRef={{ featureId: 'menu' }} host={host} />, { store, reducedMotion: true });

  await user.click(screen.getByRole('gridcell', { name: '아메리카노, 메뉴 이름, 아메리카노' }));
  const namePanel = within(screen.getByRole('region', { name: '아메리카노' }));
  const name = namePanel.getByRole('textbox', { name: '메뉴 이름' });
  await user.clear(name);
  await user.type(name, '긴 이름 새 메뉴');
  const revision = store.getSnapshot().revision;
  await user.click(namePanel.getByRole('button', { name: '메뉴 이름 저장하기' }));
  expect(store.getSnapshot().revision).toBe(revision + 1);
  expect(menu().name).toEqual({ raw: '긴 이름 새 메뉴' });
  expect(host.notify).toHaveBeenCalledTimes(1);
  const notice = host.notify.mock.calls[0]![0];
  expect(notice).toMatchObject({ kind: 'success', undoToken: expect.any(String) });

  const region = screen.getByRole('region', { name: '긴 이름 새 메뉴' });
  const panel = within(region);
  const price = panel.getByRole('spinbutton', { name: '판매가' });
  await user.clear(price);
  await user.type(price, '0');
  const before = store.getSnapshot();
  await user.keyboard('{Enter}');
  expect(panel.getByRole('alert')).toHaveTextContent('판매가는 0원보다 커야 해요');
  expect(price).toHaveAttribute('aria-invalid', 'true');
  expect(price).toHaveAccessibleDescription(/판매가는 0원보다 커야 해요/);
  expect(store.getSnapshot()).toBe(before);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByRole('region', { name: '긴 이름 새 메뉴' })).not.toBeInTheDocument();
  expect(store.getSnapshot()).toBe(before);

  act(() => { store.undo(notice.undoToken); });
  expect(menu().name).toEqual(original.name);
  expect(menu().price).toBe(original.price);
});
it('member archive preserves linked history and undo restores membership count and notes',async()=>{
 const store=createWidgetDataStore(),host=makeHost();const before=selectMembers(store.getSnapshot(),{});const original=before.rows.find(r=>r.memberId==='M-0008')!;/* F-1: a member who holds 충전금·외상·회원권 cannot be archived; M-0008 has nothing outstanding. */renderWithKit(<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members',itemId:original.memberId}} host={host}/>,{store});const side=screen.getByRole('region');await userEvent.click(within(side).getByRole('button',{name:'회원 지우기'}));expect(selectMembers(store.getSnapshot(),{}).total).toBe(before.total-1);expect(selectMembers(store.getSnapshot(),{}).membershipCount).toBe(before.membershipCount-original.memberships.filter(m=>m.active).length);act(()=>{store.undo(host.notify.mock.calls.at(-1)![0].undoToken!);});const restored=selectMembers(store.getSnapshot(),{});expect(restored.total).toBe(before.total);expect(restored.membershipCount).toBe(before.membershipCount);expect(restored.rows.find(r=>r.memberId===original.memberId)!.notes).toEqual(original.notes);
});
it('menu memo add/edit/delete preserves entered Korean text',async()=>{
 const store=createWidgetDataStore();renderWithKit(<MenuDetail featureId="menu" condition={condition} detailRef={{featureId:'menu',itemId:'m-americano'}} host={makeHost()}/>,{store});const side=screen.getByRole('region',{name:'아메리카노'});await userEvent.click(within(side).getByRole('button',{name:'메모 추가하기'}));await userEvent.type(within(side).getByRole('textbox',{name:'메모'}),'샷 추가 문의');await userEvent.click(within(side).getByRole('button',{name:'메모 저장하기'}));expect(selectMenus(store.getSnapshot(),{}).rows[0]!.memo).toEqual({raw:'샷 추가 문의'});await userEvent.click(within(side).getByRole('button',{name:'샷 추가 문의 고치기'}));await userEvent.clear(within(side).getByRole('textbox',{name:'메모'}));await userEvent.type(within(side).getByRole('textbox',{name:'메모'}),'디카페인 문의');await userEvent.click(within(side).getByRole('button',{name:'메모 저장하기'}));await userEvent.click(within(side).getByRole('button',{name:'디카페인 문의 지우기'}));expect(selectMenus(store.getSnapshot(),{}).rows[0]!.memo).toBeNull();
});
it('returns focus after a manual grade choice and keeps the automatic marketing grade',async()=>{
 const store=createWidgetDataStore();renderWithKit(<MembersDetail featureId="members" condition={condition} detailRef={{featureId:'members',itemId:'M-0001'}} host={makeHost()}/>,{store});const side=screen.getByRole('region'),opener=within(side).getByRole('button',{name:'직접 정하기'});await userEvent.click(opener);await userEvent.click(within(side).getByRole('radio',{name:'오랜 기간 미방문'}));const row=selectMembers(store.getSnapshot(),{}).rows[0]!;expect(row.grade).toBe('inactive');expect(row.automaticGrade).toBe('regular');expect(opener).toHaveFocus();
});
