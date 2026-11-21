import type { InputSequence, RunStore } from '../../contracts';
export interface InputGate {
    readonly attach: (doc: Document, win: Window) => () => void;
    readonly consumePointer: (pointerId: number) => void;
}
const keyboardId = (event: KeyboardEvent) => event.code || event.key;
const isMeta = (event: KeyboardEvent) => event.key === 'Meta' || event.code === 'MetaLeft' || event.code === 'MetaRight';
export function inputSequenceFromEvent(event: Event, run: RunStore): InputSequence | undefined {
    if (event instanceof KeyboardEvent)
        return { kind: 'keyboard', id: keyboardId(event) };
    if ('pointerId' in event && typeof event.pointerId === 'number' && event.pointerId > 0)
        return { kind: 'pointer', id: event.pointerId };
    return run.getState().activeInputs.find(input => input.kind === 'pointer');
}
export function createInputGate(run: RunStore, onInput: () => void = () => { }, onCancel: () => void = () => { }): InputGate {
    const pointers = new Map<number, {
        blocked: boolean;
        suppressClick: boolean;
        released: boolean;
    }>();
    const keys = new Map<string, {
        blocked: boolean;
        released: boolean;
        metaShortcut: boolean;
    }>();
    let primary: number | null = null;
    let lastPointer: number | null = null;
    let lastKey: string | null = null;
    const consume = (event: Event) => { if (event.cancelable)
        event.preventDefault(); event.stopPropagation(); };
    return {
        consumePointer(id) { const state = pointers.get(id); if (state)
            state.suppressClick = true;
        else
            pointers.set(id, { blocked: false, suppressClick: true, released: false }); },
        attach(doc, win) {
            const releaseKeys = (onlyMeta = false) => {
                for (const [id,state] of keys) if (!state.released && (!onlyMeta || state.metaShortcut)) {
                    run.actions.inputEnded({kind:'keyboard',id});run.actions.consumeInput({kind:'keyboard',id},'cancel');state.released=true;
                }
            };
            const down = (event: PointerEvent) => {
                releaseKeys();
                onInput();
                const input: InputSequence = { kind: 'pointer', id: event.pointerId };
                const blocked = run.actions.inputStarted(input) || primary !== null && primary !== event.pointerId;
                pointers.set(event.pointerId, { blocked, suppressClick: blocked, released: false });
                lastPointer = event.pointerId;
                if (!blocked)
                    primary = event.pointerId;
                if (blocked)
                    consume(event);
            };
            const move = (event: PointerEvent) => { if (pointers.get(event.pointerId)?.blocked || run.actions.consumeInput({ kind: 'pointer', id: event.pointerId }, 'move'))
                consume(event); };
            const up = (event: PointerEvent) => {
                const input: InputSequence = { kind: 'pointer', id: event.pointerId };
                const blocked = run.actions.inputEnded(input);
                const state = pointers.get(event.pointerId);
                if (state) {
                    state.released = true;
                    state.suppressClick ||= blocked;
                }
                if (primary === event.pointerId)
                    primary = null;
                lastPointer = event.pointerId;
                if (state?.blocked || blocked)
                    consume(event);
            };
            const cancel = (event: PointerEvent) => {
                const input: InputSequence = { kind: 'pointer', id: event.pointerId };
                const blocked = pointers.get(event.pointerId)?.blocked || run.actions.consumeInput(input, 'cancel');
                run.actions.inputEnded(input);
                if (primary === event.pointerId) {
                    primary = null;
                    onCancel();
                }
                pointers.delete(event.pointerId);
                if (blocked)
                    consume(event);
            };
            const keyDown = (event: KeyboardEvent) => {
                onInput();
                if(!event.metaKey&&!isMeta(event))releaseKeys(true);
                const id = keyboardId(event);
                const old = keys.get(id);
                if (event.repeat && old?.blocked) {
                    consume(event);
                    return;
                }
                const blocked = run.actions.inputStarted({ kind: 'keyboard', id });
                const metaShortcut = event.metaKey || isMeta(event) || ['Meta', 'MetaLeft', 'MetaRight'].some(key => keys.get(key)?.released === false);
                keys.set(id, { blocked, released: false, metaShortcut });
                lastKey = id;
                if (blocked)
                    consume(event);
                else if (event.key === 'Escape' && (run.getState().edit.gesture || run.getState().gesturePreview)) {
                    const candidate=run.getState().gesturePreview?.source==='candidate';
                    onCancel();
                    event.preventDefault();
                    if(candidate)event.stopPropagation();
                }
                else if (event.key === 'Escape' && run.getState().edit.mode === 'edit' && run.getState().overlay.type === 'none') {
                    run.actions.finishEditing();
                    event.preventDefault();
                }
            };
            const keyUp = (event: KeyboardEvent) => {
                // macOS can omit letter keyups while Command is held. Its release ends that chord.
                const released = new Set([keyboardId(event), ...(isMeta(event) ? [...keys].filter(([, state]) => state.metaShortcut && !state.released).map(([id]) => id) : [])]);
                let blocked = false;
                for (const id of released) {
                    const consumed = run.actions.inputEnded({ kind: 'keyboard', id });
                    const state = keys.get(id);
                    if (state)
                        state.released = true;
                    blocked ||= consumed || Boolean(state?.blocked);
                }
                if (blocked)
                    consume(event);
            };
            const click = (event: MouseEvent) => {
                const id = 'pointerId' in event && typeof event.pointerId === 'number' && event.pointerId > 0 ? event.pointerId : event.detail > 0 ? lastPointer : null;
                const key = event.detail === 0 ? lastKey : null;
                if (id !== null) {
                    const state = pointers.get(id);
                    const blocked = run.actions.consumeInput({ kind: 'pointer', id }, 'click');
                    pointers.delete(id);
                    if (state?.suppressClick || blocked) {
                        consume(event);
                        return;
                    }
                }
                if (key !== null) {
                    const state = keys.get(key);
                    const blocked = run.actions.consumeInput({ kind: 'keyboard', id: key }, 'click');
                    if (state?.released)
                        keys.delete(key);
                    if (state?.blocked || blocked) {
                        consume(event);
                        return;
                    }
                }
                if (run.getState().idle.mode === 'idle') {
                    const input: InputSequence = { kind: 'keyboard', id: 'assistive-click' };
                    run.actions.inputStarted(input);
                    run.actions.inputEnded(input);
                    run.actions.consumeInput(input, 'click');
                    consume(event);
                }
            };
            const reset = () => { onCancel(); for (const input of run.getState().activeInputs) {
                run.actions.inputEnded(input);
                run.actions.consumeInput(input, 'cancel');
            } pointers.clear(); keys.clear(); primary = null; };
            const blur = () => { reset(); run.actions.setPageHidden(true); };
            const focus = () => run.actions.setPageHidden(doc.hidden);
            const visibility = () => { if (doc.hidden)
                reset(); run.actions.setPageHidden(doc.hidden); };
            doc.addEventListener('pointerdown', down, true);
            doc.addEventListener('pointermove', move, true);
            doc.addEventListener('pointerup', up, true);
            doc.addEventListener('pointercancel', cancel, true);
            doc.addEventListener('click', click, true);
            doc.addEventListener('keydown', keyDown, true);
            doc.addEventListener('keyup', keyUp, true);
            doc.addEventListener('visibilitychange', visibility);
            win.addEventListener('blur', blur);
            win.addEventListener('focus', focus);
            return () => { doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', move, true); doc.removeEventListener('pointerup', up, true); doc.removeEventListener('pointercancel', cancel, true); doc.removeEventListener('click', click, true); doc.removeEventListener('keydown', keyDown, true); doc.removeEventListener('keyup', keyUp, true); doc.removeEventListener('visibilitychange', visibility); win.removeEventListener('blur', blur); win.removeEventListener('focus', focus); reset(); };
        },
    };
}
