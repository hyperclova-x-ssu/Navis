// @vitest-environment jsdom
// A-1 (public review): picking a receipt photo in the chat closed the chat, because the photo popover is rendered in a portal outside the dock and its
// click counted as an outside press. A press inside any popup that a control of the chat opened (aria-controls) is a press inside the chat.
import { afterEach, describe, expect, it } from 'vitest';
import { pressIsOutsideChat } from './navis-outside';

afterEach(() => { document.body.innerHTML = ''; });
const html = (markup: string) => { document.body.innerHTML = markup; return document.getElementById('dock')!; };

describe('what counts as an outside press', () => {
  it('is false inside the dock, and inside a popup the dock\'s own control opened, however deep and wherever it is portaled', () => {
    const dock = html(`<div id="dock"><button id="trigger" aria-controls="picker" aria-expanded="true">사진</button></div>
      <div id="picker" class="ui-popover"><div><button id="take">사진 찍기</button></div></div><div id="elsewhere"><button id="other">다른 곳</button></div>`);
    expect(pressIsOutsideChat(dock, document.getElementById('trigger'))).toBe(false);
    expect(pressIsOutsideChat(dock, document.getElementById('picker'))).toBe(false);
    expect(pressIsOutsideChat(dock, document.getElementById('take'))).toBe(false);
    expect(pressIsOutsideChat(dock, document.getElementById('other'))).toBe(true);
  });
  it('is true for a popup no control of the chat opened, the notice toast is left alone, and a non-node target is not a press', () => {
    const dock = html(`<div id="dock"><button id="trigger" aria-controls="picker">사진</button></div>
      <div id="menu" role="menu"><button id="item">메뉴</button></div><div class="app-common-notice"><button id="undo">되돌리기</button></div>`);
    expect(pressIsOutsideChat(dock, document.getElementById('item'))).toBe(true);
    expect(pressIsOutsideChat(dock, document.getElementById('undo'))).toBe(false);
    expect(pressIsOutsideChat(dock, null)).toBe(false);
  });
});
