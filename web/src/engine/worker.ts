// Runs the Rust/WASM engine off the main thread so heavy work never freezes
// the page. Requests are processed strictly in order.

import init, { CardConfig, Engine, cardStride } from '../pkg/ascii_engine.js';
import wasmUrl from '../pkg/ascii_engine_bg.wasm?url';
import type { CardSettings, WorkerRequest, WorkerResponse } from './protocol';

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

const ready: Promise<Engine> = init({ module_or_path: wasmUrl }).then(() => new Engine());

let queue: Promise<void> = Promise.resolve();
ctx.onmessage = (e) => {
  const req = e.data;
  queue = queue.then(() => handle(req));
};

async function handle(req: WorkerRequest): Promise<void> {
  try {
    const engine = await ready;
    let mesh = null;
    let loadMs = 0;
    if (req.kind === 'load') {
      const t0 = performance.now();
      engine.loadStl(new Uint8Array(req.bytes), req.zUp);
      loadMs = performance.now() - t0;
      mesh = {
        positions: engine.meshPositions(),
        normals: engine.meshNormals(),
        triangles: engine.triangleCount(),
        dropped: engine.droppedTriangles(),
      };
    }
    const t1 = performance.now();
    const cards = generate(engine, req.settings);
    const generateMs = performance.now() - t1;
    const stride = cardStride();
    const transfer: Transferable[] = [cards.buffer];
    if (mesh) transfer.push(mesh.positions.buffer, mesh.normals.buffer);
    ctx.postMessage(
      { kind: 'result', id: req.id, mesh, cards, stride, count: cards.length / stride, timings: { loadMs, generateMs } },
      transfer,
    );
  } catch (err) {
    // A WebAssembly trap (panic, out of memory) leaves the instance unusable:
    // flag it so the client replaces this worker.
    const fatal = err instanceof WebAssembly.RuntimeError;
    ctx.postMessage({ kind: 'error', id: req.id, message: errorMessage(err), fatal });
  }
}

function generate(engine: Engine, s: CardSettings): Float32Array {
  const c = new CardConfig();
  try {
    c.seed = s.seed >>> 0;
    c.count = s.count >>> 0;
    c.sizeFactor = s.sizeFactor;
    c.glyphCount = s.glyphCount >>> 0;
    c.glyphAspect = s.glyphAspect;
    [c.r, c.g, c.b] = s.color;
    c.colorJitter = s.colorJitter;
    c.twist = s.twist;
    c.tilt = s.tilt;
    c.alphaMin = s.alphaMin;
    c.alphaMax = s.alphaMax;
    return engine.generate(c);
  } finally {
    c.free();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
