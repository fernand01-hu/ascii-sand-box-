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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  // Quick mode: E2E_ONLY="pattern" runs only the steps whose name matches
  // (and the final console check), e.g. E2E_ONLY="toolbar|brush".
  const only = process.env.E2E_ONLY ? new RegExp(process.env.E2E_ONLY, 'i') : null;
  const step = async (name, fn) => {
    if (only && !only.test(name) && !name.startsWith('no errors')) return;
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
  // Reference images need still frames: no detail fades (the smooth-detail step turns them on for itself).
  // (Set directly: going through `set` would save every setting before the canvas is up.)
  await page.waitForFunction(() => !!window.__ascii?.app?.viewer, { timeout: 120_000 });
  await page.evaluate(() => { window.__ascii.app.viewer.cards.fadeSeconds = 0; });
  if (only) {
    console.log(`  quick mode: only steps matching /${only.source}/i`);
    await page.waitForFunction(() => window.__ascii && window.__ascii.model === 'canvas' && window.__ascii.status === 'ready', { timeout: 120_000 });
  }

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
    await page.keyboard.press('s'); // Settings, by its letter
    assert.ok(await visible('.tui-settings'), 's opens settings');
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
    await page.mouse.move(300, 400); // left of the options sidebar
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

  await step('terrain brush: P, paint by dragging, keys, size, soft edge, square, eraser, panel, stroke record', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const ground = (x, z) => page.evaluate((x, z) => window.__ascii.app.map.groundAt(x, z), x, z);
    const settled = () => page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    try {
      await page.keyboard.press('t'); // top-down: easiest to paint in
      await new Promise((r) => setTimeout(r, 900));
      await page.keyboard.press('p');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-paint').hidden), 'P shows the brush panel');
      assert.match(await page.evaluate(() => document.querySelector('.tui-status').textContent), /BRUSH grass/);
      await page.keyboard.press('2'); // sand
      const before = await page.evaluate(() => window.__ascii.app.viewer.controls.target.toArray());
      // Paint a line by dragging with the left button.
      await page.mouse.move(420, 380);
      const a = await page.evaluate(() => window.__ascii.cursorPoint());
      await page.mouse.down();
      await page.mouse.move(580, 380, { steps: 12 });
      const b = await page.evaluate(() => window.__ascii.cursorPoint());
      await page.mouse.up();
      assert.ok(a && b, 'the mouse is over the ground');
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      assert.equal(await ground(mid.x, mid.z), 'sand', 'dragging paints sand along the way');
      assert.equal(await ground(a.x, a.z), 'sand', 'and where it started');
      const after = await page.evaluate(() => window.__ascii.app.viewer.controls.target.toArray());
      assert.ok(Math.hypot(after[0] - before[0], after[2] - before[2]) < 0.01, 'painting does not move the camera');
      await settled();
      await page.screenshot({ path: join(outDir, '13g-brush.png') });
      // Size keys: ] one size up (2 -> 3 m), [ back down.
      await page.keyboard.press(']');
      assert.match((await run('brush grass')).join('\n'), /brush on: grass, circle 3 m/, '] makes the brush bigger');
      await page.keyboard.press('[');
      assert.match((await run('brush grass')).join('\n'), /circle 2 m/, '[ makes it smaller again');
      // Soft edge: a big soft dab is solid in the middle and patchy near the rim.
      await run('brush size 8; brush soft 0.6; brush strength 1');
      await run('dab 40 -60');
      assert.equal(await ground(40.2, -60.2), 'grass', 'solid in the middle');
      const rim = await page.evaluate(() => {
        const m = window.__ascii.app.map;
        let painted = 0, n = 0;
        for (let k = 0; k < 72; k++) {
          const ang = (k / 72) * Math.PI * 2;
          n++;
          // 6 m of 8: in the soft band, where about 38% of tiles are expected.
          if (m.groundAt(40 + 6 * Math.cos(ang), -60 + 6 * Math.sin(ang)) === 'grass') painted++;
        }
        return painted / n;
      });
      assert.ok(rim > 0.02 && rim < 0.9, `near the rim only some tiles are painted (${(rim * 100).toFixed(0)}%)`);
      // A square brush paints its corners (a circle of the same size would not).
      await run('brush rock; brush shape square; brush soft 0; brush size 2; dab 20.25 -20.25');
      assert.equal(await ground(21.9, -21.9), 'rock', 'square corner painted');
      // Eraser.
      await page.keyboard.press('e');
      assert.match((await run('set')).join('\n'), /^paint\s+canvas/m, 'E switches to the eraser');
      await run('dab 20.25 -20.25');
      assert.equal(await ground(20.25, -20.25), 'canvas', 'the eraser paints the canvas back');
      // The panel works with the mouse: click "water".
      const waterRow = await page.evaluateHandle(() => [...document.querySelectorAll('.tui-paint .tui-check')].find((r) => /water/.test(r.textContent)));
      await waterRow.click();
      assert.match((await run('set')).join('\n'), /^paint\s+water/m, 'clicking a paint in the panel picks it');
      // A stroke along a line, from the terminal.
      const out = (await run('stroke -30 -45 -20 -45'))[0];
      assert.match(out, /water: \d+ tiles changed/);
      assert.equal(await ground(-25, -45), 'water');
      await page.keyboard.press('p');
      assert.ok(await page.evaluate(() => document.querySelector('.tui-paint').hidden), 'P hides the brush panel');
    } finally {
      for (const c of ['brush off', 'brush grass', 'brush size 2', 'brush shape circle', 'brush strength 1', 'brush soft 0.3', 'clearmap yes', 'camera orbit', 'canvas 1']) await run(c);
    }
    await waitSettled('canvas');
    await settled();
  });

  await step('undo / redo: Ctrl+Z / Ctrl+Y for strokes, objects, scatter and clearmap; text fields keep their own undo', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const ground = (x, z) => page.evaluate((x, z) => window.__ascii.app.map.groundAt(x, z), x, z);
    const stats = () => page.evaluate(() => window.__ascii.worldStats());
    const settled = () => page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    const ctrl = async (key, shift = false) => {
      await page.keyboard.down('Control');
      if (shift) await page.keyboard.down('Shift');
      await page.keyboard.press(key);
      if (shift) await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
    };
    try {
      // A brush stroke painted with the mouse is one action.
      await page.keyboard.press('t');
      await new Promise((r) => setTimeout(r, 900));
      await run('brush on; brush sand; brush size 2; brush soft 0');
      await page.mouse.move(420, 380);
      const a = await page.evaluate(() => window.__ascii.cursorPoint());
      await page.mouse.down();
      await page.mouse.move(580, 380, { steps: 12 });
      const b = await page.evaluate(() => window.__ascii.cursorPoint());
      await page.mouse.up();
      const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
      assert.equal(await ground(mid.x, mid.z), 'sand');
      await settled();
      const builds = (await stats()).editBuilds;
      await ctrl('z');
      assert.equal(await ground(mid.x, mid.z), 'canvas', 'Ctrl+Z takes the whole stroke back');
      assert.equal(await ground(a.x, a.z), 'canvas');
      assert.match(await page.evaluate(() => document.querySelector('.tui-status').textContent), /undo: paint sand \(\d+ tiles\)/, 'the status bar says what was undone');
      await settled();
      assert.ok((await stats()).editBuilds > builds, 'the touched chunks were rebuilt');
      await ctrl('y');
      assert.equal(await ground(mid.x, mid.z), 'sand', 'Ctrl+Y paints it again');
      await ctrl('z');
      await ctrl('z', true);
      assert.equal(await ground(mid.x, mid.z), 'sand', 'Ctrl+Shift+Z redoes too');
      await run('brush off');
      // Objects come back with their id.
      const id = Number((await run('place tree:oak 4 -28 1 3'))[0].match(/#(\d+)/)[1]);
      await ctrl('z');
      assert.equal(await page.evaluate((id) => !!window.__ascii.app.map.object(id), id), false, 'Ctrl+Z removes the placed oak');
      await ctrl('y');
      assert.equal(await page.evaluate((id) => window.__ascii.app.map.object(id)?.kind, id), 'tree:oak', 'Ctrl+Y puts it back, same id');
      // One terminal line is one action, however many objects it places.
      const n0 = (await stats()).objects;
      await run('scatter trees 20 0 -40 10');
      assert.equal((await stats()).objects, n0 + 20);
      assert.match((await run('undo')).join('\n'), /undone: scatter trees 20 0 -40 10/);
      assert.equal((await stats()).objects, n0, 'one undo removes all twenty');
      // Even clearing the map can be undone.
      await run('fill grass -10 -60 10 -50');
      await run('clearmap yes');
      assert.equal((await stats()).edited, 0);
      await run('undo');
      assert.equal(await ground(0, -55), 'grass', 'undo brings the cleared paint back');
      assert.ok((await stats()).objects >= 1, 'and the objects');
      assert.match((await run('history')).join('\n'), /<- Ctrl\+Z undoes this/);
      // Ctrl+Z inside the terminal's text field is the field's own undo.
      const before = await stats();
      await page.keyboard.press('Backquote');
      await page.keyboard.type('abc');
      await ctrl('z');
      await page.keyboard.press('Escape');
      const after = await stats();
      assert.equal(after.objects, before.objects, 'typing Ctrl+Z in the terminal does not undo the map');
      assert.equal(after.edited, before.edited);
    } finally {
      for (const c of ['brush off', 'brush grass', 'brush soft 0.3', 'clearmap yes', 'camera orbit', 'canvas 1']) await run(c);
    }
    await waitSettled('canvas');
    await settled();
  });

  await step('save / load: browser slots, Ctrl+S, file download and upload, broken files, text export, autosave across a reload', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const ground = (x, z) => page.evaluate((x, z) => window.__ascii.app.map.groundAt(x, z), x, z);
    const objects = () => page.evaluate(() => window.__ascii.app.map.allObjects().map((o) => `${o.kind}@${o.x},${o.z}`));
    const statusText = () => page.evaluate(() => document.querySelector('.tui-status').textContent);
    const downloads = join(outDir, 'downloads');
    rmSync(downloads, { recursive: true, force: true });
    mkdirSync(downloads, { recursive: true });
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const waitFile = async (re) => {
      for (let k = 0; k < 100; k++) {
        const f = readdirSync(downloads).find((n) => re.test(n) && !n.endsWith('.crdownload'));
        if (f) return join(downloads, f);
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`no download matching ${re}`);
    };
    try {
      await run('clearmap yes; fill sand -10 -40 10 -30; place tree:oak 4 -35 1 3; wind 0.6');
      assert.match((await run('save test scene')).join('\n'), /saved "test scene"/);
      assert.match((await run('scenes')).join('\n'), /test scene .*<- current/);
      // Clear, change the weather, load it back.
      await run('clearmap yes; wind 0.2');
      assert.equal(await ground(0, -35), 'canvas');
      assert.match((await run('load test scene')).join('\n'), /loaded "test scene"/);
      assert.equal(await ground(0, -35), 'sand', 'the paint is back');
      assert.deepEqual(await objects(), ['tree:oak@4,-35'], 'the objects are back');
      assert.equal((await state()).weather.wind, 0.6, 'the weather comes with the scene');
      // Loading can be undone.
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      assert.equal(await ground(0, -35), 'canvas', 'Ctrl+Z undoes the load');
      await run('redo');
      assert.equal(await ground(0, -35), 'sand');
      // Ctrl+S saves the current scene.
      await page.keyboard.down('Control');
      await page.keyboard.press('s');
      await page.keyboard.up('Control');
      assert.match(await statusText(), /saved "test scene"/);
      // The menu panel lists it.
      await page.keyboard.press('Escape');
      await page.keyboard.press('f');
      assert.match(await page.evaluate(() => document.querySelector('.tui-file').textContent), /test scene/);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      // Download a scene file, check it, load it back through the file picker.
      await run('download');
      const file = await waitFile(/\.scene\.json$/);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(saved.format, 'ascii-sandbox-scene');
      assert.equal(saved.version, 2);
      assert.equal(saved.objects.length, 1);
      // fill -10..10 x -40..-30 crosses chunk borders both ways: 4 painted chunks, nothing else.
      assert.equal(saved.chunks.length, 4, 'only the painted chunks are stored');
      await run('clearmap yes');
      const input = await page.$('input[type=file]');
      await input.uploadFile(file);
      await page.waitForFunction(() => window.__ascii.app.map.groundAt(0, -35) === 'sand', { timeout: 30_000 });
      assert.deepEqual(await objects(), ['tree:oak@4,-35'], 'the file loads the same scene');
      // A broken file is refused with a message, and changes nothing.
      const bad = join(downloads, 'broken.scene.json');
      writeFileSync(bad, JSON.stringify({ format: 'something-else', version: 1 }));
      await input.uploadFile(bad);
      await page.waitForFunction(() => /could not load broken/.test(document.querySelector('.tui-status').textContent), { timeout: 10_000 });
      assert.match(await statusText(), /not an ASCII Sandbox scene file/);
      assert.equal(await ground(0, -35), 'sand', 'a refused file changes nothing');
      // The view as ASCII text.
      const text = (await run('export print 60')).join('\n');
      assert.ok(text.split('\n').length > 10 && /#/.test(text), 'the text export shows the canvas');
      await run('export text');
      assert.match(readFileSync(await waitFile(/\.txt$/), 'utf8'), /#/);
      // Autosave survives a reload.
      assert.match((await run('autosave now')).join('\n'), /autosaved/);
      await page.reload({ waitUntil: 'load' });
      await waitSettled('canvas');
      await page.waitForFunction(() => window.__ascii.app.map?.groundAt(0, -35) === 'sand', { timeout: 60_000 });
      assert.deepEqual(await objects(), ['tree:oak@4,-35'], 'the reload brought the work back');
    } finally {
      await cdp.detach().catch(() => {});
      for (const c of ['delete test scene', 'delete (autosave)', 'clearmap yes', 'wind 0.3', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
  });

  await step('object brush and select tool: spray evenly (across chunks), single, erase, select, move, turn, delete, undo', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const count = () => page.evaluate(() => window.__ascii.app.map.objectCount);
    const trees = () => page.evaluate(() => window.__ascii.app.map.allObjects().filter((o) => o.kind.startsWith('tree:')).map((o) => [o.x, o.z]));
    const minGap = (pts) => { let m = Infinity; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.min(m, Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])); return m; };
    const ctrlZ = async () => { await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control'); };
    const screenOf = (x, z) => page.evaluate((x, z) => {
      const v = window.__ascii.app.viewer, p = v.camera.position.clone().set(x, 0, z).project(v.camera);
      return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
    }, x, z);
    try {
      await run('clearmap yes');
      await page.keyboard.press('t');
      await new Promise((r) => setTimeout(r, 900));
      await page.keyboard.press('o');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-objects').hidden), 'O shows the object panel');
      await run('objbrush tree:*; objbrush mode spray; objbrush size 10; objbrush density 8; objbrush spacing 1');
      assert.match(await page.evaluate(() => document.querySelector('.tui-status').textContent), /OBJECTS spray any tree 10 m/);
      // Spray by dragging.
      await page.mouse.move(380, 400);
      await page.mouse.down();
      await page.mouse.move(620, 400, { steps: 14 });
      await page.mouse.up();
      const sprayed = await count();
      assert.ok(sprayed >= 5, `the drag sprayed trees (${sprayed})`);
      assert.ok(minGap(await trees()) >= 4 - 1e-6, `trees keep 4 m apart (${minGap(await trees()).toFixed(2)})`);
      // Spray over a chunk border too: still evenly spaced.
      await run('objbrush stroke 20 -16 44 -16; objbrush stroke 44 -12 20 -12');
      assert.ok(minGap(await trees()) >= 4 - 1e-6, 'spacing holds across chunk borders');
      // Single: one click, one object; Ctrl+Z takes it back.
      await page.keyboard.press('2');
      const n0 = await count();
      // In view and clear of the panels (objects bottom-left, parameters right).
      const empty = await screenOf(-6, -40);
      assert.ok(empty.x > 0 && empty.x < 600 && empty.y > 40 && empty.y < 400, `the click spot is in view (${empty.x.toFixed(0)}, ${empty.y.toFixed(0)})`);
      await page.mouse.click(empty.x, empty.y);
      assert.equal(await count(), n0 + 1, 'single places exactly one');
      await ctrlZ();
      assert.equal(await count(), n0, 'Ctrl+Z takes it back');
      // Erase what the drag sprayed; Ctrl+Z brings it back.
      await page.keyboard.press('3');
      const before = await count();
      await page.mouse.move(380, 400);
      await page.mouse.down();
      await page.mouse.move(620, 400, { steps: 14 });
      await page.mouse.up();
      assert.ok(await count() < before, 'erasing removes objects');
      await ctrlZ();
      assert.equal(await count(), before, 'Ctrl+Z brings them back');
      // Select tool.
      await run('clearmap yes');
      const id = Number((await run('place rock:boulder 0 -30 1.5 2'))[0].match(/#(\d+)/)[1]);
      await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
      await page.keyboard.press('v');
      const at = await screenOf(0, -30);
      await page.mouse.click(at.x, at.y);
      assert.match(await page.evaluate(() => document.querySelector('.tui-select').textContent), new RegExp(`#${id} rock:boulder`), 'clicking the rock selects it');
      // Drag it 10 m east.
      const to = await screenOf(10, -30);
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await new Promise((r) => setTimeout(r, 200));
      await page.mouse.move(to.x + 1, to.y, { steps: 2 });
      await page.mouse.up();
      const moved = await page.evaluate((id) => window.__ascii.app.map.object(id), id);
      assert.ok(moved && Math.abs(moved.x - 10) < 1.5 && Math.abs(moved.z + 30) < 1.5, `dragged to about (10, -30): (${moved?.x.toFixed(1)}, ${moved?.z.toFixed(1)})`);
      await ctrlZ();
      const back = await page.evaluate((id) => window.__ascii.app.map.object(id), id);
      assert.ok(back && Math.abs(back.x) < 0.01 && Math.abs(back.z + 30) < 0.01, 'Ctrl+Z puts it back, same id');
      // Turn, delete, undo.
      await run(`select ${id}`);
      await page.keyboard.press('r');
      assert.ok(Math.abs((await page.evaluate((id) => window.__ascii.app.map.object(id).yaw, id)) - Math.PI / 12) < 1e-6, 'R turns it 15°');
      await page.keyboard.press('Delete');
      assert.equal(await page.evaluate((id) => !!window.__ascii.app.map.object(id), id), false, 'Delete removes it');
      await ctrlZ();
      assert.equal(await page.evaluate((id) => !!window.__ascii.app.map.object(id), id), true, 'Ctrl+Z restores it');
      await page.screenshot({ path: join(outDir, '13h-objects.png') });
    } finally {
      for (const c of ['tool off', 'objbrush mode spray', 'clearmap yes', 'camera orbit', 'canvas 1']) await run(c);
    }
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
  });

  await step('generator parameters: sliders from the engine, objects grow with them, live preview, presets, saved in scenes', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const settled = () => page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    /** Top of an object's box, from the chunk the engine built. */
    const topOf = (id) => page.evaluate((id) => {
      const a = window.__ascii.app, o = a.map.object(id);
      const [cx, cz] = a.map.chunkOf(o.x, o.z);
      const b = a.world.chunk(cx, cz)?.data.bounds, i = a.map.objectsIn(cx, cz).indexOf(o);
      for (let k = 0; b && k + 7 <= b.length; k += 7) if (b[k] === i) return b[k + 5];
      return null;
    }, id);
    try {
      await run('clearmap yes; objbrush on; objbrush tree:oak; objbrush mode single; objbrush variation 0; param reset');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-params').hidden), 'the parameter panel opens with the object brush');
      const sliders = await page.evaluate(() => [...document.querySelectorAll('.tui-params .tui-slider .tui-label')].map((l) => l.textContent.trim()));
      assert.ok(sliders.includes('height') && sliders.includes('leaves per twig') && sliders.length >= 10, `one slider per oak parameter (${sliders.length})`);
      // A usual oak and a height-2 oak.
      await run('objbrush stroke -10 -30 -10 -30');
      await run('param height 2');
      await run('objbrush stroke 10 -30 10 -30');
      const [usual, tall] = await page.evaluate(() => window.__ascii.app.map.allObjects().sort((a, b) => a.x - b.x).map((o) => o.id));
      assert.deepEqual(await page.evaluate((id) => window.__ascii.app.map.object(id).params?.[0], tall), 2, 'the tall oak carries height 2');
      assert.equal(await page.evaluate((id) => window.__ascii.app.map.object(id).params, usual), undefined, 'the usual oak carries no parameters');
      await settled();
      const [a, b] = [await topOf(usual), await topOf(tall)];
      assert.ok(a && b && b > a * 1.6, `the engine grew it taller (${a?.toFixed(1)} m -> ${b?.toFixed(1)} m)`);
      // The live preview builds.
      await page.waitForFunction(() => /tree:oak · seed \d+ · \d+ glyphs/.test(document.querySelector('.tui-preview-info').textContent), { timeout: 120_000 });
      assert.ok(await page.evaluate(() => !!document.querySelector('.tui-preview canvas')), 'the preview has its own view');
      // A slider works with the mouse: click near the left end of "trunk thickness".
      const bar = await page.evaluateHandle(() => [...document.querySelectorAll('.tui-params .tui-slider')].find((r) => /trunk thickness/.test(r.textContent)).querySelector('.tui-bar'));
      const box = await bar.boundingBox();
      await page.mouse.click(box.x + box.width * 0.12, box.y + box.height / 2);
      const trunk = Number((await run('param')).find((l) => l.startsWith('trunk ')).split(/\s+/)[1]);
      assert.ok(trunk < 0.8, `clicking the slider lowers trunk thickness (${trunk})`);
      // Typing a preset name does not trigger the tools' keys (o would close the object brush).
      await page.click('.tui-params .tui-input input');
      await page.keyboard.type('tall oak');
      await page.keyboard.press('Enter');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-params').hidden), 'typing "o" in the field kept the brush open');
      assert.match((await run('preset')).join('\n'), /tall oak\s+tree:oak .*height=2/);
      await run('param reset');
      assert.equal(Number((await run('param')).find((l) => l.startsWith('height')).split(/\s+/)[1]), 1);
      await run('preset load tall oak');
      assert.equal(Number((await run('param')).find((l) => l.startsWith('height')).split(/\s+/)[1]), 2, 'the preset brings height 2 back');
      // Saved scenes keep each object's parameters.
      await run('save params test; clearmap yes; load params test');
      const back = await page.evaluate(() => window.__ascii.app.map.allObjects().map((o) => o.params?.[0] ?? null).sort());
      assert.deepEqual(back, [2, null], 'the tall oak is still tall after save and load');
      await page.screenshot({ path: join(outDir, '13i-parameters.png') });
    } finally {
      for (const c of ['preset delete tall oak', 'delete params test', 'param reset', 'objbrush mode spray', 'objbrush tree:*', 'objbrush variation 0.2', 'tool off', 'clearmap yes', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
  });

  await step('height brush: raise by dragging, undo, smooth / lower / flatten, the cursor finds hills, objects stand on them, saved', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const hAt = (x, z) => page.evaluate((x, z) => window.__ascii.app.map.heightAt(x, z), x, z);
    const settled = () => page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    const ctrl = async (key) => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); };
    try {
      await run('clearmap yes');
      await page.keyboard.press('t');
      await new Promise((r) => setTimeout(r, 900));
      await page.keyboard.press('h');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-height').hidden), 'H shows the height panel');
      await run('height raise; height size 6; height strength 1');
      assert.match(await page.evaluate(() => document.querySelector('.tui-status').textContent), /HEIGHT raise 6 m/);
      // Raise by dragging across the middle of the view.
      await page.mouse.move(440, 330);
      const a = await page.evaluate(() => window.__ascii.cursorPoint());
      await page.mouse.down();
      await page.mouse.move(560, 330, { steps: 10 });
      await page.mouse.up();
      const mid = { x: a.x + 3, z: a.z };
      const raised = await hAt(mid.x, mid.z);
      assert.ok(raised > 0.5, `dragging raised the ground (${raised.toFixed(2)} m)`);
      await ctrl('z');
      assert.equal(await hAt(mid.x, mid.z), 0, 'Ctrl+Z flattens it again');
      await ctrl('y');
      assert.ok(Math.abs((await hAt(mid.x, mid.z)) - raised) < 1e-6, 'Ctrl+Y brings the hill back');
      await run('height off; camera orbit');
      // A tall hill straight ahead; the other modes.
      await run('height size 10; height strength 4; repeat 2 height stroke -2 -40 2 -40');
      const top = await hAt(0, -40);
      assert.ok(top > 5, `a tall hill (${top.toFixed(1)} m)`);
      await run('height smooth; height strength 1; repeat 3 height stroke -1 -40 1 -40');
      assert.ok((await hAt(0, -40)) < top, 'smoothing lowers the peak');
      await run('height lower; height size 4; height strength 1; height stroke 20 -40 20 -40');
      assert.ok((await hAt(20, -40)) < -0.5, 'lower digs below the canvas');
      await run('height flatten; height size 4; height strength 1; height stroke 20 -36 20 -40');
      assert.ok(Math.abs(await hAt(20, -40)) < 0.6, 'flatten levels toward where the stroke started');
      // Objects stand on the hill.
      const id = Number((await run('place rock:boulder 0 -40 1.5 2'))[0].match(/#(\d+)/)[1]);
      await settled();
      const bottom = await page.evaluate((id) => {
        const a = window.__ascii.app, o = a.map.object(id);
        const [cx, cz] = a.map.chunkOf(o.x, o.z);
        const b = a.world.chunk(cx, cz).data.bounds, i = a.map.objectsIn(cx, cz).indexOf(o);
        for (let k = 0; k + 7 <= b.length; k += 7) if (b[k] === i) return b[k + 2];
        return null;
      }, id);
      const ground = await hAt(0, -40);
      assert.ok(bottom !== null && bottom > ground - 1 && bottom < ground + 0.5, `the rock sits on the hill (bottom ${bottom?.toFixed(2)}, ground ${ground.toFixed(2)})`);
      // The cursor finds the hill's face, not the flat ground behind it.
      const screen = await page.evaluate(() => {
        const a = window.__ascii.app, v = a.viewer, h = a.map.heightAt(0, -35);
        const p = v.camera.position.clone().set(0, h, -35).project(v.camera);
        return { x: ((p.x + 1) / 2) * window.innerWidth, y: ((1 - p.y) / 2) * window.innerHeight };
      });
      const hit = await page.evaluate((s) => window.__ascii.groundAt(s.x, s.y), screen);
      assert.ok(hit && Math.hypot(hit.x, hit.z + 35) < 1.5, `the ground under that point of the hill on screen is that point (${hit && `${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`})`);
      await page.screenshot({ path: join(outDir, '13j-height.png') });
      // Heights are saved (scene file version 2).
      await run('save hills; clearmap yes');
      assert.equal(await hAt(0, -40), 0);
      await run('load hills');
      assert.ok(Math.abs((await hAt(0, -40)) - ground) < 0.01, 'loading brings the hill back');
    } finally {
      for (const c of ['delete hills', 'height off', 'height raise', 'height size 6', 'height strength 0.5', 'camera orbit', 'clearmap yes', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
    await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s && s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
  });

  await step('toolbar, options sidebar, movable windows, spray variation', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const visible = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); return !!e && !e.hidden; }, sel);
    try {
      // The toolbar switches tools; the one that is on is highlighted.
      await page.click('.tui-toolbar [data-tool=objects]');
      assert.ok(await page.evaluate(() => document.querySelector('.tui-toolbar [data-tool=objects]').classList.contains('tui-sel')), 'objects is highlighted');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-dock .tui-objects').hidden), 'its options are in the sidebar');
      await page.click('.tui-toolbar [data-tool=paint]');
      assert.ok(await page.evaluate(() => !document.querySelector('.tui-dock .tui-paint').hidden), 'paint options now');
      assert.ok(await page.evaluate(() => document.querySelector('.tui-dock .tui-objects').hidden), 'object options gone: one tool at a time');
      // Tab hides and shows the sidebar.
      await page.keyboard.press('Tab');
      assert.equal(await visible('.tui-dock'), false, 'Tab hides it');
      await page.keyboard.press('Tab');
      assert.equal(await visible('.tui-dock'), true, 'Tab shows it again');
      // Windows move by their title, stay there, and go back on double-click.
      await page.keyboard.press('Escape');
      const title = await page.$('.tui-menu .tui-title');
      const t = await title.boundingBox();
      await page.mouse.move(t.x + 10, t.y + 5);
      await page.mouse.down();
      await page.mouse.move(t.x - 190, t.y - 95, { steps: 6 });
      await page.mouse.up();
      const moved = await page.evaluate(() => document.querySelector('.tui-menu').getBoundingClientRect().toJSON());
      assert.ok(Math.abs(moved.top - (t.y - 100)) < 20, `the menu moved up (${moved.top.toFixed(0)})`);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      const again = await page.evaluate(() => document.querySelector('.tui-menu').getBoundingClientRect().toJSON());
      assert.ok(Math.abs(again.left - moved.left) < 2 && Math.abs(again.top - moved.top) < 2, 'it opens where it was left');
      const tt = await (await page.$('.tui-menu .tui-title')).boundingBox();
      for (let k = 0; k < 2; k++) await page.mouse.click(tt.x + 10, tt.y + 5);
      const back = await page.evaluate(() => document.querySelector('.tui-menu').getBoundingClientRect().toJSON());
      assert.ok(Math.abs(back.left + back.width / 2 - 500) < 30, `double-click puts it back in the middle (${(back.left + back.width / 2).toFixed(0)})`);
      await page.keyboard.press('Escape');
      // Spraying with +-40% height gives trees of different heights, all within the range.
      await run('clearmap yes; objbrush tree:oak; objbrush mode spray; objbrush density 30; objbrush size 16; param reset; param height ±40');
      assert.match((await run('param')).find((l) => l.startsWith('height')), /±40%/);
      await run('objbrush stroke -10 -40 10 -40');
      const heights = await page.evaluate(() => window.__ascii.app.map.allObjects().map((o) => o.params?.[0] ?? 1));
      assert.ok(heights.length >= 4, `sprayed some oaks (${heights.length})`);
      assert.ok(new Set(heights.map((h) => h.toFixed(3))).size >= 2, `heights vary (${[...new Set(heights.map((h) => h.toFixed(2)))].join(' ')})`);
      assert.ok(heights.every((h) => h >= 0.6 - 1e-6 && h <= 1.4 + 1e-6), 'within +-40% of 1');
      assert.ok(new Set(heights.map((h) => h.toFixed(4))).size <= 6, 'drawn from a small pool per stroke (few unique trees to grow)');
      await page.screenshot({ path: join(outDir, '13k-toolbar-sidebar.png') });
    } finally {
      for (const c of ['param reset', 'objbrush tree:*', 'objbrush density 3', 'objbrush size 6', 'tool off', 'clearmap yes', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
  });

  await step('look lab: split panes, variants, time of day, shadow map, off again', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    try {
      await run('place tree:oak 0 -24 1.4 3');
      await page.keyboard.press('l');
      assert.ok(await page.evaluate(() => window.__ascii.lab.enabled), 'L turns the lab on');
      await run('lab layout 4; lab all classic classic classic; lab pane 2 light standard; lab pane 3 water standard; lab pane 4 weather storm; style time 10');
      const st = await page.evaluate(() => ({ panes: window.__ascii.app.viewer.panes?.length, labels: document.querySelectorAll('.tui-lab-label').length, panel: !document.querySelector('.tui-lab').hidden }));
      assert.deepEqual(st, { panes: 4, labels: 4, panel: true }, '4 panes, 4 labels, the lab panel');
      await new Promise((r) => setTimeout(r, 2500));
      assert.ok(await page.evaluate(() => !!window.__ascii.lab.look.sun), 'the sun shadow map is drawn for the shadows pane');
      assert.match((await run('lab list')).join('\n'), /classic/);
      assert.match((await run('lab pane 1 light nope')).join('\n'), /no light variant/);
      await page.screenshot({ path: join(outDir, '13l-look-lab.png') });
      await run('lab off');
      // The next frame (slow in software rendering) applies the standard look.
      await page.waitForFunction(() => window.__ascii.app.viewer.cards.material.uniforms.uFxA.value.x === 1, { timeout: 20_000 }).catch(() => {});
      const off = await page.evaluate(() => ({ panes: window.__ascii.app.viewer.panes, labels: document.querySelectorAll('.tui-lab-label').length, fx: window.__ascii.app.viewer.cards.material.uniforms.uFxA.value.toArray() }));
      assert.deepEqual(off, { panes: null, labels: 0, fx: [1, 0, 1, 1] }, `off: one view, the standard look (${JSON.stringify(off)})`);
      // The look's settings: all off is the look before Phase 3.
      await run('style classic');
      await page.waitForFunction(() => window.__ascii.app.viewer.cards.material.uniforms.uFxA.value.x === 0, { timeout: 20_000 }).catch(() => {});
      assert.deepEqual(await page.evaluate(() => window.__ascii.app.viewer.cards.material.uniforms.uFxA.value.toArray()), [0, 0, 0, 0], 'look classic turns it all off');
      await run('style standard; style storm on');
      assert.match((await run('style')).join('\n'), /storm on/);
      await run('style storm off; style time scene');
    } finally {
      for (const c of ['lab off', 'style time scene', 'style standard', 'lab layout 2', 'clearmap yes', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
  });

  await step('play mode: F walks the canvas, bumps into rocks, wades through water, F back to editing', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const settled = () => page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    // Step the player's own physics in the page: frames are slow in software rendering.
    const walk = (seconds) => page.evaluate((seconds) => {
      const p = window.__ascii.app.player;
      for (let t = 0; t < seconds; t += 1 / 60) p.physics.update(p.state, { forward: 1, right: 0, run: false, jump: false }, 1 / 60);
      return { x: p.state.x, y: p.state.y, z: p.state.z };
    }, seconds);
    try {
      await run('clearmap yes; place rock:boulder 0 -8 2 4; fill water 6 -20 14 4; cam 0 2 0 0 1.6 -20');
      await settled();
      await page.keyboard.press('f');
      assert.ok(await page.evaluate(() => !!window.__ascii.app.player), 'F starts play mode');
      assert.match(await page.evaluate(() => document.querySelector('.tui-status').textContent), /PLAY/);
      // The ground round the player is rebuilt first, its finest glyphs reaching 3x farther.
      const nearNow = () => {
        const w = window.__ascii.app.world;
        const p = window.__ascii.app.viewer.camera.position;
        const S = w.info.chunkSize;
        const here = w.chunks().find((c) => c.cx === Math.floor(p.x / S) && c.cz === Math.floor(p.z / S));
        return { detail: w.nearDetail, built: here?.loaded?.near ?? 0 };
      };
      await page.waitForFunction(`(${nearNow})().built === 3`, { timeout: 60_000, polling: 200 }).catch(() => {});
      const near = await page.evaluate(nearNow);
      assert.equal(near.detail, 3, 'play mode widens the fine ground');
      assert.equal(near.built, 3, 'the chunk under the player was rebuilt with the wide fine ground');
      // Walking on: the ground underfoot is rebuilt from nearby (no sparse rows built for a far eye).
      await page.evaluate(() => { const s = window.__ascii.app.player.state; s.z -= 12; });
      const underfoot = () => {
        const w = window.__ascii.app.world;
        const p = window.__ascii.app.viewer.camera.position;
        const S = w.info.chunkSize;
        const here = w.chunks().find((c) => c.cx === Math.floor(p.x / S) && c.cz === Math.floor(p.z / S));
        const e = here?.loaded?.data.eye;
        return e ? Math.hypot(e[0] - p.x, e[2] - p.z) : 1e9;
      };
      await page.waitForFunction(`(${underfoot})() < 6`, { timeout: 60_000, polling: 200 }).catch(() => {});
      const off = await page.evaluate(underfoot);
      assert.ok(off < 6, `the ground underfoot was rebuilt after walking (built ${off.toFixed(1)} m away)`);
      assert.ok(await page.evaluate(() => document.querySelector('.tui-toolbar [data-tool=play]').classList.contains('tui-sel')), 'the play button is on');
      // Editor keys stay quiet while playing.
      await page.keyboard.press('h');
      assert.equal(await page.evaluate(() => document.querySelector('.tui-height').hidden), true, 'H does not open the height brush');
      // Walking north runs into the boulder and stops at it.
      await page.evaluate(() => { const s = window.__ascii.app.player.state; s.x = 0; s.z = 0; s.yaw = 0; });
      const stop = await walk(4);
      const rock = await page.evaluate(() => { let r = 0; window.__ascii.app.world.collidersNear(0, -8, (x, z, rr) => { if (Math.hypot(x, z + 8) < 0.1) r = rr; }); return r; });
      assert.ok(rock > 0.3, `the boulder blocks (collider r ${rock.toFixed(2)})`);
      assert.ok(stop.z > -8 + rock && stop.z < -8 + rock + 1, `stopped at the boulder (z ${stop.z.toFixed(2)})`);
      // Walking east into the water: slower, knee deep.
      await page.evaluate(() => { const s = window.__ascii.app.player.state; s.x = 0; s.z = -14; s.yaw = -Math.PI / 2; s.vx = s.vz = 0; });
      const dry = await walk(1);
      await page.evaluate(() => { const s = window.__ascii.app.player.state; s.x = 9; s.z = -14; s.vx = s.vz = 0; });
      const wet = await walk(1);
      assert.ok(wet.x - 9 < (dry.x - 0) * 0.6, `wading is slower (${(wet.x - 9).toFixed(2)} vs ${dry.x.toFixed(2)} m)`);
      const ground = await page.evaluate((x) => window.__ascii.app.map.heightAt(x, -14) + window.__ascii.app.world.info.ground, wet.x);
      assert.ok(wet.y < ground - 0.2, `knee deep in the water (y ${wet.y.toFixed(2)}, ground ${ground.toFixed(2)})`);
      await page.screenshot({ path: join(outDir, '13m-play.png') });
      await page.keyboard.press('f');
      assert.equal(await page.evaluate(() => window.__ascii.app.player), null, 'F goes back to editing');
      assert.equal(await page.evaluate(() => window.__ascii.app.world.nearDetail), 1, 'editing uses the plain detail again');
      assert.ok(await page.evaluate(() => window.__ascii.app.viewer.controls.enabled), 'the editing camera is back');
    } finally {
      await page.evaluate(() => window.__ascii.app.stopPlaying());
      for (const c of ['clearmap yes', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
  });

  await step('smooth detail: rebuilds keep most glyphs and fade the rest, continuous detail, freeze, quality presets', async () => {
    const run = (line) => page.evaluate((l) => window.__ascii.run(l), line);
    const settled = () => page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 300_000, polling: 500 });
    try {
      await run('clearmap yes; fill grass -40 -60 40 0; scatter trees 10 0 -30 16; lod fade 0.8; lod reset; cam 0 6 40 0 2 -30');
      await settled();
      // Glyphs know how far they were built from (continuous detail).
      assert.ok(await page.evaluate(() => {
        for (const m of window.__ascii.app.viewer.cards.chunkMeshes) {
          const f = m.geometry.getAttribute('iFade')?.array ?? [];
          for (let i = 3; i < f.length; i += 4) if (f[i] > 0) return true;
        }
        return false;
      }), 'cards carry their build distance');
      // Walk in close: detail rebuilds keep most of what was there, and fade the rest out.
      await run('cam 0 4 -8 0 2 -30');
      await page.waitForFunction(() => window.__ascii.app.world.pop.rebuilds > 0, { timeout: 120_000, polling: 300 });
      const fading = await page.evaluate(() => window.__ascii.app.viewer.cards.outgoing.length);
      await settled();
      const pop = await page.evaluate(() => ({ ...window.__ascii.app.world.pop }));
      const keptShare = pop.kept / Math.max(1, pop.kept + pop.removed);
      console.log(`       ground: kept ${pop.groundKept}, removed ${pop.groundRemoved}; objects: kept ${pop.kept - pop.groundKept}, removed ${pop.removed - pop.groundRemoved}`);
      console.log(`       pop: ${pop.rebuilds} rebuilds, kept ${pop.kept}, added ${pop.added}, removed ${pop.removed} (${Math.round(keptShare * 100)}% kept)`);
      // The ground keeps its glyphs; objects keep theirs too unless their detail
      // version changes (this walk crosses one), and those fade instead.
      const groundShare = pop.groundKept / Math.max(1, pop.groundKept + pop.groundRemoved);
      assert.ok(groundShare > 0.75, `rebuilt ground keeps its glyphs (${Math.round(groundShare * 100)}%)`);
      assert.ok(fading > 0 || pop.removed === 0, 'removed glyphs fade out instead of vanishing');
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(await page.evaluate(() => window.__ascii.app.viewer.cards.outgoing.length), 0, 'faded glyphs are freed');
      assert.match((await run('lod')).join('\n'), /kept/);
      // A new object glyph where none was (a face hidden from the old build
      // eye) shows at once; one replacing nearby glyphs fades in.
      const faces = await page.evaluate(() => {
        const cards = window.__ascii.app.viewer.cards;
        const card = (x, glyph) => [x, 1, 0, 0.3, 0, 0, 0, 0.5, 0, 1, 1, 1, 1, 1024 + glyph, 1, 1];
        cards.replaceSet('face-probe', new Float32Array(card(0, 3)), 16, undefined, 0);
        cards.replaceSet('face-probe', new Float32Array([...card(0.1, 4), ...card(6, 5)]), 16, undefined, 0.8, [0, 1, 10]);
        const f = cards.sets.get('face-probe')[0].mesh.geometry.getAttribute('iFade').array;
        const res = { nearby: f[0], empty: f[4] };
        cards.removeSet('face-probe');
        for (const o of cards.outgoing.filter((o) => o.key.startsWith('face-probe'))) cards.removeSet(o.key);
        cards.outgoing = cards.outgoing.filter((o) => !o.key.startsWith('face-probe'));
        return res;
      });
      assert.ok(faces.nearby > 0, 'a glyph next to old ones fades in');
      assert.equal(faces.empty, -1e9, 'a glyph on an empty face shows at once');
      // Freeze: moving no longer rebuilds for detail.
      await run('lod freeze on; lod reset; cam 0 6 60 0 2 -30');
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(await page.evaluate(() => window.__ascii.app.world.pop.rebuilds), 0, 'frozen: no detail rebuilds');
      await run('lod freeze off');
      // Quality presets.
      await run('set quality low');
      assert.deepEqual(await page.evaluate(() => [window.__ascii.app.viewRadius, window.__ascii.lab.look.features.shadows]), [6, false], 'low: short view, baked shadows');
      await run('set quality high');
      assert.deepEqual(await page.evaluate(() => [window.__ascii.app.viewRadius, window.__ascii.lab.look.features.shadows]), [12, true], 'high: long view, live shadows');
      assert.match((await run('gpu')).join('\n'), /quality high/);
    } finally {
      for (const c of ['lod freeze off', 'set view 9', 'set budget off', 'style shadows on', 'lod fade 0', 'clearmap yes', 'canvas 1']) await run(c).catch(() => {});
    }
    await waitSettled('canvas');
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
    // (Leaves come from trees by default; this blank canvas has none, so let them fly everywhere.)
    await page.evaluate(() => window.__ascii.run('style treeLeaves off'));
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0.85, leaves: 1, rain: 0 }));
    const windy = await change();
    await page.evaluate(() => window.__ascii.setEnvironment({ wind: 0, leaves: 0, rain: 0 }));
    const calm = await change();
    await page.evaluate(() => { window.__ascii.app.viewer.controls.enableDamping = true; });
    await page.evaluate(() => window.__ascii.run('style treeLeaves on'));
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
