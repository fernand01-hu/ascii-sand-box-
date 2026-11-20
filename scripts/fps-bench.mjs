// Frame-rate bench in a real browser: builds the lab landscape and measures
// the classic and standard looks, still and with the camera turning.
//   npm run bench:fps          on this machine's GPU (Chrome, ANGLE)
//   npm run bench:fps -- sw    in software (SwiftShader), like the e2e test
// Needs a test build first (npm run build:test).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { preview } from 'vite';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = await preview({ configFile: join(root, 'vite.config.ts'), preview: { port: 4336, strictPort: false }, logLevel: 'warn' });
const gl = process.argv[2] ?? 'gpu';
const args = gl === 'gpu' ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl', '--enable-features=Vulkan'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const browser = await puppeteer.launch({ protocolTimeout: 1_800_000, executablePath: '/usr/bin/google-chrome', headless: true, args, defaultViewport: { width: 1600, height: 900 } });
try {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => window.__ascii?.model === 'canvas' && window.__ascii.status === 'ready', { timeout: 120_000 });
  console.log('renderer:', await page.evaluate(() => { const g = window.__ascii.app.viewer.renderer.getContext(); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; }));
  const run = (l) => page.evaluate((l) => window.__ascii.run(l), l);
  await run('lab landscape');
  await run('lab off; lab view landscape');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => { const s = window.__ascii.worldStats(); return s.dirty === 0 && s.pending === 0; }, { timeout: 1_200_000, polling: 2000 });
  const measure = async (label, cmd) => {
    await run(cmd);
    await new Promise((r) => setTimeout(r, 3000));
    const samples = [];
    for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 1000)); samples.push(await page.evaluate(() => ({ ...window.__ascii.app.viewer.stats }))); }
    const fps = samples.map((s) => s.fps).sort((a, b) => a - b)[3];
    console.log(`${label.padEnd(26)} ${fps.toFixed(1)} fps, frame ${(1000 / Math.max(fps, 0.01)).toFixed(0)} ms, ${(samples[5].drawn / 1000).toFixed(0)}k glyphs drawn`);
  };
  await measure('classic look', 'style classic');
  await measure('standard look', 'style standard');
  await page.evaluate(() => {
    const v = window.__ascii.app.viewer, c = v.controls;
    v.onFrame = (dt) => { const p = v.camera.position.clone().sub(c.target); p.applyAxisAngle(v.camera.up, dt * 0.4); v.camera.position.copy(c.target).add(p); c.update(); };
  });
  await measure('standard, camera turning', 'style standard');
  await measure('classic, camera turning', 'style classic');
  await measure('standard + storm + rain', 'style standard; style storm on; rain 0.8');
} finally { await browser.close(); await server.close(); }
