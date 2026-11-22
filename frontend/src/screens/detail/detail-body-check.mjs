// Maintainer-only real-screen check. This boots the actual BrowserApp, observes its
// existing stores, and uses wheel input; no scrollTop assignment or scrollIntoView.
import { runtime } from '../../features/widgets/dev/i5/runtime.mjs';
import { emptyStart } from '../../features/widgets/dev/i5/walkthrough-support.mjs';
import { availableTabs, prepareNaturalOverflow } from './detail-check-helpers.mjs';

const report = { passed: false, configurations: [], errors: [] };
let rt;
const pause = page => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});
async function close(page) {
  await page.evaluate(() => window.__rootI5.run.actions.closeOverlay('button'));
  await page.waitForSelector('[role="dialog"]', { state: 'hidden' });
  await page.waitForSelector('[data-testid="ui-overlay-exit"]', { state: 'hidden' });
}
async function open(page, ref) {
  const opened = await page.evaluate(ref => ref.featureId === 'closing'
    ? window.__rootI5.run.actions.openClosing('app-closing')
    : window.__rootI5.run.actions.openDetailRef(ref, 'app-closing'), ref);
  if (!opened) throw new Error(`상세 열기 실패: ${JSON.stringify(ref)}`);
  await page.waitForSelector('[role="dialog"] .ui-overlay-body');
  await pause(page);
}
async function layout(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const body = dialog.querySelector('.ui-overlay-body');
    const slot = body.querySelector('.detail-body-slot');
    const host = slot?.firstElementChild;
    const view = host?.querySelector(':scope > div:not([hidden])');
    const boxes = [body, slot, host, view].filter(Boolean).map(node => {
      const r = node.getBoundingClientRect(), css = getComputedStyle(node);
      return { className: node.className, top: r.top, bottom: r.bottom, height: r.height,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop,
        display: css.display, direction: css.flexDirection, overflowY: css.overflowY };
    });
    return { title: dialog.querySelector('h2')?.textContent, boxes,
      retainedVisible: host ? [...host.children].filter(node => !node.hidden).length : 0,
      hiddenViews: host ? [...host.children].filter(node => node.hidden).map(node => ({ display: getComputedStyle(node).display, inert: node.inert })) : [] };
  });
}
function layoutIssues(value) {
  const issues = [];
  if (value.boxes.length !== 4 || value.retainedVisible !== 1) issues.push('본문/portal/표시 뷰 경계 누락');
  const body = value.boxes[0];
  for (const box of value.boxes.slice(1)) {
    if (box.height <= 0 || Math.abs(box.height - body.clientHeight) > 1 || box.display !== 'flex' || box.direction !== 'column') issues.push('뷰 높이가 본문에 맞지 않음');
  }
  if (value.hiddenViews.some(view => view.display !== 'none' || !view.inert)) issues.push('보존한 뷰가 레이아웃/접근성에 노출됨');
  return issues;
}
async function gridState(page, gridId) {
  return page.evaluate(gridId => {
    const table = [...document.querySelectorAll('[role="dialog"] [role="grid"]')].find(node => node.getAttribute('aria-labelledby') === `${gridId}-label`);
    if (!table) throw new Error(`표 없음: ${gridId}`);
    const scroller = table.closest('.ui-data-grid__scroll');
    const body = table.closest('.ui-overlay-body');
    const rows = table.querySelectorAll('[data-grid-row]');
    const r = scroller.getBoundingClientRect(), br = body.getBoundingClientRect();
    const header = table.querySelector('thead'), hr = header.getBoundingClientRect();
    const last = rows[rows.length - 1], lr = last?.getBoundingClientRect();
    return { rows: rows.length, lastRowId: last?.getAttribute('data-grid-row'),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, scrollTop: scroller.scrollTop,
      scrollbarWidth: scroller.offsetWidth - scroller.clientWidth,
      top: r.top, bottom: r.bottom, headerTop: hr.top, headerBottom: hr.bottom, headerPosition: getComputedStyle(header).position,
      lastTop: lr?.top, lastBottom: lr?.bottom,
      body: { top: br.top, bottom: br.bottom, scrollTop: body.scrollTop, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight } };
  }, gridId);
}
async function checkGrid(page, target) {
  await open(page, target.ref);
  const scroller = page.locator(`[role="dialog"] [role="grid"][aria-labelledby="${target.gridId}-label"]`).locator('..');
  await scroller.waitFor();
  const before = await gridState(page, target.gridId), issues = [], samples = [];
  if (target.rows && before.rows !== target.rows) issues.push(`행 수 ${before.rows} / 기대 ${target.rows}`);
  if (before.rows < 1 || before.clientHeight <= 0 || before.scrollHeight <= before.clientHeight) issues.push('표 내부에 스크롤 범위가 없음');
  const box = await scroller.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let after = before;
  if (before.scrollHeight > before.clientHeight) for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, Math.max(300, before.clientHeight * 0.85));
    await page.waitForTimeout(50);
    await pause(page);
    after = await gridState(page, target.gridId);
    samples.push({ scrollTop: after.scrollTop, headerTop: after.headerTop, lastBottom: after.lastBottom, bodyScrollTop: after.body.scrollTop });
    if (after.lastBottom <= after.bottom + 1 && after.lastTop >= after.headerBottom - 1) break;
  }
  if (after.scrollTop <= before.scrollTop) issues.push('휠로 표가 움직이지 않음');
  if (after.lastBottom > after.bottom + 1 || after.lastTop < after.headerBottom - 1) issues.push('휠로 마지막 행에 도달하지 못함');
  if (after.headerPosition !== 'sticky' || Math.abs(after.headerTop - before.headerTop) > 1 || Math.abs(after.headerTop - after.top) > 2) issues.push('머리글이 스크롤 상단에 고정되지 않음');
  if (samples.some(sample => Math.abs(sample.headerTop - before.headerTop) > 1 || sample.bodyScrollTop !== before.body.scrollTop)) issues.push('스크롤 도중 머리글/창 본문이 이동함');
  if (after.body.scrollTop !== 0 || after.body.scrollHeight > after.body.clientHeight + 1 || after.top < after.body.top - 1 || after.bottom > after.body.bottom + 1) issues.push('표가 창 본문을 넘치거나 본문 전체가 스크롤됨');
  const result = { ...target, passed: issues.length === 0, before, after, wheelTicks: samples.length, samples, issues };
  await close(page);
  return result;
}
async function checkNaturalOverflow(page) {
  // Stretch real non-grid content in its existing flow. When a widget already has
  // a dedicated scrolling region, put the tall tail there. Remove it after probing.
  const region = await page.evaluate(prepareNaturalOverflow);
  if (!region) return { grid: true };
  const read = () => page.evaluate(() => {
    const region = document.querySelector('[data-detail-check-scroll]'), tail = document.getElementById('detail-check-tail');
    const r = region.getBoundingClientRect(), tr = tail.getBoundingClientRect();
    const body = region.closest('.ui-overlay-body') ?? region, br = body.getBoundingClientRect();
    return { scrollTop: region.scrollTop, scrollHeight: region.scrollHeight, clientHeight: region.clientHeight,
      tailBottom: tr.bottom, bottom: Math.min(r.bottom, br.bottom) };
  });
  const scroller = page.locator('[data-detail-check-scroll]'), box = await scroller.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let after = await read(), ticks = 0;
  for (; ticks < 80 && after.tailBottom > after.bottom + 1; ticks++) {
    await page.mouse.wheel(0, Math.max(400, region.clientHeight));
    await page.waitForTimeout(50); await pause(page); after = await read();
  }
  const result = { ...region, after, wheelTicks: ticks, passed: region.scrollHeight > region.clientHeight && after.scrollTop > 0 && after.tailBottom <= after.bottom + 1 };
  await page.evaluate(() => { document.getElementById('detail-check-tail')?.remove(); document.querySelector('[data-detail-check-scroll]')?.removeAttribute('data-detail-check-scroll'); });
  return result;
}

