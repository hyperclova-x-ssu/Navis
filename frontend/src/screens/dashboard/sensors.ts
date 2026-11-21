import type { PointerEvent as ReactPointerEvent } from 'react';
import type { SensorProps, SensorInstance, Activators } from '@dnd-kit/core';
import type { RunStore, ViewportTransform } from '../../contracts';
import { gestureTokens } from '../../ui/motion';
import { toCanvasPoint, toCanvasRect } from '../../ui/viewport';
import { drawerDirection, type Point, type Rect } from './gestures';
import type { DashboardController, DragData } from './controller';
import type { InputGate } from './input';
export interface DashboardSensorOptions {
    readonly run: RunStore;
    readonly controller: DashboardController;
    readonly gate: InputGate;
    readonly capture: (node: HTMLElement, rect: DOMRect) => void;
    readonly getTransform:()=>ViewportTransform;
}
export function readDragData(value: unknown): DragData | null {
    if (!value || typeof value !== 'object') return null;
    const data = value as Partial<DragData>;
    return (data.source === 'feature' || data.source === 'candidate' || data.source === 'panel' || data.source === 'resize') && typeof data.featureId === 'string' ? data as DragData : null;
}
/** One dnd-kit sensor owns the native contact beyond the lifetime of its row.
 * Click suppression belongs to InputGate's pointer sequence, never a global timer.
 */
