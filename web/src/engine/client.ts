// Promise-based front end for the engine worker. Restarts the worker by
// itself if the WASM instance ever crashes.

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

export class EngineClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private disposed = false;

  constructor() {
    this.spawn();
  }

  /** Parse an STL (the buffer is transferred, not copied) and generate cards. */
  load(bytes: ArrayBuffer, settings: CardSettings, zUp = true): Promise<EngineResult> {
    return this.send({ kind: 'load', id: this.nextId++, bytes, zUp, settings }, [bytes]);
  }

  /** Regenerate cards for the current mesh with new settings. */
  generate(settings: CardSettings): Promise<EngineResult> {
    return this.send({ kind: 'generate', id: this.nextId++, settings });
  }

  /** Build a gallery sheet of procedural scenery assets. */
  gallery(category: GalleryCategory, seed: number, glyphAspect: number): Promise<EngineResult> {
    return this.send({ kind: 'gallery', id: this.nextId++, category, seed, glyphAspect });
  }

  /** Build a test scene (dev/test builds only). */
  testbed(req: TestbedRequest): Promise<EngineResult> {
    return this.send({ kind: 'testbed', id: this.nextId++, ...req });
  }

  dispose(): void {
    this.disposed = true;
    this.worker.terminate();
    this.failAll(new Error('engine disposed'));
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

  private send(req: WorkerRequest, transfer: Transferable[] = []): Promise<EngineResult> {
    if (this.disposed) return Promise.reject(new Error('engine disposed'));
    return new Promise((resolve, reject) => {
      this.pending.set(req.id, { resolve, reject });
      this.worker.postMessage(req, transfer);
    });
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
    if (!this.disposed) this.spawn();
  }

  private failAll(reason: Error): void {
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }
}
