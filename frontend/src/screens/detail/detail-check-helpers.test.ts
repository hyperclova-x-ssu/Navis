import { afterEach, describe, expect, it } from 'vitest';
import { availableTabs, prepareNaturalOverflow } from './detail-check-helpers.mjs';

function visible(element: Element, height = 100) {
  Object.defineProperty(element, 'getClientRects', { value: () => [{ height }], configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
}
function setup(content: string) {
  document.body.innerHTML = `<div role="dialog"><div class="ui-overlay-body"><div class="detail-module-body"><div>${content}</div></div></div></div>`;
  visible(document.querySelector('.ui-overlay-body')!, 300);
  document.querySelectorAll('.detail-module-body *').forEach(node => visible(node));
}
afterEach(() => { document.body.innerHTML = ''; });

describe('detail overflow probe', () => {
  it('ignores form controls and small overflow areas, using the body when none qualifies', () => {
    setup('<textarea style="overflow-y:auto"></textarea><input style="overflow-y:auto"><select style="overflow-y:auto"></select><div contenteditable style="overflow-y:auto"></div><div class="tiny" style="overflow-y:auto"></div>');
    visible(document.querySelector('.tiny')!, 20);
    expect(prepareNaturalOverflow()?.region).toBe('ui-overlay-body');
    expect(document.querySelector('.detail-module-body > div > #detail-check-tail')).not.toBeNull();
  });
  it('selects a substantial overflow region even if it grows without scrolling', () => {
    setup('<textarea style="overflow-y:auto"></textarea><section class="mkt-hours" style="overflow-y:auto"></section>');
    expect(prepareNaturalOverflow()?.region).toBe('mkt-hours');
    expect(document.querySelector('.mkt-hours > #detail-check-tail')).not.toBeNull();
  });
  it('leaves grid content untouched', () => {
    setup('<div class="ui-data-grid"></div>');
    expect(prepareNaturalOverflow()).toBeNull();
    expect(document.querySelector('#detail-check-tail')).toBeNull();
  });
});
describe('detail tab discovery', () => {
  it('returns every visible enabled tab including 판매 상품, excluding hidden and disabled tabs', () => {
    setup('<div role="tablist" aria-label="재고"><button role="tab">원자재</button><button role="tab">판매 상품</button><button role="tab" disabled>사용 불가</button><div hidden><button role="tab">숨김</button></div></div>');
    expect(availableTabs().map(tab => tab.index)).toEqual([0, 1]);
  });
  it('distinguishes tabs with the same label in separate tablists', () => {
    setup('<div role="tablist" aria-label="첫째"><button role="tab">목록</button></div><div role="tablist" aria-label="둘째"><button role="tab">목록</button></div>');
    expect(new Set(availableTabs().map(tab => tab.key)).size).toBe(2);
  });
});
