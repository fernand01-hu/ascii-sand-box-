// End-to-end check of the web build in a real (headless) Chrome with WebGPU,
// against the test build (`npm run build:test`). The web app is the same Rust
// app as the desktop one (native/app), so this checks what only the browser
// adds: start-up on WebGPU, building in Web Workers, keys, mouse, dropped
// files, resizing, a clean console, and that frames match the references the
// native `ascii-scene golden` tool checks too.
//
//   npm run build:test && node scripts/e2e-test.mjs
//   CHROME_PATH=/path/to/chrome node scripts/e2e-test.mjs
//   E2E_BROWSER_URL=http://127.0.0.1:9222 E2E_URL=http://host/ node scripts/e2e-test.mjs
//       drive an already running Chrome (remote debugging) on a page served
//       elsewhere, e.g. a machine with a GPU: minutes instead of half an hour
//       of software rendering.
//
// Frames are read back by the app itself (`window.__ascii`, web/src/hooks.ts):
// headless Chrome does not composite WebGPU canvases on every system.
// Screenshots go to test-results/. Reference thumbnails live in tests/golden/
// and are written by `ascii-scene golden tests/golden OUT --update`.

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
/** Allowed mean per-channel difference (0-255) over non-background tiles. */
const GOLDEN_TOLERANCE = 2.5; // GPU drivers differ slightly (per-card hash, blending)
const SIZE = { width: 1000, height: 800 };

const remote = process.env.E2E_BROWSER_URL;
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && existsSync(p));
if (!chrome && !remote) {
  console.error('No Chrome found. Set CHROME_PATH to run the e2e test.');
  process.exit(1);
}

const server = process.env.E2E_URL ? null : await preview({ configFile: join(root, 'vite.config.ts'), preview: { port: 4317, strictPort: false }, logLevel: 'warn' });
const url = process.env.E2E_URL ?? server.resolvedUrls.local[0];
const browser = remote ? await puppeteer.connect({ browserURL: remote, defaultViewport: SIZE, protocolTimeout: 900_000 }) : await puppeteer.launch({
  protocolTimeout: 900_000, // software rendering of big landscapes is slow
  executablePath: chrome,
  headless: true,
  // Linux: WebGPU on the SwiftShader software Vulkan driver, so it runs
  // without a GPU. macOS: Chrome's own WebGPU on Metal.
  args: [...(process.platform === 'darwin' ? [] : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=vulkan',
    '--use-vulkan=swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-vulkan-surface']), `--window-size=${SIZE.width},${SIZE.height}`],
  defaultViewport: SIZE,
});

