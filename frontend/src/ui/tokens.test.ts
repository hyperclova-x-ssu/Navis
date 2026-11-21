import { expect,it } from 'vitest';
import { formatNotice } from './copy';
import { createKitTranslator } from './messages';
import { dashboardBundle } from '../screens/dashboard/messages';
it('uses current coordinates and size without importance order',()=>{
 expect(createKitTranslator('ko').t('ui.panel.size',{w:1,h:4})).toBe('가로 1칸, 세로 4칸');
 expect(formatNotice({id:'move',kind:'success',messageKey:'move',expiresAt:0,panel:{featureId:'ledger',column:3,row:2,width:2,height:1},displacedCount:2},'가계부')).toBe('가계부, 3행 4열, 가로 2칸, 세로 1칸. 패널 2개가 비켜났어요');
 // The move coach (DS 11.7) names the gesture, never an order of importance.
 expect(dashboardBundle.ko['dashboard.coach.move']).not.toMatch(/앞|순서|먼저/);
});
it('retains Korean particles and distinguishes failure from success',()=>{
 expect(formatNotice({id:'a',kind:'success',messageKey:'add',expiresAt:0},'가계부')).toBe('가계부를 추가했어요');
 expect(formatNotice({id:'b',kind:'success',messageKey:'remove',expiresAt:0},'브리핑')).toBe('브리핑을 뺐어요');
 expect(formatNotice({id:'c',kind:'error',messageKey:'NO_CAPACITY',expiresAt:0})).toBe('자리가 없어요. 패널을 줄이거나 빼거나 새 페이지를 추가해 주세요');
});
