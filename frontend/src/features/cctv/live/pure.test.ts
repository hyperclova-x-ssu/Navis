import {act, renderHook} from '@testing-library/react';
import {afterEach, describe, expect, it} from 'vitest';
import {ClockSync} from './clock';
import {parseBaseUrl, socketUrl} from './config';
import {encodeFrameMessage, parseFrameMessage} from './frame';
import {getCctvMode, resetCctvModeForTest, setCctvMode, useCctvMode} from './mode';
import {frameHeader} from './testFakes';

describe('config (VITE_CNN_SERVER_URL)', () => {
  it('missing or empty means not configured; no default address', () => {
    expect(parseBaseUrl(undefined)).toBeNull();
    expect(parseBaseUrl('')).toBeNull();
    expect(parseBaseUrl('   ')).toBeNull();
    expect(parseBaseUrl('moa:8443')).toBeNull();
  });
  it('trims the trailing slash and maps https → wss', () => {
    const b = parseBaseUrl('https://moa.example.ts.net:8443/');
    expect(b).toBe('https://moa.example.ts.net:8443');
    expect(socketUrl(b!, '/ws/view')).toBe('wss://moa.example.ts.net:8443/ws/view');
    expect(socketUrl('http://localhost:8000', '/ws/view')).toBe('ws://localhost:8000/ws/view');
  });
});

describe('mode store (API-19.1)', () => {
  afterEach(() => resetCctvModeForTest());
  it('starts as mock', () => {
    expect(getCctvMode()).toBe('mock');
    const {result} = renderHook(() => useCctvMode());
    expect(result.current).toBe('mock');
  });
  it('every subscriber sees the change', () => {
    const a = renderHook(() => useCctvMode());
    const b = renderHook(() => useCctvMode());
    act(() => setCctvMode('live'));
    expect(a.result.current).toBe('live');
    expect(b.result.current).toBe('live');
  });
});

describe('frame message header (API-17)', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  it('reads header and JPEG', () => {
    const p = parseFrameMessage(encodeFrameMessage(frameHeader({frameId: 7}), jpeg));
    expect(p?.header.frameId).toBe(7);
    expect([...p!.jpeg!]).toEqual([...jpeg]);
  });
  it('0-byte JPEG (video:false) gives jpeg null', () => {
    const p = parseFrameMessage(encodeFrameMessage(frameHeader()));
    expect(p?.header.type).toBe('frame');
    expect(p?.jpeg).toBeNull();
  });
  it('boundary lengths are rejected without throwing', () => {
    expect(parseFrameMessage(new ArrayBuffer(0))).toBeNull();
    expect(parseFrameMessage(new ArrayBuffer(3))).toBeNull();
    const good = new Uint8Array(encodeFrameMessage(frameHeader()));
    // header length exactly fills the buffer → ok; one longer → rejected
    expect(parseFrameMessage(good.buffer)).not.toBeNull();
    const over = good.slice();
    new DataView(over.buffer).setUint32(0, good.length - 4 + 1, false);
    expect(parseFrameMessage(over.buffer)).toBeNull();
    const zero = good.slice();
    new DataView(zero.buffer).setUint32(0, 0, false);
    expect(parseFrameMessage(zero.buffer)).toBeNull();
    const huge = good.slice();
    new DataView(huge.buffer).setUint32(0, 0xffffffff, false);
    expect(parseFrameMessage(huge.buffer)).toBeNull();
  });
  it('bad JSON or wrong type is skipped', () => {
    const bad = new Uint8Array(4 + 3);
    new DataView(bad.buffer).setUint32(0, 3, false);
    bad.set(new TextEncoder().encode('{x:'), 4);
    expect(parseFrameMessage(bad.buffer)).toBeNull();
    expect(parseFrameMessage(encodeFrameMessage({type: 'status'}))).toBeNull();
  });
  it('reads a header written at a non-zero byte offset of a bigger buffer', () => {
    const msg = new Uint8Array(encodeFrameMessage(frameHeader({frameId: 3}), jpeg));
    expect(parseFrameMessage(msg.slice().buffer)?.header.frameId).toBe(3);
  });
});

describe('clock sync (ping/pong, e2eMs)', () => {
  it('offset is the median of the last 5 samples, before any sample e2e is null', () => {
    const c = new ClockSync();
    expect(c.e2eMs(10, 9)).toBeNull();
    // server is 100 s ahead, rtt 0.02 s
    c.addPong(1.0, 101.01, 1.02);
    expect(c.offset).toBeCloseTo(100, 6);
    c.addPong(2.0, 150, 2.02); // outlier
    c.addPong(3.0, 103.01, 3.02);
    expect(c.offset).toBeCloseTo(100, 6);
    // drawn at local 5.0 → server 105.0; captured at server 104.7 → 300 ms
    expect(c.e2eMs(5.0, 104.7)).toBe(300);
  });
  it('keeps 5 samples only', () => {
    const c = new ClockSync();
    for (let i = 0; i < 5; i++) c.addPong(i, i + 50, i);
    for (let i = 5; i < 10; i++) c.addPong(i, i + 10, i);
    expect(c.offset).toBe(10);
  });
});
