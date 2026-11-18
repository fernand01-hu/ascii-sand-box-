// End-to-end check in a real (headless) Chrome against the production build:
// loads every model, orbits with the mouse, feeds a broken file, and checks
// that pixels are actually drawn and no errors are logged.
//
//   npm run build && node scripts/e2e-test.mjs
//   CHROME_PATH=/path/to/chrome node scripts/e2e-test.mjs
//
// Screenshots go to test-results/.

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-results');
mkdirSync(outDir, { recursive: true });

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('No Chrome found. Set CHROME_PATH to run the e2e test.');
  process.exit(1);
}

const server = await preview({ configFile: join(root, 'vite.config.ts'), preview: { port: 4317, strictPort: false }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  // Software WebGL so the test runs on machines without a GPU.
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800 },
});

const problems = [];
let failures = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || (m.type() === 'warning' && !m.text().includes('could not load broken.stl')
      && !/GPU stall|Automatic fallback to software WebGL/.test(m.text()))) problems.push(`[${m.type()}] ${m.text()}`);
    if (m.text().startsWith('[ascii]')) console.log(`       ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));

  const waitSettled = (model) => page.waitForFunction(
    (m) => window.__ascii && window.__ascii.model === m && window.__ascii.status !== 'loading', { timeout: 60_000 }, model);
  const state = () => page.evaluate(() => {
    const { loadBytes, loadModel, coverage, ...s } = window.__ascii;
    return s;
  });

  const step = async (name, fn) => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL ${name}\n       ${e.message}`);
    }
  };

  await page.goto(url, { waitUntil: 'load' });

  const models = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];
  for (const [i, model] of models.entries()) {
    await step(`model ${model} renders`, async () => {
      if (i > 0) await page.keyboard.press(String(i + 1));
      await waitSettled(model);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 0 && s.triangles > 0);
      const cov = await page.evaluate(() => window.__ascii.coverage());
      assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn`);
      await page.screenshot({ path: join(outDir, `${i + 1}-${model.replace('.stl', '')}.png`) });
    });
  }

  await step('mouse orbit and zoom keep rendering', async () => {
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(700, 300, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel({ deltaY: -300 });
    await new Promise((r) => setTimeout(r, 1200)); // let damping settle
    const cov = await page.evaluate(() => window.__ascii.coverage());
    assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn after orbit`);
    await page.screenshot({ path: join(outDir, '5-orbited.png') });
  });

  await step('zooming all the way in never puts the camera inside the model', async () => {
    await page.keyboard.press('2');
    await waitSettled('sphere.stl');
    await page.mouse.move(500, 400);
    for (let k = 0; k < 15; k++) {
      await page.mouse.wheel({ deltaY: -300 });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const cov = await page.evaluate(() => window.__ascii.coverage());
    assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn at full zoom`);
    await page.screenshot({ path: join(outDir, '6-closeup.png') });
  });

  await step('broken file reports an error and keeps the old model on screen', async () => {
    await page.evaluate(() => window.__ascii.loadBytes(new TextEncoder().encode('solid broken\nvertex 1 2\n').buffer, 'broken.stl'));
    const s = await state();
    assert.equal(s.status, 'error');
    assert.match(s.error, /ASCII STL/);
    const cov = await page.evaluate(() => window.__ascii.coverage());
    assert.ok(cov > 0.03, 'previous model should still be visible');
  });

  await step('engine recovers after the error', async () => {
    await page.keyboard.press('1');
    await waitSettled('torus-knot.stl');
    assert.equal((await state()).status, 'ready');
  });

  await step('rapid model switching ends on the last request', async () => {
    for (const k of ['2', '3', '4', '2', '3']) await page.keyboard.press(k);
    await waitSettled('ziggurat.stl');
    await new Promise((r) => setTimeout(r, 500));
    const s = await state();
    assert.equal(s.model, 'ziggurat.stl');
    assert.equal(s.status, 'ready');
  });

  await step('resize keeps rendering', async () => {
    await page.setViewport({ width: 420, height: 760 });
    await new Promise((r) => setTimeout(r, 300));
    const cov = await page.evaluate(() => window.__ascii.coverage());
    assert.ok(cov > 0.03);
    await page.screenshot({ path: join(outDir, '7-narrow.png') });
  });

  await step('no errors or warnings in the console', async () => {
    assert.deepEqual(problems, []);
  });
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}

if (failures) {
  console.log(`\n${failures} e2e step(s) failed`);
  process.exit(1);
}
console.log(`\nall e2e checks passed (screenshots in test-results/)`);
