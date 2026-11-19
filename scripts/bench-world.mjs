// Times how long the infinite world takes to stream in fully (build:test first).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chrome = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => p && existsSync(p));
const server = await preview({ configFile: join(root, 'vite.config.ts'), preview: { port: 4318, strictPort: false }, logLevel: 'warn' });
const browser = await puppeteer.launch({
  protocolTimeout: 600_000, executablePath: chrome, headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=800,600'],
  defaultViewport: { width: 800, height: 600 },
});
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.__ascii, { timeout: 60_000 });
  const res = await page.evaluate(async () => {
    const a = window.__ascii;
    const t0 = performance.now();
    await a.loadWorld(1);
    const marks = {};
    // Measure chunk building only: software WebGL drawing would dominate otherwise.
    const app = a.app, v = app.viewer;
    v.draw = () => {};
    v.onFrame = null;
    for (;;) {
      app.world.update(v.camera.position, true);
      const s = a.worldStats();
      for (const n of [1, 25, 100, 200]) if (!marks[n] && s.loaded >= n) marks[n] = Math.round(performance.now() - t0);
      if (s.loaded > 0 && s.pending === 0) { marks.all = Math.round(performance.now() - t0); marks.chunks = s.loaded; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    marks.cores = navigator.hardwareConcurrency;
    return marks;
  });
  console.log(JSON.stringify(res));
} finally {
  await browser.close();
  await server.close();
}