try {
  rt = await runtime({ classicScrollbars: true }); report.environment = rt.environment;
  for (const preset of ['A', 'B']) for (const scale of [100, 125]) {
    const context = await rt.browser.newContext({ viewport: preset === 'A' ? { width: 1920, height: 1080 } : { width: 2560, height: 1440 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const result = { preset, scale, grids: [], details: [], errors: [] };
    report.configurations.push(result);
    page.on('pageerror', error => result.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') result.errors.push(message.text()); });
    try {
      await page.goto(`${rt.base}/src/screens/detail/detail-body-check.html`);
      await page.waitForSelector('.ui-root');
      await page.evaluate(async () => { window.__rootI5 = (await import('/src/app/dev/i5-root-probe.ts')).attachRootProbe(); });
      await page.getByRole('button', { name: '카페', exact: true }).click();
      await page.getByRole('radio', { name: /선불형/ }).click();
      await emptyStart(page);
      await page.evaluate(scale => { const { run } = window.__rootI5; run.actions.skipWidgetCoaches(); run.actions.acknowledgeBriefing(); run.actions.setTextScale(scale); }, scale);
      await pause(page);
      const actual = await page.evaluate(() => window.__rootI5.run.getState().screenPreset.id);
      if (actual !== preset) throw new Error(`화면 설정 ${actual} / 기대 ${preset}`);
      const ids = await page.evaluate(async () => (await import('/src/features/widgets/registry.ts')).widgetModules.filter(module => module.Detail).map(module => module.id));
      result.detailIds = ids;
      // All actual widget details and their visible tabs, including compact text,
      // fullscreen supply, and the existing marketing/video details.
      for (const featureId of ids) {
        try {
          await open(page, { featureId });
          const tabs = page.locator('[role="dialog"] .detail-module-body [role="tab"]');
          const visited = new Set();
          let checked = false;
          while (true) {
            // Switching a tab can unmount nested tabs. Discover again after each
            // switch so only currently visible, enabled tabs are clicked.
            const next = (await page.evaluate(availableTabs)).find(tab => !visited.has(tab.key));
            if (!next && checked) break;
            if (next) {
              visited.add(next.key);
              await tabs.nth(next.index).click();
              await pause(page);
            }
            const value = await layout(page), issues = layoutIssues(value), overflow = await checkNaturalOverflow(page);
            if (overflow.passed === false) issues.push('긴 비그리드 콘텐츠가 스크롤로 도달되지 않음');
            result.details.push({ featureId, tab: next?.label ?? null, passed: issues.length === 0, layout: value, overflow, issues });
            checked = true;
          }
          await close(page);
        } catch (error) { result.errors.push(`${featureId}: ${error}`); await close(page); }
      }
      // Menu and stock seeds are short; create 50 real rows each through the
      // existing commands in this disposable in-memory root run to force overflow.
      await page.evaluate(() => {
        const { data } = window.__rootI5;
        for (let i = 0; i < 50; i++) {
          for (const command of [
            { type: 'menu.create', name: `검증 메뉴 ${i}`, category: 'drink', price: 4000, idempotencyKey: `detail-menu-${i}` },
            { type: 'inventory.createItem', sku: `검증-${i}`, name: `검증 원자재 ${i}`, unit: 'pcs', stock: 1, threshold: 0, idempotencyKey: `detail-stock-${i}` },
          ]) { const value = data.dispatch(command); if (!value.ok) throw new Error(JSON.stringify(value)); }
        }
      });
      for (const target of [
        { ref: { featureId: 'members', view: 'list' }, gridId: 'members-grid', rows: 126 },
        { ref: { featureId: 'ledger', view: 'sales' }, gridId: 'ledger-payments', rows: 95 },
        { ref: { featureId: 'closing' }, gridId: 'closing-payments', rows: 95 },
        { ref: { featureId: 'menu', view: 'list' }, gridId: 'menu-grid' },
        { ref: { featureId: 'inventory-booking', view: 'materials' }, gridId: 'stock-grid' },
      ]) {
        try { result.grids.push(await checkGrid(page, target)); }
        catch (error) { result.errors.push(`${target.gridId}: ${error}`); await close(page); }
      }
    } catch (error) { result.errors.push(String(error)); }
    finally { await context.close(); }
  }
  report.passed = report.configurations.length === 4 && report.configurations.every(config => config.grids.length === 5 && config.grids.every(grid => grid.passed) && config.details.length > 0 && config.details.every(detail => detail.passed) && config.errors.length === 0);
} catch (error) { report.errors.push(String(error)); }
finally {
  try { await rt?.close(); } catch (error) { report.errors.push(String(error)); }
  if (report.errors.length) report.passed = false;
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