export class DashboardPointerSensor implements SensorInstance {
    autoScrollEnabled = false;
    static activators: Activators<DashboardSensorOptions> = [{eventName:'onPointerDown', handler:(event:ReactPointerEvent,_options,{active})=>Boolean(event.nativeEvent.isPrimary!==false&&event.button===0&&readDragData(active.data.current))}];
    constructor(props: SensorProps<DashboardSensorOptions>) {
        const data = readDragData(props.activeNode.data.current);
        if (!data) return;
        const event = props.event as PointerEvent;
        const node = props.activeNode.node.current;
        const rect = node?.getBoundingClientRect();
        const transform=props.options.getTransform();
        const changed=()=>{const t=props.options.getTransform();return t.scale!==transform.scale||t.offsetX!==transform.offsetX||t.offsetY!==transform.offsetY;};
        const sourceRect:Rect=toCanvasRect(rect??{x:event.clientX,y:event.clientY,width:0,height:0},transform);
        if (node && rect) props.options.capture(node,rect);
        const origin = toCanvasPoint({x:event.clientX,y:event.clientY},transform);
        const pointerId = event.pointerId;
        const editingPanel = data.source === 'panel' && props.options.run.getState().edit.mode === 'edit';
        const doc = node?.ownerDocument ?? document;
        const win = doc.defaultView ?? window;
        let started = false;
        let ended = false;
        let latest: Point = origin;
        let timer: number | null = null;
        let direction: 'pending'|'list'|'drag' = 'pending';
        const clearTimer = () => { if (timer !== null) { win.clearTimeout(timer); timer = null; } };
        const cleanup = () => {
            clearTimer();
            node?.removeEventListener('touchmove',touchMove);
            doc.removeEventListener('touchmove',touchMove);
            if(doc.documentElement.hasPointerCapture?.(pointerId))doc.documentElement.releasePointerCapture(pointerId);
            doc.removeEventListener('pointermove',move);
            doc.removeEventListener('pointerup',end);
            doc.removeEventListener('pointercancel',cancel);
            doc.removeEventListener('keydown',key,true);
            doc.removeEventListener('visibilitychange',hidden);
            win.removeEventListener('blur',blur);
            win.removeEventListener('resize',viewport);
            win.visualViewport?.removeEventListener('resize',viewport);
            win.visualViewport?.removeEventListener('scroll',viewport);
        };
        const abort = (viewportChange=false) => {
            if (ended) return;
            ended = true; cleanup();
            props.options.gate.consumePointer(pointerId);
            if(viewportChange)props.options.controller.cancelForViewportChange();else props.options.controller.cancel();
            if (!started) props.onAbort(props.active);
            props.onCancel();
        };
        const start = () => {
            if (ended || started) return;
            if(changed()){abort(true);return;}
            clearTimer();
            started = props.options.controller.start(data,pointerId,origin,sourceRect);
            props.options.gate.consumePointer(pointerId);
            if (!started) {
                ended = true; cleanup(); props.onAbort(props.active); props.onEnd(); return;
            }
            direction = 'drag';
            // Capture on a permanent node: the drawer row can disappear this frame.
            try{doc.documentElement.setPointerCapture?.(pointerId);}catch{/* A synthetic test contact has no native capture. */}
            props.onStart(origin);
            props.options.controller.move(latest);
            props.onMove(latest);
        };
        const move = (next: PointerEvent) => {
            if (ended || next.pointerId !== pointerId) return;
            if(changed()){abort(true);return;}
            latest = toCanvasPoint({x:next.clientX,y:next.clientY},transform);
            if (!started) {
                const dx = latest.x-origin.x; const dy = latest.y-origin.y;
                if (data.source === 'panel') {
                    if (Math.hypot(dx,dy)<=gestureTokens.slop) return;
                    if (!editingPanel) { abort(); return; }
                    start();
                } else {
                    direction = data.source === 'feature' || data.source === 'candidate' ? drawerDirection(direction,dx,dy) : Math.hypot(dx,dy)>=gestureTokens.slop ? 'drag' : 'pending';
                    if (direction === 'list') { props.options.gate.consumePointer(pointerId); return; }
                    if (direction !== 'drag') return;
                    start();
                }
            }
            if (ended) return;
            if (next.cancelable) next.preventDefault();
            props.options.controller.move(latest); props.onMove(latest);
        };
        const end = (next: PointerEvent) => {
            if (ended || next.pointerId !== pointerId) return;
            if(changed()){abort(true);return;}
            latest = toCanvasPoint({x:next.clientX,y:next.clientY},transform);
            ended = true; cleanup();
            if (started) props.options.controller.end(latest);
            else props.onAbort(props.active);
            props.onEnd();
            if (!started && direction === 'pending') {
                props.options.gate.consumePointer(pointerId);
                props.options.controller.tap(data,latest,sourceRect);
            }
        };
        // Pointermove cancellation cannot prevent a browser pan. Touch events still
        // target the original (possibly detached) row, so retain this listener too.
        const touchMove=(next:Event)=>{if(started&&!ended&&next.cancelable)next.preventDefault();};
        const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) abort(); };
        const key = (next: KeyboardEvent) => { if (next.key === 'Escape') abort(); };
        const blur = () => abort();
        const viewport=()=>abort(true);
        const hidden = () => { if (doc.hidden) abort(); };
        node?.addEventListener('touchmove',touchMove,{passive:false});
        doc.addEventListener('touchmove',touchMove,{passive:false});
        doc.addEventListener('pointermove',move,{passive:false});
        doc.addEventListener('pointerup',end);
        doc.addEventListener('pointercancel',cancel);
        doc.addEventListener('keydown',key,true);
        doc.addEventListener('visibilitychange',hidden);
        win.addEventListener('blur',blur);
        win.addEventListener('resize',viewport);
        win.visualViewport?.addEventListener('resize',viewport);
        win.visualViewport?.addEventListener('scroll',viewport);
        if (data.source === 'panel') {
            if (editingPanel) props.onPending(props.active,{distance:gestureTokens.slop},origin);
            else {
                props.onPending(props.active,{delay:gestureTokens.longPressMs,tolerance:gestureTokens.slop},origin);
                timer = win.setTimeout(start,gestureTokens.longPressMs);
            }
        } else props.onPending(props.active,{distance:gestureTokens.slop},origin);
    }
}
