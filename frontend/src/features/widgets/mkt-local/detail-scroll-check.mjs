// Run outside the sandbox: actual dialog, real wheel input, and a tall test tail.
import { runtime } from '../dev/i5/runtime.mjs';
import { emptyStart } from '../dev/i5/walkthrough-support.mjs';

const ids = ['local-changes', 'trade-area', 'local-trends', 'ai-response', 'community',
  'slot-coupon', 'expiry-coupon', 'coupon-status', 'customer-groups', 'promo-video', 'marketing-performance'];
const report = { passed: false, configurations: [], errors: [] };
let rt;
const pause = page => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

async function check(page, region) {
  const before = await page.evaluate(region => {
    const body = document.querySelector('[role="dialog"] .ui-overlay-body');
    const root = body.querySelector('.detail-module-body').firstElementChild;
    const scroller = region === 'body' ? body : root.querySelector(region);
    if (!scroller) throw new Error(`스크롤 영역 없음: ${region}`);
    const tail = document.createElement('div');
    tail.id = 'marketing-scroll-tail';
    tail.lang = 'ko';
    tail.textContent = '상세 본문 마지막 내용';
    tail.style.cssText = `min-height:${body.clientHeight * 2}px;flex-shrink:0;grid-column:1 / -1`;
    (region === 'body' ? root : scroller).append(tail);
    scroller.setAttribute('data-marketing-scroll-check', '');
    scroller.scrollTop = 0;
    return { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, region };
  }, region);
  const locator = page.locator('[data-marketing-scroll-check]');
  const box = await locator.boundingBox();
  if (!box || box.height <= 0) throw new Error(`크기가 없는 스크롤 영역: ${region}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const read = () => page.evaluate(() => {
    const scroller = document.querySelector('[data-marketing-scroll-check]');
    const body = document.querySelector('[role="dialog"] .ui-overlay-body');
    const tail = document.getElementById('marketing-scroll-tail');
    return { scrollTop: scroller.scrollTop, tailBottom: tail.getBoundingClientRect().bottom,
      visibleBottom: Math.min(scroller.getBoundingClientRect().bottom, body.getBoundingClientRect().bottom) };
  });
  let after = await read(), ticks = 0;
  for (; ticks < 40 && after.tailBottom > after.visibleBottom + 1; ticks++) {
    await page.mouse.wheel(0, Math.max(400, before.clientHeight));
    await page.waitForTimeout(50);
    await pause(page);
    after = await read();
  }
  await page.evaluate(() => {
    document.getElementById('marketing-scroll-tail')?.remove();
    document.querySelector('[data-marketing-scroll-check]')?.removeAttribute('data-marketing-scroll-check');
  });
  return { ...before, after, wheelTicks: ticks, passed: before.scrollHeight > before.clientHeight && after.scrollTop > 0 && after.tailBottom <= after.visibleBottom + 1 };
}

try {
  rt = await runtime({ classicScrollbars: true });
  report.environment = rt.environment;
  for (const preset of ['A', 'B']) for (const scale of [100, 125]) {
    const context = await rt.browser.newContext({ viewport: preset === 'A' ? { width: 1920, height: 1080 } : { width: 2560, height: 1440 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const result = { preset, scale, details: [], errors: [] };
    report.configurations.push(result);
    page.on('pageerror', error => result.errors.push(String(error)));
    try {
      await page.goto(`${rt.base}/src/features/widgets/mkt-local/detail-scroll-check.html`);
      await page.waitForSelector('.ui-root');
      await page.evaluate(async () => { window.__rootI5 = (await import('/src/app/dev/i5-root-probe.ts')).attachRootProbe(); });
      await page.getByRole('button', { name: '카페', exact: true }).click();
      await page.getByRole('radio', { name: /선불형/ }).click();
      await emptyStart(page);
      await page.evaluate(scale => { const { run } = window.__rootI5; run.actions.skipWidgetCoaches(); run.actions.acknowledgeBriefing(); run.actions.setTextScale(scale); }, scale);
      await pause(page);
      for (const featureId of ids) {
        try {
          const opened = await page.evaluate(featureId => window.__rootI5.run.actions.openDetailRef({ featureId }, 'app-closing'), featureId);
          if (!opened) throw new Error(`상세 열기 실패: ${featureId}`);
          await page.waitForSelector('[role="dialog"] .detail-module-body');
          await pause(page);
          const regions = featureId === 'trade-area' ? ['.mkt-hours', 'body'] : featureId === 'promo-video' ? ['.pv-body', 'body'] : ['body'];
          for (const region of regions) result.details.push({ featureId, ...(await check(page, region)) });
        } catch (error) { result.errors.push(`${featureId}: ${String(error)}`); }
        finally {
          await page.evaluate(() => window.__rootI5.run.actions.closeOverlay('button'));
          await page.waitForSelector('[role="dialog"]', { state: 'hidden' });
          await page.waitForSelector('[data-testid="ui-overlay-exit"]', { state: 'hidden' });
        }
      }
    } catch (error) { result.errors.push(String(error)); }
    finally { await context.close(); }
  }
  report.passed = report.configurations.length === 4 && report.configurations.every(config => config.details.length === 13 && config.details.every(detail => detail.passed) && config.errors.length === 0);
} catch (error) { report.errors.push(String(error)); }
finally {
  try { await rt?.close(); } catch (error) { report.errors.push(String(error)); }
  if (report.errors.length) report.passed = false;
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
