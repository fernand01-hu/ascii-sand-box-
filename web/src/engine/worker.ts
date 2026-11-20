// Runs the Rust/WASM engine off the main thread so heavy work never freezes
// the page.
//
// Requests are handled one at a time, newest-wins: before starting a request
// the worker lets every message already sent land, then skips requests that a
// newer one makes pointless (switching models five times quickly builds only
// the last one).

import init, * as wasm from '../pkg/ascii_engine.js';
import wasmUrl from '../pkg/ascii_engine_bg.wasm?url';
import { chunkCards } from './chunks';
import { GLYPH_RULES, type CardSettings, type WorkerRequest, type WorkerResponse } from './protocol';

const TESTBED = import.meta.env.DEV || import.meta.env.MODE === 'test';

interface WorkerScope {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

/**
 * Post a result with its cards split into render chunks (culling + level of
 * detail). STL models stay one unthinned chunk: their glyphs tile a surface.
 */
function postResult(msg: Extract<WorkerResponse, { kind: 'result' }>, transfer: Transferable[], allGlobal = false): void {
  const { cards, chunks } = chunkCards(msg.cards, msg.stride, allGlobal);
  const rest = transfer.filter((t) => t !== msg.cards.buffer);
  ctx.postMessage({ ...msg, cards, chunks }, [...rest, cards.buffer, chunks.buffer]);
}

const ready: Promise<wasm.Engine> = init({ module_or_path: wasmUrl }).then(() => new wasm.Engine());

const queue: WorkerRequest[] = [];
let busy = false;
let scheduled = false;

ctx.onmessage = (e) => {
  queue.push(e.data);
  schedule();
};

function schedule(): void {
  if (busy || scheduled) return;
  scheduled = true;
  // A macrotask, so messages that are already waiting arrive before we pick.
  setTimeout(pump, 0);
}

async function pump(): Promise<void> {
  scheduled = false;
  busy = true;
  try {
    while (queue.length > 0) {
      const req = queue.shift()!;
      if (isSuperseded(req, queue)) {
        ctx.postMessage({ kind: 'skipped', id: req.id });
        continue;
      }
      await handle(req);
      await new Promise((r) => setTimeout(r, 0)); // let new messages land
    }
  } finally {
    busy = false;
    if (queue.length > 0) schedule();
  }
}

/** A load is only pointless if a newer request replaces the scene; anything
 *  else is pointless as soon as any newer request exists. */
function isSuperseded(req: WorkerRequest, newer: WorkerRequest[]): boolean {
  if (newer.length === 0) return false;
  const replacesScene = (r: WorkerRequest) => r.kind !== 'generate' && r.kind !== 'worldChunk';
  if (req.kind === 'load' || req.kind === 'worldInit' || req.kind === 'worldSetup') return newer.some(replacesScene);
  // Streamed chunks: only a new scene or world makes them pointless.
  if (req.kind === 'worldChunk') return newer.some(replacesScene);
  return true;
}

let world: wasm.CanvasWorld | null = null;

async function handle(req: WorkerRequest): Promise<void> {
  try {
    const engine = await ready;
    if (req.kind === 'worldSetup') {
      // Chunk workers hold their own copy of the world (it is deterministic).
      world?.free();
      world = req.seed === null ? null : new wasm.CanvasWorld(req.seed >>> 0, req.day);
      return;
    }
    if (req.kind === 'worldInit') {
      world?.free();
      world = new wasm.CanvasWorld(req.seed >>> 0, req.day);
      const t0 = performance.now();
      const cards = world.skyCards(req.glyphAspect);
      const [chunkSize = 32, grid = 32, ground = 0, tile = 0.5, tiles = 64] = wasm.worldConsts();
      const spawn: [number, number, number] = [0, ground, 0];
      const stride = wasm.cardStride();
      const materials = wasm.sceneryMaterials();
      const [sx = 0, sy = 1, sz = 0] = wasm.sceneSunDir(req.day);
      postResult(
        {
          kind: 'result', id: req.id, mesh: null, cards, stride, count: cards.length / stride, charset: wasm.sceneryCharset(),
          timings: { loadMs: 0, generateMs: performance.now() - t0 }, sunDir: [sx, sy, sz], materials, materialFloats: wasm.materialFloats(),
          env: { day: req.day, windDir: [0.89, -0.45], leafBox: [0, 0, 90], rainBox: [36, 24, 36] },
          world: { chunkSize, grid, ground, spawn, tile, tiles, groundKinds: wasm.groundKinds().split(','), objectKinds: wasm.objectKinds().split(','), materialNames: wasm.materialNames().split(',') },
        },
        [cards.buffer, materials.buffer],
        // Sky, rain and leaves are global by their card mode; the sky dome is
        // split into direction sectors so the renderer can skip those out of view.
      );
      return;
    }
    if (req.kind === 'worldChunk') {
      if (!world) throw new Error('no world: call worldInit first');
      const t0 = performance.now();
      const [ex, ey, ez] = req.eye;
      const c = world.buildChunk(req.cx, req.cz, ex, ey, ez, req.glyphAspect, req.tiles ?? new Uint8Array(0), req.objects);
      try {
        const cards = c.takeCards();
        const positions = c.takeBody();
        const normals = c.takeBodyNormals();
        const heights = c.takeHeights();
        const colliders = c.takeColliders();
        const bounds = c.takeBounds();
        const stride = wasm.cardStride();
        postResult(
          {
            kind: 'result', id: req.id, cards, stride, count: cards.length / stride, charset: wasm.sceneryCharset(),
            mesh: { positions, normals, triangles: positions.length / 9, dropped: 0 },
            timings: { loadMs: 0, generateMs: performance.now() - t0 },
            chunk: { cx: req.cx, cz: req.cz, eye: req.eye, rev: req.rev, placed: c.placed(), bounds, heights, colliders },
          },
          [cards.buffer, positions.buffer, normals.buffer, heights.buffer, colliders.buffer, bounds.buffer],
        );
      } finally {
        c.free();
      }
      return;
    }
    if (req.kind === 'gallery') {
      const t0 = performance.now();
      const scene = wasm.buildGallery(req.category, req.seed >>> 0, req.glyphAspect);
      try {
        const cards = scene.takeCards();
        const positions = scene.takeBody();
        const normals = scene.takeBodyNormals();
        const [tx = 0, ty = 0, tz = 0, ex = 0, ey = 0, ez = 10, fov = 40] = scene.camera();
        const e = scene.env();
        const [sx = 0, sy = 1, sz = 0] = wasm.scenerySunDir();
        const generateMs = performance.now() - t0;
        const stride = wasm.cardStride();
        const materials = wasm.sceneryMaterials();
        postResult(
          {
            kind: 'result', id: req.id, cards, stride, count: cards.length / stride, charset: wasm.sceneryCharset(),
            mesh: { positions, normals, triangles: positions.length / 9, dropped: 0 },
            timings: { loadMs: 0, generateMs }, sunDir: [sx, sy, sz], materials, materialFloats: wasm.materialFloats(),
            camera: { target: [tx, ty, tz], eye: [ex, ey, ez], fov },
            env: {
              day: (e[0] ?? 0) > 0.5,
              windDir: [e[1] ?? 1, e[2] ?? 0],
              leafBox: [e[3] ?? 0, e[4] ?? 0, e[5] ?? 1],
              rainBox: [e[6] ?? 36, e[7] ?? 24, e[8] ?? 36],
            },
          },
          [cards.buffer, positions.buffer, normals.buffer, materials.buffer],
        );
      } finally {
        scene.free();
      }
      return;
    }
    if (req.kind === 'testbed') {
      // TESTBED is a build-time constant, so production drops this import entirely.
      if (TESTBED) {
        const { runTestbed } = await import('../testbed/worker-scenes');
        const res = runTestbed(wasm, req);
        postResult({ kind: 'result', id: req.id, ...res }, [res.cards.buffer]);
        return;
      }
      throw new Error('test scenes are not part of this build');
    }
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
    const charset = wasm.normalizeCharset(req.settings.charset);
    const t1 = performance.now();
    const cards = generate(engine, req.settings, charset);
    const generateMs = performance.now() - t1;
    const stride = wasm.cardStride();
    const transfer: Transferable[] = [cards.buffer];
    if (mesh) transfer.push(mesh.positions.buffer, mesh.normals.buffer);
    postResult(
      { kind: 'result', id: req.id, mesh, cards, stride, count: cards.length / stride, charset, timings: { loadMs, generateMs } },
      transfer,
      true,
    );
  } catch (err) {
    // A WebAssembly trap (panic, out of memory) leaves the instance unusable:
    // flag it so the client replaces this worker.
    const fatal = err instanceof WebAssembly.RuntimeError;
    ctx.postMessage({ kind: 'error', id: req.id, message: errorMessage(err), fatal });
  }
}

function generate(engine: wasm.Engine, s: CardSettings, charset: string): Float32Array {
  const c = new wasm.CardConfig();
  try {
    c.seed = s.seed >>> 0;
    c.glyphSize = s.glyphSize;
    c.sizeFactor = s.sizeFactor;
    c.glyphRule = GLYPH_RULES[s.glyphRule];
    c.patternScale = s.patternScale;
    c.glyphAspect = s.glyphAspect;
    [c.r, c.g, c.b] = s.color;
    c.colorJitter = s.colorJitter;
    c.twist = s.twist;
    c.tilt = s.tilt;
    c.alphaMin = s.alphaMin;
    c.alphaMax = s.alphaMax;
    return engine.generate(c, charset);
  } finally {
    c.free();
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
