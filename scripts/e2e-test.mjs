// End-to-end check in a real (headless) Chrome against the test build
// (`npm run build:test`): loads every model and the testbed pine, compares
// each against a reference image, checks glyphs are big enough to read,
// orbits with the mouse, feeds a broken file, switches models rapidly, and
// requires a clean console.
//
//   npm run build:test && node scripts/e2e-test.mjs
//   UPDATE_GOLDEN=1 node scripts/e2e-test.mjs   # accept the current look as the new reference
//   CHROME_PATH=/path/to/chrome node scripts/e2e-test.mjs
//
// Screenshots go to test-results/, reference thumbnails live in tests/golden/.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-results');
const goldenDir = join(root, 'tests', 'golden');
mkdirSync(outDir, { recursive: true });
mkdirSync(goldenDir, { recursive: true });
const UPDATE = process.env.UPDATE_GOLDEN === '1';
/** Allowed mean per-channel difference (0-255) over non-background tiles. */
const GOLDEN_TOLERANCE = 1.5; // unchanged builds measure 0.00
/** Smallest acceptable on-screen glyph height at the default framing (CSS px). */
const MIN_GLYPH_PX = 8;

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
  // Software WebGL: runs without a GPU and renders the same pixels every run.
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800 },
});

const problems = [];
let failures = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    const expected = t.includes('could not load broken.stl') || /GPU stall|Automatic fallback to software WebGL/.test(t);
    if ((m.type() === 'error' || m.type() === 'warning') && !expected) problems.push(`[${m.type()}] ${t}`);
    if (t.startsWith('[ascii]')) console.log(`       ${t}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));

  const waitSettled = (model) => page.waitForFunction(
    (m) => window.__ascii && window.__ascii.model === m && window.__ascii.status !== 'loading', { timeout: 60_000 }, model);
  const state = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__ascii)));
  const coverage = () => page.evaluate(() => window.__ascii.coverage());

  const step = async (name, fn) => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL ${name}\n       ${e.message}`);
    }
  };

  /** Compare the current frame to tests/golden/<name>.json. */
  const matchesGolden = async (name) => {
    const thumb = await page.evaluate(() => window.__ascii.thumbnail());
    const file = join(goldenDir, `${name}.json`);
    if (UPDATE) {
      writeFileSync(file, JSON.stringify({ w: 48, h: 36, data: thumb }) + '\n');
      return;
    }
    if (!existsSync(file)) throw new Error(`no reference image for ${name}; run with UPDATE_GOLDEN=1 after checking test-results/`);
    const ref = JSON.parse(readFileSync(file, 'utf8')).data;
    assert.equal(ref.length, thumb.length, 'reference thumbnail has a different size');
    const diff = contentDiff(thumb, ref);
    console.log(`       ${name}: diff ${diff.toFixed(2)} vs reference`);
    assert.ok(diff <= GOLDEN_TOLERANCE, `looks different from the reference (diff ${diff.toFixed(2)} > ${GOLDEN_TOLERANCE}); ` +
      `check test-results/ and run with UPDATE_GOLDEN=1 if the change is intended`);
  };

  /**
   * Mean absolute per-channel difference over the tiles where either image
   * shows something (not plain background). Averaging over the whole frame
   * would let mostly-empty frames hide real changes.
   */
  const contentDiff = (a, b) => {
    const bg = [9, 12, 19];
    let sum = 0;
    let n = 0;
    for (let t = 0; t < a.length; t += 3) {
      const content = [0, 1, 2].some((k) => Math.abs(a[t + k] - bg[k]) > 6 || Math.abs(b[t + k] - bg[k]) > 6);
      if (!content) continue;
      for (let k = 0; k < 3; k++) sum += Math.abs(a[t + k] - b[t + k]);
      n += 3;
    }
    return n ? sum / n : 0;
  };

  await page.goto(url, { waitUntil: 'load' });

  const models = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];
  for (const [i, model] of models.entries()) {
    await step(`model ${model}: renders, readable, matches reference`, async () => {
      if (i > 0) await page.keyboard.press(String(i + 1)); // the torus knot is the opening scene
      await waitSettled(model);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 0 && s.triangles > 0);
      assert.ok(s.glyphPx >= MIN_GLYPH_PX, `glyphs are ${s.glyphPx.toFixed(1)} px tall, too small to read`);
      const cov = await coverage();
      assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn`);
      const name = `${i + 1}-${model.replace('.stl', '')}`;
      await page.screenshot({ path: join(outDir, `${name}.png`) });
      await matchesGolden(name);
    });
  }

  await step('testbed pine: renders and matches reference', async () => {
    await page.keyboard.press('5');
    await waitSettled('procedural-pine');
    const s = await state();
    assert.equal(s.status, 'ready', s.error ?? '');
    assert.ok(s.cards > 50_000);
    assert.ok((await coverage()) > 0.05);
    await page.screenshot({ path: join(outDir, '5-testbed-pine.png') });
    await matchesGolden('5-testbed-pine');
  });

  await step('mouse orbit and zoom keep rendering', async () => {
    await page.keyboard.press('1');
    await waitSettled('torus-knot.stl');
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(700, 300, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel({ deltaY: -300 });
    await new Promise((r) => setTimeout(r, 1200)); // let damping settle
    const cov = await coverage();
    assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn after orbit`);
    await page.screenshot({ path: join(outDir, '6-orbited.png') });
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
    const cov = await coverage();
    assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn at full zoom`);
    await page.screenshot({ path: join(outDir, '7-closeup.png') });
  });

  await step('broken file reports an error and keeps the old model on screen', async () => {
    await page.evaluate(() => window.__ascii.loadBytes(new TextEncoder().encode('solid broken\nvertex 1 2\n').buffer, 'broken.stl'));
    const s = await state();
    assert.equal(s.status, 'error');
    assert.match(s.error, /ASCII STL/);
    assert.ok((await coverage()) > 0.03, 'previous model should still be visible');
  });

  await step('engine recovers after the error', async () => {
    await page.keyboard.press('1');
    await waitSettled('torus-knot.stl');
    assert.equal((await state()).status, 'ready');
  });

  await step('rapid switching: only the last request is built', async () => {
    const before = (await state()).skipped;
    for (const k of ['2', '3', '4', '5', '2', '3']) await page.keyboard.press(k);
    await waitSettled('ziggurat.stl');
    await new Promise((r) => setTimeout(r, 500));
    const s = await state();
    assert.equal(s.model, 'ziggurat.stl');
    assert.equal(s.status, 'ready');
    assert.ok(s.skipped > before, 'the worker should have skipped superseded requests');
    console.log(`       ${s.skipped - before} of 6 requests skipped`);
  });

  await step('resize keeps rendering', async () => {
    await page.setViewport({ width: 420, height: 760 });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await coverage()) > 0.03);
    await page.screenshot({ path: join(outDir, '8-narrow.png') });
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
console.log(`\nall e2e checks passed (screenshots in test-results/${UPDATE ? ', reference images updated' : ''})`);
