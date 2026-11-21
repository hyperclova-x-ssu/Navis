export function prepareNaturalOverflow() {
  const body = document.querySelector('[role="dialog"] .ui-overlay-body');
  const module = body.querySelector('.detail-module-body');
  if (module.querySelector('.ui-data-grid')) return null;
  const visible = node => node.getClientRects().length && !node.closest('[hidden],[inert]');
  const own = [...module.querySelectorAll('*')].find(node => {
    if (!visible(node) || node.closest('textarea,input,select,[contenteditable]:not([contenteditable="false"])')) return false;
    const css = getComputedStyle(node);
    const lineHeight = parseFloat(css.lineHeight) || (parseFloat(css.fontSize) || 16) * 1.2;
    return /^(auto|scroll)$/.test(css.overflowY) && node.clientHeight >= lineHeight * 2;
  });
  const parent = own ?? module.firstElementChild;
  if (!parent) throw new Error('비그리드 본문 없음');
  const tail = document.createElement('p');
  tail.id = 'detail-check-tail'; tail.lang = 'ko'; tail.textContent = '상세 본문 마지막 내용';
  tail.style.minHeight = `${body.clientHeight * 2}px`; tail.style.flexShrink = '0';
  parent.append(tail);
  const scroller = own ?? body;
  scroller.setAttribute('data-detail-check-scroll', '');
  return { region: own?.className ?? 'ui-overlay-body', scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
}

export function availableTabs() {
  const module = document.querySelector('[role="dialog"] .detail-module-body');
  const path = node => {
    const parts = [];
    while (node && node !== module) {
      const siblings = [...node.parentElement.children];
      parts.push(`${node.tagName}:${siblings.indexOf(node)}`);
      node = node.parentElement;
    }
    return parts.reverse().join('/');
  };
  return [...module.querySelectorAll('[role="tab"]')].flatMap((node, index) => {
    if (!node.getClientRects().length || node.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"]') ||
        node.matches(':disabled') || getComputedStyle(node).visibility === 'hidden') return [];
    return [{ index, key: `${path(node)}:${node.textContent.trim()}`, label: node.textContent.trim() }];
  });
}
