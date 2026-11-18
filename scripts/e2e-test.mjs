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

  // Landscapes: animation clock frozen so frames are reproducible.
  await page.evaluate(() => window.__ascii.freezeTime(3));
  const scenes = [['m', 'meadow'], ['l', 'lake'], ['v', 'valley']];
  for (const [i, [key, preset]] of scenes.entries()) {
    await step(`landscape ${preset}: renders and matches reference`, async () => {
      await page.keyboard.press(key);
      await waitSettled(`scene-${preset}`);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 100_000 && s.weather.wind > 0);
      assert.ok((await coverage()) > 0.3, 'a landscape fills the frame');
      const name = `${13 + i}-scene-${preset}`;
      await page.screenshot({ path: join(outDir, `${name}.png`) });
      await matchesGolden(name);
    });
  }

  await step('ground and water stay visible from every viewing angle', async () => {
    await page.keyboard.press('l');
    await waitSettled('scene-lake');
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
    await page.screenshot({ path: join(outDir, '16b-lake-from-160deg.png') });
    await covAt(0);
    console.log(`       coverage: front ${(front * 100).toFixed(0)}%, ` + results.map(([d, c]) => `${d}deg ${(c * 100).toFixed(0)}%`).join(', '));
    for (const [deg, c] of results) assert.ok(c > front * 0.6, `at ${deg} degrees only ${(c * 100).toFixed(0)}% drawn (front ${(front * 100).toFixed(0)}%)`);
  });

  await step('player: walks on the ground, never through it, stays out of the lake, collides', async () => {
    // The lake scene is loaded; its camera looks across the water.
    assert.equal(await page.evaluate(() => window.__ascii.play()), true);
    const r = await page.evaluate(() => {
      const a = window.__ascii;
      const out = {};
      // 1. Walk (and run) toward the lake: must stop at the shore.
      out.toLake = a.playSteps({ forward: 1, run: true }, 12);
      // 2. Walk around in several directions over hills.
      out.walks = [0, 1.6, 3.1, 4.7].map((yaw) => a.playSteps({ forward: 1, yaw }, 4));
      // 3. Jump: up, then back down onto the ground.
      const g0 = a.playSteps({}, 0.5);
      const up = a.playSteps({ jump: true }, 0.25);
      const p = a.app.player.physics;
      out.jumpHeight = up.y - p.height(up.x, up.z);
      out.landed = a.playSteps({}, 2);
      out.landedClearance = out.landed.y - p.height(out.landed.x, out.landed.z);
      // 4. Walk straight into the nearest collider (trunk / rock).
      const s = a.app.player.state;
      const c = p.ground.world.colliders;
      let best = -1, bd = Infinity;
      for (let i = 0; i < c.length; i += 4) {
        const d = Math.hypot(c[i] - s.x, c[i + 1] - s.z);
        if (d < bd && d > c[i + 2] + 1 && c[i + 3] > s.y + 2) { bd = d; best = i; }
      }
      if (best >= 0) {
        // Teleport next to it on dry land, then walk into it.
        s.x = c[best] + (c[best + 2] + 2.5); s.z = c[best + 1]; s.y = p.height(s.x, s.z); s.vx = s.vy = s.vz = 0;
        const yaw = Math.atan2(-(c[best] - s.x), -(c[best + 1] - s.z));
        a.playSteps({ forward: 1, yaw }, 3);
        out.gap = Math.hypot(s.x - c[best], s.z - c[best + 1]) - c[best + 2];
      }
      out.minClearance = Math.min(out.toLake.minClearance, ...out.walks.map((w) => w.minClearance), out.landed.minClearance);
      out.inWater = out.toLake.inWater || out.walks.some((w) => w.inWater);
      return out;
    });
    console.log(`       to lake moved ${r.toLake.moved.toFixed(1)} m, walks ${r.walks.map((w) => w.moved.toFixed(1)).join('/')} m, ` +
      `jump ${r.jumpHeight.toFixed(2)} m, min clearance ${r.minClearance.toFixed(4)} m, gap to collider ${r.gap?.toFixed(2)} m`);
    assert.ok(r.minClearance >= -1e-3, 'the player went below the ground');
    assert.equal(r.inWater, false, 'the player walked into the lake');
    assert.ok(r.walks.some((w) => w.moved > 5), 'the player should be able to walk');
    assert.ok(r.jumpHeight > 0.5, 'jumping lifts the player');
    assert.ok(Math.abs(r.landedClearance) < 1e-3, 'the player lands back on the ground');
    assert.ok(r.gap !== undefined && r.gap > 0.3, 'the player walked through a trunk or rock');
    await page.screenshot({ path: join(outDir, '16c-first-person.png') });
    await page.evaluate(() => window.__ascii.stopPlaying());
  });

  await step('infinite world: streams chunks, travels, walkable everywhere', async () => {
    await page.keyboard.press('i');
    await waitSettled('world');
    const loadedAtLeast = (n) => page.waitForFunction((n) => { const s = window.__ascii.worldStats(); return s && s.loaded >= n; }, { timeout: 900_000, polling: 1000 }, n);
    await loadedAtLeast(12);
    assert.ok((await coverage()) > 0.3, 'the world fills the view');
    await page.screenshot({ path: join(outDir, '16d-world.png') });
    // Travel 400 m and check new chunks arrive there and can be walked on.
    await page.evaluate(() => { const v = window.__ascii.app.viewer; v.camera.position.x += 400; v.controls.target.x += 400; v.controls.update(); });
    const before = (await page.evaluate(() => window.__ascii.worldStats())).built;
    await page.waitForFunction((b) => window.__ascii.worldStats().built >= b + 9, { timeout: 900_000, polling: 1000 }, before);
    assert.equal(await page.evaluate(() => window.__ascii.play()), true);
    const r = await page.evaluate(() => window.__ascii.playSteps({ forward: 1 }, 2));
    assert.ok(r.minClearance >= -1e-3 && !r.inWater, 'walks on the streamed ground');
    await page.evaluate(() => window.__ascii.stopPlaying());
    await page.keyboard.press('l');
    await waitSettled('scene-lake');
  });

  await step('wind moves the scene over time; calm air does not', async () => {
    const at = (t) => page.evaluate((t) => { window.__ascii.freezeTime(t); return window.__ascii.thumbnail(); }, t);
    const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0.85, leaves: 0, rain: 0 }));
    const windy = diff(await at(1), await at(2.5));
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0, leaves: 0, rain: 0 }));
    const calm = diff(await at(1), await at(2.5));
    console.log(`       frame change: windy ${windy.toFixed(2)}, calm ${calm.toFixed(2)} (only water moves)`);
    assert.ok(windy > calm * 1.5 && windy > 0.3, 'wind should visibly move grass and leaves');
  });

  await step('rain and blowing leaves show up and switch off again', async () => {
    await page.evaluate(() => window.__ascii.freezeTime(3));
    const base = await page.evaluate(() => window.__ascii.thumbnail());
    await page.evaluate(() => window.__ascii.setEnvironment({ rain: 1, wind: 0.6, leaves: 1 }));
    const wet = await page.evaluate(() => window.__ascii.thumbnail());
    await page.screenshot({ path: join(outDir, '16-valley-rain.png') });
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
