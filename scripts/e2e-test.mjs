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
    const expected = t.includes('could not load broken.stl') || t.includes('[expected]') || /GPU stall|Automatic fallback to software WebGL/.test(t);
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
      // Never leave play mode or the terminal on (they swallow the keys the
      // next steps press), nor a card budget.
      await page.evaluate(() => window.__ascii?.stopPlaying?.()).catch(() => {});
      await page.evaluate(() => window.__ascii?.app?.world && window.__ascii.run('camera orbit')).catch(() => {});
      await page.evaluate(() => {
        // Close every open panel (terminal, menu, settings...), top first.
        for (let k = 0; k < 6 && document.querySelector('.tui-panel:not([hidden])'); k++) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        }
        const v = window.__ascii?.app?.viewer;
        if (v) v.cards.budget = Infinity;
      }).catch(() => {});
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
    assert.ok((await coverage()) > 0.2, 'ground and sky fill the frame'); // glyphs barely overlap, so ~30% of pixels
    await page.screenshot({ path: join(outDir, '13-canvas.png') });
    await matchesGolden('13-canvas');
    await page.evaluate(() => window.__ascii.freezeTime(null));
  });

  await step('glyphs do not pile up; the sky outside the view is skipped; the card budget caps drawing', async () => {
    const st = await page.evaluate(() => window.__ascii.stacking());
    console.log(`       glyphs per screen cell: mean ${st.mean.toFixed(1)}, 95% under ${st.p95}, max ${st.max}`);
    assert.ok(st.p95 <= 8, `95% of screen cells should hold at most 8 glyphs (got ${st.p95})`);
    const drawn = () => page.evaluate(() => {
      const v = window.__ascii.app.viewer;
      v.requestRender();
      window.__ascii.thumbnail();
      return { drawn: v.cards.drawn, loaded: v.cards.cardCount, thinned: v.cards.thinned, always: v.cards.globalDrawn };
    });
    const full = await drawn();
    console.log(`       cards drawn ${full.drawn} of ${full.loaded} loaded`);
    assert.ok(full.drawn < full.loaded * 0.6, 'sky sectors behind the camera are not drawn');
    await page.evaluate(() => window.__ascii.run('budget 20k'));
    const capped = await drawn();
    console.log(`       budget 20k: ${capped.drawn} drawn (${capped.always} sky, rain and leaves, always drawn), ${capped.thinned} left out`);
    assert.ok(capped.thinned > 0 && capped.drawn < full.drawn, 'the budget leaves cards out');
    assert.ok(capped.drawn <= Math.max(20_000, capped.always), 'no more than the budget, or the always-drawn cards if those alone exceed it');
    await page.evaluate(() => window.__ascii.run('budget off'));
    const back = await drawn();
    // (Chunks may still be streaming in, so the total can differ a little.)
    assert.equal(back.thinned, 0, 'budget off leaves nothing out');
    assert.ok(back.drawn > capped.drawn, 'budget off draws more again');
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
    let golden = null;
    try {
      await matchesGolden('13b-canvas-edits');
    } catch (e) {
      golden = e; // clean up first, so later steps start from an empty map
    }
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
    if (golden) throw golden;
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

  await step('TUI: status bar, Esc menu, settings by keyboard and mouse, help; hotkeys stay quiet under panels', async () => {
    const visible = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); return !!e && !e.hidden; }, sel);
    const statusText = () => page.evaluate(() => document.querySelector('.tui-status').textContent);
    assert.match(await statusText(), /\[Esc\] menu/);
    assert.match(await statusText(), /canvas 1 · dusk/);
    await page.keyboard.press('Escape');
    assert.ok(await visible('.tui-menu'), 'Esc opens the menu');
    await page.keyboard.press('9'); // a gallery hotkey: must not fire under the menu
    assert.equal((await state()).model, 'canvas');
    await page.keyboard.press('Enter'); // first item: Settings
    assert.ok(await visible('.tui-settings'), 'Enter opens settings');
    // Rows: seed, daytime, view, wind, rain, leaves, top-down, grid, snap, fps, budget.
    for (let k = 0; k < 3; k++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    assert.equal((await state()).weather.wind, 0.4, 'Right twice raises the wind by 2 steps');
    for (let k = 0; k < 6; k++) await page.keyboard.press('ArrowDown');
    await page.keyboard.press(' ');
    await page.waitForFunction(() => /fps/.test(document.querySelector('.tui-status .tui-fps').textContent), { timeout: 5000 });
    // Mouse: click near the right end of the rain bar.
    const bars = await page.$$('.tui-settings .tui-slider .tui-bar');
    const box = await bars[2].boundingBox();
    await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
    const rain = (await state()).weather.rain;
    assert.ok(rain >= 0.8, `clicking the rain bar sets rain (${rain})`);
    await page.screenshot({ path: join(outDir, '13d-settings.png') });
    // The seed field: type a new seed, Enter applies it.
    await page.click('.tui-settings .tui-input input');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.type('5');
    assert.equal(await page.evaluate(() => document.querySelector('.tui-settings .tui-input input').value), '5');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__ascii.app.canvasOptions.seed === 5 && window.__ascii.status === 'ready', { timeout: 60_000 });
    await page.keyboard.press('Escape');
    assert.ok(!(await visible('.tui-settings')) && (await visible('.tui-menu')), 'Esc goes back to the menu');
    await page.keyboard.press('Escape');
    assert.ok(!(await visible('.tui-menu')), 'Esc closes the menu');
    await page.keyboard.press('?');
    assert.ok(await visible('.tui-help'), '? opens help');
    await page.keyboard.press('Escape');
    assert.ok(!(await page.evaluate(() => !!document.querySelector('.tui-panel:not([hidden])'))), 'no panel left open');
    // Back to the defaults for the next steps.
    for (const c of ['canvas 1', 'wind 0.3', 'rain off']) await page.evaluate((c) => window.__ascii.run(c), c);
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
  });

  await step('debug tools: menu panel, overlays, inspector, light view, terminal tools, link, warnings', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    try {
    const visible = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].some((e) => !e.hidden), sel);
    // The menu's Debug panel: its first checkbox is the info box.
    await page.keyboard.press('Escape');
    await page.keyboard.press('d');
    assert.ok(await visible('.tui-debug'), 'menu → Debug opens the debug panel');
    await page.keyboard.press(' ');
    assert.ok(await visible('.tui-infobox'), 'the first checkbox shows the info box');
    assert.match(await page.evaluate(() => document.querySelector('.tui-infobox').textContent), /facing\s+N/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert.match((await run('debug')).join('\n'), /\[x\] info/, 'the terminal sees what the menu set');
    // Line overlays.
    await run('place tree:oak 4 -28 1 3; debug chunks on; debug outlines on; debug axes on; debug culling on');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    await new Promise((r) => setTimeout(r, 600));
    const layers = await page.evaluate(() => window.__ascii.app.viewer.overlay.children.length);
    assert.ok(layers >= 4, `chunk, outline, axes and culling lines are drawn (${layers} layers)`);
    // Labels.
    await run('debug chunkLabels on; debug objects on');
    await page.waitForFunction(() => [...document.querySelectorAll('.tui-label-tag')].some((t) => !t.hidden && /#\d+ tree:oak/.test(t.textContent)), { timeout: 10_000 });
    assert.ok(await page.evaluate(() => [...document.querySelectorAll('.tui-label-tag')].some((t) => !t.hidden && /^-?\d+,-?\d+/.test(t.textContent))), 'chunk coordinates are labelled');
    await page.screenshot({ path: join(outDir, '13e-debug-overlays.png') });
    // Light view and glyph size tint are one-at-a-time.
    await run('debug light on');
    assert.equal(await page.evaluate(() => window.__ascii.app.viewer.cards.material.uniforms.uDebugView.value), 1);
    await run('debug size on');
    assert.equal(await page.evaluate(() => window.__ascii.app.viewer.cards.material.uniforms.uDebugView.value), 2);
    assert.match((await run('debug')).join('\n'), /\[ \] light/, 'turning on the size tint turns the light view off');
    await run('debug size off');
    // Glyph inspector: point at the ground in front of the camera.
    await run('debug inspector on');
    await page.mouse.move(500, 600);
    await page.mouse.move(503, 602);
    await page.waitForFunction(() => { const e = document.querySelector('.tui-inspect'); return e && !e.hidden && /GroundGrass|Canvas|sun/.test(e.textContent); }, { timeout: 10_000 });
    // Heat map, perf overlay (its title must not be cut off).
    await run('debug heat on; perf on');
    assert.ok(await visible('.tui-heat'));
    const perfTitle = await page.evaluate(() => {
      const box = document.querySelector('.tui-perf'), t = box.querySelector('.tui-title');
      return { overflow: getComputedStyle(box).overflow, top: t.getBoundingClientRect().top, height: t.getBoundingClientRect().height };
    });
    assert.notEqual(perfTitle.overflow, 'hidden', 'the perf box must not clip its title');
    assert.ok(perfTitle.top >= 0, 'the perf title is on screen');
    // Terminal tools.
    assert.match((await run('set wind 0.7')).join('\n'), /wind = 0.70/);
    assert.equal((await state()).weather.wind, 0.7);
    await run('alias storm wind 1');
    await run('storm');
    assert.equal((await state()).weather.wind, 1, 'an alias runs its command');
    await run('wind 0.4; rain 0.5');
    assert.equal((await state()).weather.rain, 0.5, '; runs several commands');
    await run('rain 0');
    await run('!!');
    assert.equal((await state()).weather.rain, 0);
    await run('bind k wind 0.2');
    await page.keyboard.press('k');
    await page.waitForFunction(() => window.__ascii.weather.wind === 0.2, { timeout: 5000 });
    assert.match((await run('verify')).join('\n'), /identical/);
    assert.match((await run('profile 1')).join('\n'), /fps average/);
    assert.match((await run('clearmap')).join('\n'), /type: clearmap yes/, 'clearmap asks first');
    assert.match((await run('time 10')).join('\n'), /world clock 10\.\d s/);
    assert.match((await run('stream off')).join('\n'), /frozen/);
    await run('stream on');
    for (const c of ['chunk', 'obj 1', 'here', 'workers', 'mem', 'stats', 'set', 'help debug']) {
      const out = (await run(c)).join('\n');
      assert.ok(out.length > 0 && !/unknown command|^error/m.test(out), `${c} answers`);
    }
    // A share link brings the camera back.
    const link = (await run('link'))[0];
    assert.match(link, /#seed=1&cam=/);
    await run('cam 50 20 50 60 0 40');
    assert.equal(await page.evaluate((h) => window.__ascii.applyLink(h), link.split('#')[1]), true);
    const cam = await page.evaluate(() => window.__ascii.app.viewer.camera.position.toArray());
    assert.ok(Math.abs(cam[0]) < 0.1 && Math.abs(cam[1] - 7) < 0.1, `the link restored the camera (${cam.map((v) => v.toFixed(1))})`);
    // Warnings while the terminal is closed show up in the status bar; clicking opens the terminal.
    await page.evaluate(() => console.warn('[expected] a test warning'));
    assert.match(await page.evaluate(() => document.querySelector('.tui-warn').textContent), /⚠ 1/);
    await page.click('.tui-warn');
    assert.ok(await visible('.tui-terminal'), 'clicking the counter opens the terminal');
    assert.equal(await page.evaluate(() => document.querySelector('.tui-warn').hidden), true, 'opening the terminal clears it');
    await page.keyboard.press('Escape');
    } finally {
      // Back to a clean state for the next steps, even if something above failed.
      await page.evaluate(() => { for (let k = 0; k < 6 && document.querySelector('.tui-panel:not([hidden])'); k++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
      for (const c of ['clearmap yes', 'bind k', 'alias storm', 'watch off', 'wind 0.3', 'rain 0', 'time 0', 'canvas 1',
        ...['info', 'cursor', 'chunks', 'outlines', 'axes', 'culling', 'chunkLabels', 'objects', 'tiles', 'bodies', 'inspector', 'heat', 'perf', 'light', 'size', 'rebuilds'].map((d) => `debug ${d} off`)]) await run(c);
    }
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    assert.equal(await page.evaluate(() => window.__ascii.app.viewer.overlay.children.length), 0, 'every overlay is gone again');
  });

  await step('editing camera: T looks straight down, pans and zooms, G grid, snapping, T back to orbit', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const cam = () => page.evaluate(() => {
      const v = window.__ascii.app.viewer;
      const d = v.camera.getWorldDirection(v.camera.position.clone());
      return { pos: v.camera.position.toArray(), target: v.controls.target.toArray(), dirY: d.y };
    });
    const settleCam = () => new Promise((r) => setTimeout(r, 900)); // damping
    const before = await cam();
    const offset = Math.hypot(before.pos[0] - before.target[0], before.pos[1] - before.target[1], before.pos[2] - before.target[2]);
    await page.keyboard.press('t');
    await settleCam();
    let c = await cam();
    assert.ok(c.dirY < -0.99, `T looks straight down (dir y ${c.dirY.toFixed(3)})`);
    assert.ok(Math.abs(c.pos[0] - c.target[0]) < 0.05 && Math.abs(c.pos[2] - c.target[2]) < 0.05, 'the camera is right above its target');
    // The ground under the middle of the screen is the target.
    const mid = await page.evaluate(() => window.__ascii.groundAt(window.innerWidth / 2, (window.innerHeight) / 2));
    assert.ok(mid && Math.hypot(mid.x - c.target[0], mid.z - c.target[2]) < 1, 'the screen centre looks at the target');
    // Arrow up pans north (-z).
    await page.keyboard.press('ArrowUp');
    await settleCam();
    const north = await cam();
    assert.ok(north.target[2] < c.target[2] - 0.5, 'ArrowUp moves north');
    // Dragging pans (never rotates in this view).
    await page.mouse.move(500, 400);
    await page.mouse.down();
    await page.mouse.move(650, 400, { steps: 10 });
    await page.mouse.up();
    await settleCam();
    const dragged = await cam();
    assert.ok(Math.abs(dragged.target[0] - north.target[0]) > 1, 'dragging pans the view');
    assert.ok(dragged.dirY < -0.99, 'still looking straight down after dragging');
    // The wheel changes the height.
    await page.mouse.wheel({ deltaY: 400 });
    await settleCam();
    const higher = await cam();
    assert.ok(higher.pos[1] > dragged.pos[1] + 1, 'wheel out raises the camera');
    // Grid and snapping.
    await page.keyboard.press('g');
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(await page.evaluate(() => window.__ascii.app.viewer.overlay.children.length > 0), 'G draws the grid');
    await run('snap 1');
    await page.mouse.move(430, 330);
    await page.mouse.move(433, 333);
    const p = await page.evaluate(() => window.__ascii.cursorPoint());
    assert.ok(p && Number.isInteger(p.x) && Number.isInteger(p.z), `the cursor point snaps to 1 m (${p && `${p.x}, ${p.z}`})`);
    const status = await page.evaluate(() => document.querySelector('.tui-status').textContent);
    assert.match(status, /TOP · grid · snap 1 m/);
    await page.screenshot({ path: join(outDir, '13f-top-view.png') });
    // The menu agrees (s: Settings, whatever the menu last had selected).
    await page.keyboard.press('Escape');
    await page.keyboard.press('s');
    assert.match(await page.evaluate(() => document.querySelector('.tui-settings').textContent), /\[x\] top-down view/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // T again: back to orbiting from the same distance.
    await page.keyboard.press('t');
    await settleCam();
    const back = await cam();
    const backOffset = Math.hypot(back.pos[0] - back.target[0], back.pos[1] - back.target[1], back.pos[2] - back.target[2]);
    assert.ok(back.dirY > -0.9, 'orbiting again');
    assert.ok(Math.abs(backOffset - offset) < 0.5, `the orbit distance comes back (${backOffset.toFixed(1)} vs ${offset.toFixed(1)})`);
    await run('snap off; grid off; camera orbit; canvas 1');
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
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
    assert.ok((await coverage()) > 0.2, 'the canvas fills the view far from the start');
    await page.screenshot({ path: join(outDir, '16d-canvas-travelled.png') });
    await page.keyboard.press('c');
    await waitSettled('canvas');
    await chunksLoaded(12);
  });

  await step('wind carries leaves across the canvas; calm air does not', async () => {
    // Leaves fly round the camera's height: look from eye level, fixed (no
    // damping drift), and let every chunk finish building first, so only the
    // weather changes between frames (software WebGL is too slow to stream
    // while drawing, so drawing pauses meanwhile).
    await page.evaluate(async () => {
      const app = window.__ascii.app, v = app.viewer, w = app.world;
      v.controls.enableDamping = false;
      v.camera.position.set(0, 2, 0);
      v.controls.target.set(0, 1.6, -20);
      v.controls.update();
      const draw = v.draw;
      v.draw = () => {};
      try {
        for (let quiet = 0; quiet < 3;) {
          w.update(v.camera.position, true);
          quiet = w.pending === 0 && w.dirtyCount === 0 ? quiet + 1 : 0;
          await new Promise((r) => setTimeout(r, 50));
        }
      } finally {
        v.draw = draw;
      }
    });
    // Leaves are small: compare finer images than the reference thumbnails.
    const at = (t) => page.evaluate((t) => { window.__ascii.freezeTime(t); return window.__ascii.app.viewer.thumbnail(250, 200); }, t);
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
    assert.ok(windy > calm * 3 && windy > 0.08, 'wind should visibly carry the leaves');
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
