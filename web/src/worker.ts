// A Web Worker that builds scenes and world chunks: the same Rust app module
// as the page, running jobs the page's executor sends (bytes in, bytes out).
// On failure it answers with a string and stops: the page drops this worker
// and ends the job with an error.

import init, { worker_run } from './app-pkg/ascii_app.js';
import wasmUrl from './app-pkg/ascii_app_bg.wasm?url';

const scope = self as unknown as Worker & { close(): void };
const ready = init({ module_or_path: wasmUrl });

scope.onmessage = async (e: MessageEvent<Uint8Array>) => {
  try {
    await ready;
    const out = worker_run(e.data);
    scope.postMessage(out, [out.buffer]);
  } catch (err) {
    // A trapped WebAssembly instance cannot run again.
    scope.postMessage(String(err));
    scope.close();
  }
};