const problems = [];
let failures = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    const expected = /broken\.stl|ASCII STL/.test(t);
    if ((m.type() === 'error' || m.type() === 'warning') && !expected) problems.push(`[${m.type()}] ${t}`);
    if (t.startsWith('[ascii]') && !t.startsWith('[ascii] F3')) console.log(`       ${t}`);
    if (/GPU (error|device lost)/.test(t)) problems.push(t);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));

  const state = () => page.evaluate(() => window.__ascii.state());
  const waitSettled = (model) => page.waitForFunction(
    (m) => { const s = window.__ascii?.state(); return s && s.model === m && s.status !== 'loading'; }, { timeout: 120_000, polling: 100 }, model);
  const coverage = () => page.evaluate(() => window.__ascii.coverage());
  const thumbnail = () => page.evaluate(() => window.__ascii.thumbnail());
  const shoot = async (name) => {
    const data = await page.evaluate(() => window.__ascii.png());
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data.split(',')[1], 'base64'));
  };
  const press = async (key) => {
    await page.focus('#ascii');
    await page.keyboard.press(key);
  };

  const step = async (name, fn) => {
    try {
      await fn();
      console.log(`  ok   ${name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL ${name}\n       ${e.message}`);
    } finally {
      // Never leave play mode on: it swallows the keys the next steps press.
      await page.evaluate(() => window.__ascii?.stopPlaying()).catch(() => {});
    }
  };

  /**
   * Mean absolute per-channel difference over the tiles where either image
   * shows something (not plain background).
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

  /** Compare the next frame to tests/golden/<name>.json. */
  const matchesGolden = async (name) => {
    const thumb = await thumbnail();
    const file = join(goldenDir, `${name}.json`);
    assert.ok(existsSync(file), `no reference image for ${name} (ascii-scene golden ... --update writes them)`);
    const ref = JSON.parse(readFileSync(file, 'utf8')).data;
    assert.equal(ref.length, thumb.length, 'reference thumbnail has a different size');
    const diff = contentDiff(thumb, ref);
    console.log(`       ${name}: diff ${diff.toFixed(2)} vs reference`);
    assert.ok(diff <= GOLDEN_TOLERANCE, `looks different from the reference (diff ${diff.toFixed(2)} > ${GOLDEN_TOLERANCE}); check test-results/`);
  };

  await page.goto(url, { waitUntil: 'load' });

  await step('starts on WebGPU with the opening model', async () => {
    await waitSettled('torus-knot.stl');
  });

  const models = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];
  for (const [i, model] of models.entries()) {
    await step(`model ${model} (key ${i + 1}): renders and matches reference`, async () => {
      if (i > 0) await press(String(i + 1));
      await waitSettled(model);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 0 && s.triangles > 0);
      const cov = await coverage();
      assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn`);
      const name = `${i + 1}-${model.replace('.stl', '')}`;
      await shoot(name);
      await matchesGolden(name);
    });
  }

  for (const [i, category] of ['rocks', 'plants', 'bushes', 'trees'].entries()) {
    await step(`scenery gallery ${category} (key ${6 + i}): renders and matches reference`, async () => {
      await press(String(6 + i));
      await waitSettled(`gallery-${category}`);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 10_000, `only ${s.cards} cards`);
      const cov = await coverage();
      assert.ok(cov > 0.1, `only ${(cov * 100).toFixed(2)}% of pixels drawn`);
      const name = `${6 + i}-gallery-${category}`;
      await shoot(name);
      await matchesGolden(name);
    });
  }

  // Landscapes: animation clock frozen so frames are reproducible.
  await page.evaluate(() => window.__ascii.freezeTime(3));
  for (const [i, [key, preset]] of [['m', 'meadow'], ['l', 'lake'], ['v', 'valley']].entries()) {
    await step(`landscape ${preset} (key ${key.toUpperCase()}): renders and matches reference`, async () => {
      await press(key);
      await waitSettled(`scene-${preset}`);
      const s = await state();
      assert.equal(s.status, 'ready', s.error ?? '');
      assert.ok(s.cards > 100_000 && s.weather.wind > 0);
      assert.ok((await coverage()) > 0.3, 'a landscape fills the frame');
      const name = `${13 + i}-scene-${preset}`;
      await shoot(name);
      await matchesGolden(name);
    });
  }

  await step('wind moves the scene over time; calm air does not', async () => {
    const at = async (t) => {
      await page.evaluate((t) => window.__ascii.freezeTime(t), t);
      return thumbnail();
    };
    const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0.85, leaves: 0, rain: 0 }));
    const windy = diff(await at(1), await at(2.5));
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0, leaves: 0, rain: 0 }));
    const calm = diff(await at(1), await at(2.5));
    console.log(`       frame change: windy ${windy.toFixed(2)}, calm ${calm.toFixed(2)}`);
    assert.ok(windy > calm * 1.5 && windy > 0.3, 'wind should visibly move grass and leaves');
  });

  await step('rain and blowing leaves (keys R, B) show up and switch off again', async () => {
    await page.evaluate(() => { window.__ascii.freezeTime(3); window.__ascii.setEnvironment({ rain: 0, wind: 0.6, leaves: 0 }); });
    const base = await thumbnail();
    await press('r');
    await press('b');
    const wet = await thumbnail();
    const s = await state();
    assert.ok(s.weather.rain > 0 && s.weather.leaves > 0, 'R and B switch rain and leaves on');
    await shoot('16-valley-rain');
    const d = wet.reduce((a, v, i) => a + Math.abs(v - base[i]), 0) / wet.length;
    assert.ok(d > 2, `rain should change the picture (diff ${d.toFixed(2)})`);
    await press('r');
    await press('b');
    const dry = await thumbnail();
    const back = dry.reduce((a, v, i) => a + Math.abs(v - base[i]), 0) / dry.length;
    assert.ok(back < d / 3, 'switching it off restores the scene');
    await page.evaluate(() => window.__ascii.freezeTime(null));
  });

  await step('player (key P): walks on the ground, never through it, stays out of the lake', async () => {
    await press('l');
    await waitSettled('scene-lake');
    await press('p');
    await page.waitForFunction(() => window.__ascii.state().playing, { timeout: 10_000 });
    const r = await page.evaluate(async () => {
      const a = window.__ascii;
      const toLake = await a.walk({ forward: 1, run: true }, 12);
      const walks = [];
      for (const yaw of [0, 1.6, 3.1, 4.7]) walks.push(await a.walk({ forward: 1, yaw }, 4));
      await a.walk({}, 0.5);
      const up = await a.walk({ jump: true }, 0.25);
      const landed = await a.walk({}, 2);
      return { toLake, walks, jump: up.y - up.ground, landed: landed.y - landed.ground,
        minClearance: Math.min(toLake.minClearance, ...walks.map((w) => w.minClearance), landed.minClearance),
        inWater: toLake.inWater || walks.some((w) => w.inWater) };
    });
    console.log(`       to lake moved ${r.toLake.moved.toFixed(1)} m, walks ${r.walks.map((w) => w.moved.toFixed(1)).join('/')} m, ` +
      `jump ${r.jump.toFixed(2)} m, min clearance ${r.minClearance.toFixed(4)} m`);
    assert.ok(r.minClearance >= -1e-3, 'the player went below the ground');
    assert.equal(r.inWater, false, 'the player walked into the lake');
    assert.ok(r.walks.some((w) => w.moved > 5), 'the player should be able to walk');
    assert.ok(r.jump > 0.5, 'jumping lifts the player');
    assert.ok(Math.abs(r.landed) < 1e-3, 'the player lands back on the ground');
    await shoot('16c-first-person');
    await press('p');
    await page.waitForFunction(() => !window.__ascii.state().playing, { timeout: 10_000 });
  });

  await step('infinite world (key I): streams chunks in workers, travels, walkable', async () => {
    await press('i');
    await waitSettled('world');
    const loadedAtLeast = (n) => page.waitForFunction((n) => window.__ascii.state().world.loaded >= n, { timeout: 900_000, polling: 1000 }, n);
    await loadedAtLeast(12);
    assert.ok((await coverage()) > 0.3, 'the world fills the view');
    await shoot('16d-world');
    // Travel 400 m: new chunks must arrive there and be walkable.
    const before = (await state()).world.built;
    await page.evaluate(() => window.__ascii.travel(400, 0));
    await page.waitForFunction((b) => window.__ascii.state().world.built >= b + 9, { timeout: 900_000, polling: 1000 }, before);
    await page.waitForFunction(() => window.__ascii.play(), { timeout: 120_000, polling: 1000 });
    const r = await page.evaluate(() => window.__ascii.walk({ forward: 1 }, 2));
    assert.ok(r && r.minClearance >= -1e-3 && !r.inWater, 'walks on the streamed ground');
  });

  await step('mouse orbit and wheel zoom keep rendering', async () => {
    await press('1');
    await waitSettled('torus-knot.stl');
    const before = await thumbnail();
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(700, 300, { steps: 12 });
    await page.mouse.up();
    await page.mouse.wheel({ deltaY: -300 });
    await new Promise((r) => setTimeout(r, 1500)); // let damping settle
    const after = await thumbnail();
    const moved = after.reduce((a, v, i) => a + Math.abs(v - before[i]), 0) / after.length;
    assert.ok(moved > 1, `dragging should turn the view (diff ${moved.toFixed(2)})`);
    const cov = await coverage();
    assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn after orbit`);
    await shoot('10-orbited');
  });

  await step('zooming all the way in never puts the camera inside the model', async () => {
    await press('2');
    await waitSettled('sphere.stl');
    await page.mouse.move(500, 400);
    for (let k = 0; k < 15; k++) {
      await page.mouse.wheel({ deltaY: -300 });
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 1500));
    const cov = await coverage();
    assert.ok(cov > 0.03, `only ${(cov * 100).toFixed(2)}% of pixels drawn at full zoom`);
    await shoot('11-closeup');
  });

  await step('a dropped broken file reports an error and keeps the old model on screen', async () => {
    await page.evaluate(() => window.__ascii.loadBytes(new TextEncoder().encode('solid broken\nvertex 1 2\n').buffer, 'broken.stl'));
    await page.waitForFunction(() => window.__ascii.state().status === 'error', { timeout: 30_000 });
    const s = await state();
    assert.match(s.error, /STL/);
    assert.ok((await coverage()) > 0.03, 'previous model should still be visible');
  });

  await step('recovers after the error', async () => {
    await press('1');
    await waitSettled('torus-knot.stl');
    assert.equal((await state()).status, 'ready');
  });

  await step('rapid switching ends on the last request', async () => {
    for (const k of ['2', '3', '4', '2', '3']) await press(k);
    await waitSettled('ziggurat.stl');
    await new Promise((r) => setTimeout(r, 1000));
    const s = await state();
    assert.equal(s.model, 'ziggurat.stl');
    assert.equal(s.status, 'ready');
  });

  await step('resize keeps rendering', async () => {
    await page.setViewport({ width: 420, height: 760 });
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok((await coverage()) > 0.03);
    await shoot('12-narrow');
  });

  await step('no errors or warnings in the console', async () => {
    assert.deepEqual(problems, []);
  });
} finally {
  if (remote) await browser.disconnect();
  else await browser.close();
  if (server) await new Promise((r) => server.httpServer.close(r));
}

if (failures) {
  console.log(`\n${failures} e2e step(s) failed`);
  process.exit(1);
}
console.log('\nall e2e checks passed (screenshots in test-results/)');
