// Measures how many glyphs pile up on one spot of the screen, and how many
// cards are drawn, in four canvas views: the default view and eye level,
// on the blank canvas and over a 150-object forest. Run after build:test.
// usage: node scripts/bench-stacking.mjs [screenshot dir] [label]
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] ?? join(root, 'test-results');
const label = process.argv[3] ?? 'stacking';
mkdirSync(outDir, { recursive: true });
const chrome = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const server = await preview({ configFile: join(root, 'vite.config.ts'), preview: { port: 4319, strictPort: false }, logLevel: 'warn' });
const browser = await puppeteer.launch({
  protocolTimeout: 900_000, executablePath: chrome, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,800'],
  defaultViewport: { width: 1000, height: 800 },
});
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.__ascii && window.__ascii.model === 'canvas' && window.__ascii.status === 'ready', { timeout: 120_000 });
  // Stream until every chunk in range is built for the current eye. Software
  // WebGL takes seconds per frame, so drawing is paused meanwhile and the
  // streamer is driven directly (it normally runs once per frame).
  const settle = () => page.evaluate(async () => {
    const app = window.__ascii.app, v = app.viewer, w = app.world;
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
  const view = (eye, target) => page.evaluate((eye, target) => {
    const v = window.__ascii.app.viewer;
    v.controls.enableDamping = false;
    v.camera.position.set(...eye);
    v.controls.target.set(...target);
    v.controls.update();
    window.__ascii.app.world.update(v.camera.position, true);
  }, eye, target);
  const measure = async (name) => {
    await settle();
    await page.evaluate(() => window.__ascii.freezeTime(3));
    const r = await page.evaluate(() => {
      const a = window.__ascii, v = a.app.viewer;
      v.requestRender();
      a.thumbnail(); // draws a frame, so stats.drawn is current
      return { stack: a.stacking(), drawn: v.cards.drawn, loaded: v.cards.cardCount };
    });
    await page.screenshot({ path: join(outDir, `${label}-${name}.png`) });
    const s = r.stack;
    console.log(`${name.padEnd(16)} stack mean ${s.mean.toFixed(1).padStart(5)}  p95 ${String(s.p95).padStart(4)}  max ${String(s.max).padStart(5)}  cells ${s.cells}   cards drawn ${r.drawn}  loaded ${r.loaded}`);
  };
  const HIGH = [[0, 7, 0], [0, 1, -30]], LOW = [[0, 1.7, 0], [0, 1.5, -20]];
  await view(...HIGH); await measure('canvas-high');
  await view(...LOW); await measure('canvas-low');
  await page.evaluate(() => {
    const a = window.__ascii;
    const kinds = ['tree:oak', 'tree:pine', 'tree:spruce', 'tree:birch', 'tree:maple', 'bush:big_round', 'bush:juniper', 'rock:boulder'];
    let r = 12345;
    const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    a.paintRect(-60, -140, 60, -10, 'grass');
    for (let i = 0; i < 150; i++) a.addObject({ kind: kinds[i % kinds.length], x: -50 + rnd() * 100, z: -130 + rnd() * 110, seed: i, yaw: rnd() * 6.28 });
  });
  await view(...HIGH); await measure('forest-high');
  await view(...LOW); await measure('forest-low');
} finally {
  await browser.close();
  await server.close();
}
