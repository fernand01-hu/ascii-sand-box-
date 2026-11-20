// Promise-based front end for the engine workers. Restarts a worker by itself
// if its WASM instance ever crashes.
//
// One main worker handles models, galleries and world setup. Streamed world
// (canvas) chunks are built in parallel by a pool of chunk workers, each
// holding its own copy of the (deterministic) world, so chunk building uses several
// CPU cores and never blocks a scene switch.

import type { ChunkPayload } from '../app/map';
import type { CardSettings, EngineResult, GalleryCategory, TestbedRequest, WorkerRequest, WorkerResponse } from './protocol';

/** Thrown for requests the worker skipped because a newer one replaced them. */
export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer request');
    this.name = 'SupersededError';
  }
}

interface Pending {
  resolve: (r: EngineResult) => void;
  reject: (e: Error) => void;
}

/** One worker and the requests it still owes an answer to. */
class Slot {
  worker!: Worker;
  pending = new Map<number, Pending>();

  constructor(
    private onRestart: (slot: Slot) => void,
    private isDisposed: () => boolean,
  ) {
    this.spawn();
  }

  get load(): number {
    return this.pending.size;
  }

  private spawn(): void {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.restart(new Error(`engine worker failed: ${e.message || 'unknown error'}`));
    };
    this.worker.onmessageerror = () => this.restart(new Error('engine worker sent an unreadable message'));
  }

  send(req: WorkerRequest, transfer: Transferable[] = []): Promise<EngineResult> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      this.worker.postMessage(req, transfer);
    });
  }

  /** Send without expecting an answer. */
  post(req: WorkerRequest): void {
    this.worker.postMessage(req);
  }

  private receive(msg: WorkerResponse): void {
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (msg.kind === 'skipped') {
      p?.reject(new SupersededError());
      return;
    }
    if (msg.kind === 'error') {
      if (msg.fatal) this.restart(new Error(`engine crashed: ${msg.message}`));
      p?.reject(new Error(msg.message));
      return;
    }
    const { kind: _k, id: _i, ...result } = msg;
    p?.resolve(result);
  }

  private restart(reason: Error): void {
    this.worker.terminate();
    this.failAll(reason);
    if (!this.isDisposed()) {
      this.spawn();
      this.onRestart(this);
    }
  }

  failAll(reason: Error): void {
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }

  terminate(reason: Error): void {
    this.worker.terminate();
    this.failAll(reason);
  }
}

/** Chunk workers to use: leave a core for the page and one for the main worker. */
function poolSize(): number {
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  return Math.min(Math.max(cores - 2, 1), 6);
}

export class EngineClient {
  private nextId = 1;
  private disposed = false;
  private main: Slot;
  /** Chunk workers, spawned on the first world. */
  private pool: Slot[] = [];
  /** The world the chunk workers should hold (re-sent after a restart). */
  private world: { seed: number; day: boolean } | null = null;

  constructor() {
    this.main = new Slot(() => {}, () => this.disposed);
  }

  /** Requests each worker still owes an answer to: the main worker, then each chunk worker. */
  queue(): { main: number; chunks: number[] } {
    return { main: this.main.load, chunks: this.pool.map((s) => s.load) };
  }

  /** Number of workers building world chunks in parallel. */
  get chunkWorkers(): number {
    return poolSize();
  }

  /** Parse an STL (the buffer is transferred, not copied) and generate cards. */
  load(bytes: ArrayBuffer, settings: CardSettings, zUp = true): Promise<EngineResult> {
    this.setWorld(null);
    return this.send({ kind: 'load', id: this.nextId++, bytes, zUp, settings }, [bytes]);
  }

  /** Regenerate cards for the current mesh with new settings. */
  generate(settings: CardSettings): Promise<EngineResult> {
    return this.send({ kind: 'generate', id: this.nextId++, settings });
  }

  /** Build a gallery sheet of procedural scenery assets. */
  gallery(category: GalleryCategory, seed: number, glyphAspect: number): Promise<EngineResult> {
    this.setWorld(null);
    return this.send({ kind: 'gallery', id: this.nextId++, category, seed, glyphAspect });
  }

  /** Start the canvas world: returns its sky and setup. */
  worldInit(seed: number, day: boolean, glyphAspect: number): Promise<EngineResult> {
    this.setWorld({ seed, day });
    return this.send({ kind: 'worldInit', id: this.nextId++, seed, day, glyphAspect });
  }

  /** Build one world chunk from its map data, glyphs sized for `eye`, on the least busy chunk worker. */
  worldChunk(cx: number, cz: number, eye: [number, number, number], glyphAspect: number, data: ChunkPayload): Promise<EngineResult> {
    if (this.disposed) return Promise.reject(new Error('engine disposed'));
    if (this.pool.length === 0) return Promise.reject(new Error('no world: call worldInit first'));
    let slot = this.pool[0]!;
    for (const s of this.pool) if (s.load < slot.load) slot = s;
    const transfer: Transferable[] = [data.objects.buffer];
    if (data.tiles) transfer.push(data.tiles.buffer);
    return slot.send({ kind: 'worldChunk', id: this.nextId++, cx, cz, eye, glyphAspect, ...data }, transfer);
  }

  /** Build a test scene (dev/test builds only). */
  testbed(req: TestbedRequest): Promise<EngineResult> {
    this.setWorld(null);
    return this.send({ kind: 'testbed', id: this.nextId++, ...req });
  }

  dispose(): void {
    this.disposed = true;
    const reason = new Error('engine disposed');
    this.main.terminate(reason);
    for (const s of this.pool) s.terminate(reason);
  }

  /** Give every chunk worker the new world (or free it); queued chunks for the old one are skipped. */
  private setWorld(w: { seed: number; day: boolean } | null): void {
    this.world = w;
    if (w && this.pool.length === 0) {
      for (let i = 0; i < poolSize(); i++) this.pool.push(new Slot((s) => this.setupSlot(s), () => this.disposed));
    }
    for (const s of this.pool) this.setupSlot(s);
  }

  private setupSlot(s: Slot): void {
    s.post({ kind: 'worldSetup', id: this.nextId++, seed: this.world?.seed ?? null, day: this.world?.day ?? false });
  }

  private send(req: WorkerRequest, transfer: Transferable[] = []): Promise<EngineResult> {
    if (this.disposed) return Promise.reject(new Error('engine disposed'));
    return this.main.send(req, transfer);
  }
}
