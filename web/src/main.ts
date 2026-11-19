// The web build of ASCII Scene: the same Rust app as the desktop one
// (native/app), compiled to WebAssembly, drawing with WebGPU. This page only
// starts it, gives it Web Workers to build in, and forwards dropped files.
//
// Keys: 1-4 models, 6-9 galleries, M F L V A landscapes, I infinite world,
// P walk (WASD, Shift, Space, mouse), W wind, R rain, B leaves, F3 perf log.
// Drop an .stl on the page to load it. `?perf` turns the perf log on.

import init, * as app from './app-pkg/ascii_app.js';
import wasmUrl from './app-pkg/ascii_app_bg.wasm?url';

const canvas = document.getElementById('ascii');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('#ascii canvas is missing');

function fail(msg: string): void {
  const pre = document.createElement('pre');
  pre.className = 'error';
  pre.textContent = `ASCII Scene could not start: ${msg}`;
  document.body.append(pre);
}

if (!('gpu' in navigator)) {
  fail('this browser has no WebGPU (Chrome, Edge, Safari 26 or Firefox 141 and later have it).');
} else {
  // Leave a core for the page and one for the system, at most 6 builders.
  const n = Math.min(6, Math.max(1, (navigator.hardwareConcurrency || 4) - 2));
  const workers = Array.from({ length: n }, () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));
  await init({ module_or_path: wasmUrl });
  app.start(canvas, workers, new URLSearchParams(location.search).has('perf'));
  canvas.focus();
  // Dev and test builds: hooks for the e2e test and the console.
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    const { installHooks } = await import('./hooks');
    installHooks(app, canvas);
  }

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) void file.arrayBuffer().then((b) => app.load_stl(new Uint8Array(b), file.name));
  });
}
