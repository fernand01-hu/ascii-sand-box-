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
// Key 6-9 galleries are numbered after the five model screenshots.

const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!chrome) {
  console.error('No Chrome found. Set CHROME_PATH to run the e2e test.');
  process.exit(1);
}

const server = await preview({ configFile: join(root, 'vite.config.ts'), preview: { port: 4317, strictPort: false }, logLevel: 'warn' });
const url = server.resolvedUrls.local[0];
const browser = await puppeteer.launch({
  protocolTimeout: 600_000, // software-rendering big landscapes is slow
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
    } finally {
      // Never leave play mode on: it swallows the keys the next steps press.
      await page.evaluate(() => window.__ascii?.stopPlaying?.()).catch(() => {});
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

  const chunksLoaded = (n) => page.waitForFunction((n) => { const s = window.__ascii.worldStats(); return s && s.loaded >= n && s.pending === 0; },
    { timeout: 900_000, polling: 1000 }, n);

  await step('opens on the blank canvas: rows of # under the sky, matches reference', async () => {
    await waitSettled('canvas');
    await page.evaluate(() => window.__ascii.freezeTime(3));
    await chunksLoaded(12);
    const s = await state();
    assert.equal(s.status, 'ready', s.error ?? '');
    assert.ok(s.weather.wind > 0, 'the canvas starts with a breeze');
    assert.ok((await coverage()) > 0.3, 'ground and sky fill the frame');
    await page.screenshot({ path: join(outDir, '13-canvas.png') });
    await matchesGolden('13-canvas');
    await page.evaluate(() => window.__ascii.freezeTime(null));
  });

  await step('canvas edits: paint and place objects, only the touched chunks rebuild', async () => {
    await page.evaluate(() => window.__ascii.freezeTime(3));
    const before = await page.evaluate(() => window.__ascii.worldStats());
    // The camera stands at (0, 7, 0) looking toward -z.
    const touched = await page.evaluate(() => {
      const a = window.__ascii;
      const keys = new Set([
        ...a.paintRect(-14, -44, 14, -14, 'grass'),
        ...a.paintRect(-10, -40, -2, -30, 'water'),
        ...a.paintCircle(6, -20, 3, 'sand'),
        ...a.paintRect(-14, -16, 14, -14, 'rock'),
      ]);
      window.__edits = [
        a.addObject({ kind: 'tree:oak', x: 0.4, z: -30, seed: 3 }), // trunk in chunk (0, -1), crown over (-1, -1)
        a.addObject({ kind: 'tree:pine', x: 9, z: -38, seed: 5 }),
        a.addObject({ kind: 'rock:boulder', x: -5, z: -20, seed: 2, scale: 1.5 }),
        a.addObject({ kind: 'bush:juniper', x: 4, z: -18, seed: 1 }),
      ];
      return keys.size;
    });
    await page.waitForFunction((b, n) => { const s = window.__ascii.worldStats(); return s.editBuilds >= b + n && s.dirty === 0 && s.pending === 0; },
      { timeout: 300_000, polling: 500 }, before.editBuilds, touched);
    const after = await page.evaluate(() => window.__ascii.worldStats());
    console.log(`       ${touched} chunks touched, ${after.editBuilds - before.editBuilds} edit rebuilds, ${after.viewBuilds - before.viewBuilds} other rebuilds, ${after.edited} chunks hold edits`);
    assert.equal(after.objects, 4);
    assert.equal(after.viewBuilds, before.viewBuilds, 'no other loaded chunk was rebuilt');
    assert.equal(after.editBuilds - before.editBuilds, touched, 'one rebuild per touched chunk');
    await page.screenshot({ path: join(outDir, '13b-canvas-edits.png') });
    await matchesGolden('13b-canvas-edits');
    // Undo it all: the map is empty again and stores nothing.
    const left = await page.evaluate(() => {
      const a = window.__ascii;
      for (const o of window.__edits) a.removeObject(o.id);
      a.paintRect(-14, -44, 14, -14, 'canvas');
      return a.worldStats();
    });
    assert.equal(left.edited, 0, 'erased chunks are not stored');
    assert.equal(left.objects, 0);
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    await page.evaluate(() => window.__ascii.freezeTime(null));
  });

  await step('debug terminal: opens with `, runs commands, keeps keys away from hotkeys, perf overlay', async () => {
    const logText = () => page.evaluate(() => document.querySelector('.tui-terminal .tui-log').textContent);
    const type = async (line) => {
      await page.keyboard.type(line);
      await page.keyboard.press('Enter');
      await page.waitForFunction((l) => document.querySelector('.tui-terminal .tui-log').textContent.includes(`> ${l}`), {}, line);
      await new Promise((r) => setTimeout(r, 100));
    };
    await page.keyboard.press('Backquote');
    assert.equal(await page.evaluate(() => !document.querySelector('.tui-terminal').hidden), true, 'terminal opens');
    assert.equal(await page.evaluate(() => document.activeElement?.closest('.tui-terminal') !== null), true, 'prompt has focus');
    await type('help');
    assert.match(await logText(), /paint <ground> <x> <z> <radius>/);
    // Typing 9 (a gallery hotkey) and c must stay in the terminal.
    await type('view 4');
    assert.equal(await page.evaluate(() => window.__ascii.app.viewRadius), 4);
    assert.equal((await state()).model, 'canvas', 'hotkeys did not fire while typing');
    await type('wind 0.6');
    assert.equal((await state()).weather.wind, 0.6);
    await type('paint grass 0 -20 4');
    await type('place tree:oak 0 -25 1 7');
    let s = await page.evaluate(() => window.__ascii.worldStats());
    assert.equal(s.objects, 1);
    assert.ok(s.edited >= 1);
    await type('bogus');
    assert.match(await logText(), /unknown command "bogus"/);
    await type('place tree:palm 0 0');
    assert.match(await logText(), /unknown kind "tree:palm"/);
    // Tab completes command names and kinds.
    await page.keyboard.type('pla');
    await page.keyboard.press('Tab');
    await page.keyboard.type('tree:o');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('.tui-terminal input').value), 'place tree:oak ');
    await page.evaluate(() => { document.querySelector('.tui-terminal input').value = ''; });
    // Console output shows up in the log.
    await page.evaluate(() => console.info('[ascii] hello from the console'));
    assert.match(await logText(), /hello from the console/);
    await type('perf on');
    await page.waitForFunction(() => /cards .* drawn/.test(document.querySelector('.tui-perf').textContent));
    const perf = await page.evaluate(() => document.querySelector('.tui-perf').textContent);
    console.log(`       perf: ${perf.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | ')}`);
    assert.match(perf, /chunks\s+\d+ loaded/);
    await page.screenshot({ path: join(outDir, '13c-terminal.png') });
    await type('perf off');
    // Clean up through the terminal too, then close with Esc.
    const id = (await page.evaluate(() => window.__ascii.app.map.allObjects()[0].id));
    await type(`remove ${id}`);
    await type('paint canvas 0 -20 4');
    await type('view 9');
    await type('wind 0.3');
    s = await page.evaluate(() => window.__ascii.worldStats());
    assert.equal(s.objects, 0);
    assert.equal(s.edited, 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.querySelector('.tui-terminal').hidden), true, 'Esc closes it');
    assert.deepEqual(await page.evaluate(() => window.__ascii.run('pos')).then((l) => l.length), 1, 'run() returns the printed lines');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
  });

  const models = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];
  for (const [i, model] of models.entries()) {
    await step(`model ${model}: renders, readable, matches reference`, async () => {
      await page.keyboard.press(String(i + 1));
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

  for (const [i, category] of ['rocks', 'plants', 'bushes', 'trees'].entries()) {
    await step(`scenery gallery ${category}: renders and matches reference`, async () => {
      await page.keyboard.press(String(6 + i));
      await waitSettled(`gallery-${category}`);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 10_000);
      assert.ok((await coverage()) > 0.1);
      const name = `${6 + i}-gallery-${category}`;
      await page.screenshot({ path: join(outDir, `${name}.png`) });
      await matchesGolden(name);
    });
  }

  await step('the canvas stays visible from every viewing angle', async () => {
    await page.keyboard.press('c');
    await waitSettled('canvas');
    await chunksLoaded(12);
    // Orbit round the focus; flat-lying glyphs must not vanish edge-on.
    const covAt = (deg) => page.evaluate((deg) => {
      const v = window.__ascii.app.viewer;
      const t = v.controls.target;
      if (!window.__home) window.__home = v.camera.position.clone();
      const off = window.__home.clone().sub(t);
      const a = (deg * Math.PI) / 180;
      v.camera.position.set(t.x + off.x * Math.cos(a) + off.z * Math.sin(a), t.y + off.y, t.z - off.x * Math.sin(a) + off.z * Math.cos(a));
      v.controls.update();
      return window.__ascii.coverage();
    }, deg);
    const front = await covAt(0);
    const results = [];
    for (const deg of [60, 120, 160, 220, 300]) results.push([deg, await covAt(deg)]);
    await covAt(160);
    await page.screenshot({ path: join(outDir, '16b-canvas-from-160deg.png') });
    await covAt(0);
    console.log(`       coverage: front ${(front * 100).toFixed(0)}%, ` + results.map(([d, c]) => `${d}deg ${(c * 100).toFixed(0)}%`).join(', '));
    for (const [deg, c] of results) assert.ok(c > front * 0.6, `at ${deg} degrees only ${(c * 100).toFixed(0)}% drawn (front ${(front * 100).toFixed(0)}%)`);
  });

  await step('canvas: streams new chunks as the camera travels', async () => {
    await page.evaluate(() => { const v = window.__ascii.app.viewer; v.camera.position.x += 400; v.controls.target.x += 400; v.controls.update(); });
    const before = (await page.evaluate(() => window.__ascii.worldStats())).built;
    await page.waitForFunction((b) => window.__ascii.worldStats().built >= b + 9, { timeout: 900_000, polling: 1000 }, before);
    await chunksLoaded(12);
    assert.ok((await coverage()) > 0.3, 'the canvas fills the view far from the start');
    await page.screenshot({ path: join(outDir, '16d-canvas-travelled.png') });
    await page.keyboard.press('c');
    await waitSettled('canvas');
    await chunksLoaded(12);
  });

  await step('wind carries leaves across the canvas; calm air does not', async () => {
    // Leaves fly round the camera's height: look from eye level, fixed (no damping drift).
    await page.evaluate(() => {
      const v = window.__ascii.app.viewer;
      v.controls.enableDamping = false;
      v.camera.position.set(0, 2, 0);
      v.controls.target.set(0, 1.6, -20);
      v.controls.update();
    });
    const at = (t) => page.evaluate((t) => { window.__ascii.freezeTime(t); return window.__ascii.thumbnail(); }, t);
    const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    const change = async () => {
      let sum = 0;
      for (const t of [1, 2, 3, 4]) sum += diff(await at(t), await at(t + 0.75));
      return sum;
    };
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0.85, leaves: 1, rain: 0 }));
    const windy = await change();
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0, leaves: 0, rain: 0 }));
    const calm = await change();
    await page.evaluate(() => { window.__ascii.app.viewer.controls.enableDamping = true; });
    console.log(`       frame change: windy ${windy.toFixed(2)}, calm ${calm.toFixed(2)}`);
    assert.ok(windy > calm * 1.5 && windy > 0.2, 'wind should visibly carry the leaves');
  });

  await step('rain and blowing leaves show up and switch off again', async () => {
    await page.evaluate(() => window.__ascii.freezeTime(3));
    const base = await page.evaluate(() => window.__ascii.thumbnail());
    await page.evaluate(() => window.__ascii.setEnvironment({ rain: 1, wind: 0.6, leaves: 1 }));
    const wet = await page.evaluate(() => window.__ascii.thumbnail());
    await page.screenshot({ path: join(outDir, '16-canvas-rain.png') });
    const d = wet.reduce((s, v, i) => s + Math.abs(v - base[i]), 0) / wet.length;
    assert.ok(d > 2, `rain should change the picture (diff ${d.toFixed(2)})`);
    await page.evaluate(() => window.__ascii.setEnvironment({ rain: 0, wind: 0, leaves: 0 }));
    const dry = await page.evaluate(() => window.__ascii.thumbnail());
    const back = dry.reduce((s, v, i) => s + Math.abs(v - base[i]), 0) / dry.length;
    assert.ok(back < d / 3, 'switching it off restores the scene');
    await page.evaluate(() => window.__ascii.freezeTime(null));
  });

  await step('orbiting round the trees keeps them solid and readable', async () => {
    await page.keyboard.press('9');
    await waitSettled('gallery-trees');
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(820, 380, { steps: 16 });
    await page.mouse.up();
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok((await coverage()) > 0.1);
    await page.screenshot({ path: join(outDir, '17-trees-orbited.png') });
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
    await page.screenshot({ path: join(outDir, '10-orbited.png') });
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
    await page.screenshot({ path: join(outDir, '11-closeup.png') });
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
    await page.screenshot({ path: join(outDir, '12-narrow.png') });
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
