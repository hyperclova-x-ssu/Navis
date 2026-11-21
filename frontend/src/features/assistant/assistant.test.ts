import { describe, expect, it } from 'vitest';
import { samePanels } from '../../layout';
import { cafeWeek } from './__fixtures__/cafe';
import * as assistant from './index';

describe('widget data and assistant', () => {
  it('does not export a typed-text board writer', () => {
    expect(assistant).not.toHaveProperty('createAssistantController');
    expect(assistant).not.toHaveProperty('fixedInterpreter');
  });

  it('distinguishes snapshots whose panel conditions differ',()=>{
    const base={featureId:'ledger',row:0,column:0,width:1,height:1} as const;
    expect(samePanels([{...base,condition:{kind:'default'}}],[{...base,condition:cafeWeek}])).toBe(false);
  });
});
