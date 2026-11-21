// Manual browser check; runtime starts its own isolated Vite server and Chrome.
import { runtime } from '../features/widgets/dev/i5/runtime.mjs';

const paths = [
  '/src/app/closing-content-check.html',
  '/src/screens/briefing/dev/index.html',
  '/src/screens/dashboard/dev/coach.html',
  '/src/screens/dashboard/dev/index.html',
  '/src/screens/detail/detail-body-check.html',
  '/src/screens/detail/dev/v4.html',
];
const report = { passed: false, pages: [] };
let rt;
try {
  rt = await runtime();
  for (const path of paths) {
    const context = await rt.browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('requestfailed', request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    const response = await page.goto(`${rt.base}${path}`, { waitUntil: 'networkidle' });
    const icon = await page.evaluate(async () => {
      const link = document.head.querySelector('link[rel~="icon"]');
      if (!link) return null;
      const response = await fetch(link.href);
      return { href: new URL(link.href).pathname, type: link.type, status: response.status, contentType: response.headers.get('content-type') };
    });
    const passed = response?.status() === 200 && icon?.href === '/src/assets/brand/navis-symbol.svg' && icon.type === 'image/svg+xml' && icon.status === 200 && icon.contentType?.includes('image/svg+xml') && errors.length === 0;
    report.pages.push({ path, status: response?.status(), icon, errors, passed: Boolean(passed) });
    await context.close();
  }
  report.passed = report.pages.length === paths.length && report.pages.every(page => page.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await rt?.close();
  console.log(JSON.stringify(report, null, 2));
}
