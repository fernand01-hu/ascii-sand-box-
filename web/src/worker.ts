// A Web Worker that builds scenes and world chunks: the same Rust app module
// as the page, running jobs the page's executor sends (bytes in, bytes out).

import init, { worker_run } from './app-pkg/ascii_app.js';
import wasmUrl from './app-pkg/ascii_app_bg.wasm?url';

const ready = init({ module_or_path: wasmUrl });

self.onmessage = async (e: MessageEvent<Uint8Array>) => {
  await ready;
  const out = worker_run(e.data);
  (self as unknown as Worker).postMessage(out, [out.buffer]);
};
