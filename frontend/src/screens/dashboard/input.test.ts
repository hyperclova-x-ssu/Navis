import {beginDashboard} from '../../app/test-session';
import '../../ui/test-setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { timePolicy } from '../../ui/motion';
import { screenPresets } from '../../layout/presets';
import { getRegistry } from '../../catalog';
import { createInputGate, inputSequenceFromEvent } from './input';
let now: number;
let run: ReturnType<typeof createRunStore>;
let gate: ReturnType<typeof createInputGate>;
let stop: () => void;
const pointer = (target: EventTarget, type: string, id = 1) => target.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, button: 0, bubbles: true, cancelable: true }));
beforeEach(() => { now = 0; run = createRunStore({ screenPreset:screenPresets.A,catalog:getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light' }); beginDashboard(run,null); run.actions.visualSettled(); now = 400; run.actions.tick(); run.actions.dismissCoach(); gate = createInputGate(run); stop = gate.attach(document, window); });
afterEach(() => { stop(); document.body.replaceChildren(); });
function idle() { now += timePolicy.idleMs; run.actions.tick(); expect(run.getState().idle.mode).toBe('idle'); }
describe('native input boundary', () => {
    it('recovers a lost nonmodifier keyup on a fresh pointer while preserving the primary contact',()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'x',code:'KeyX',bubbles:true}));pointer(document,'pointerdown',1);
        expect(run.getState().activeInputs).toEqual([{kind:'pointer',id:1}]);pointer(document,'pointerdown',2);
        expect(run.getState().activeInputs.some(input=>input.kind==='pointer'&&input.id===1)).toBe(true);
    });
    it('recovers an omitted Meta release when a later keyboard event reports no modifier',()=>{
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'Meta',code:'MetaLeft',metaKey:true,bubbles:true}));
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'v',code:'KeyV',metaKey:true,bubbles:true}));
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'a',code:'KeyA',metaKey:false,bubbles:true}));
        expect(run.getState().activeInputs).toEqual([{kind:'keyboard',id:'KeyA'}]);
    });
    it.each([false, true])('releases a Meta shortcut without the letter keyup (physical code: %s)', physicalCode => {
        const key = (type: string, value: string, code: string, metaKey = false) => document.dispatchEvent(new KeyboardEvent(type, { key: value, code: physicalCode ? code : '', metaKey, bubbles: true, cancelable: true }));
        key('keydown', 'Meta', 'MetaLeft', true);
        key('keydown', 'v', 'KeyV', true);
        key('keyup', 'Meta', 'MetaLeft');
        expect(run.getState().activeInputs).toEqual([]);
        run.actions.startWithThree(); run.actions.visualSettled(); run.actions.clearNotice();
        now += timePolicy.coachGapMs; run.actions.tick();
        expect(run.getState().guidance.active).toBe('move-panel');
        run.actions.dismissCoach();run.actions.enterEditing(); now += timePolicy.coachGapMs; run.actions.tick(); run.actions.dismissCoach();run.actions.finishEditing();
        // v4 (getRegistry run): the three widget explanations follow F-03; skip them so the briefing becomes safe.
        run.actions.skipWidgetCoaches();
        now += timePolicy.briefingSafeMs; run.actions.tick();
        expect(run.getState().overlay.type).toBe('briefing');
        const exit = run.actions.closeOverlay()!; run.actions.finishOverlayExit(exit);
        idle();
    });
    it('matches a physical key after Shift changes its reported key value', () => {
        const down = new KeyboardEvent('keydown', { key: 'V', code: 'KeyV', shiftKey: true, bubbles: true });
        document.dispatchEvent(down);
        expect(run.getState().activeInputs).toEqual([inputSequenceFromEvent(down, run)]);
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', bubbles: true }));
        expect(run.getState().activeInputs).toEqual([]);
    });
    it('keeps a held pointer active when ending a Meta shortcut with a lost keyup', () => {
        pointer(document, 'pointerdown');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', code: 'MetaLeft', bubbles: true }));
        expect(run.getState().activeInputs).toEqual([{ kind: 'pointer', id: 1 }]);
        pointer(document, 'pointerup');
        expect(run.getState().activeInputs).toEqual([]);
    });
    it('consumes the first pointer sequence including click, then allows a new contact', () => {
        const button = document.createElement('button');
        const action = vi.fn();
        button.addEventListener('click', action);
        document.body.append(button);
        idle();
        pointer(button, 'pointermove');
        expect(run.getState().idle.mode).toBe('idle');
        pointer(button, 'pointerdown');
        pointer(button, 'pointerup');
        button.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
        expect(action).not.toHaveBeenCalled();
        expect(run.getState().idle.mode).toBe('active');
        pointer(button, 'pointerdown');
        pointer(button, 'pointerup');
        button.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
        expect(action).toHaveBeenCalledTimes(1);
    });
    it('consumes repeated wake keyboard input and its click without swallowing the next key', () => {
        const button = document.createElement('button');
        const action = vi.fn();
        button.addEventListener('click', action);
        document.body.append(button);
        idle();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }));
        button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
        button.click();
        expect(action).not.toHaveBeenCalled();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true, cancelable: true }));
        button.click();
        expect(action).toHaveBeenCalledTimes(1);
    });
    it('ignores a second contact while the first remains the primary interaction', () => {
        const moves = vi.fn();
        document.addEventListener('pointermove', moves);
        pointer(document, 'pointerdown', 1);
        pointer(document, 'pointerdown', 2);
        pointer(document, 'pointermove', 2);
        expect(moves).not.toHaveBeenCalled();
        expect(run.getState().activeInputs).toEqual([{ kind: 'pointer', id: 1 }]);
        pointer(document, 'pointermove', 1);
        expect(moves).toHaveBeenCalledTimes(1);
        pointer(document, 'pointerup', 1);
        pointer(document, 'pointerup', 2);
        document.removeEventListener('pointermove', moves);
    });
    it('suppresses the compatibility click after a drag without blocking its moves or release', () => {
        const action = vi.fn();
        const button = document.createElement('button');
        document.body.append(button);
        button.addEventListener('click', action);
        pointer(button, 'pointerdown');
        gate.consumePointer(1);
        pointer(button, 'pointermove');
        pointer(button, 'pointerup');
        button.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
        expect(action).not.toHaveBeenCalled();
        expect(run.getState().activeInputs).toEqual([]);
    });
});
