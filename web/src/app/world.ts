// Streams the canvas world around the viewer: requests chunks from the
// engine workers nearest-first, drops chunks that fall out of range, and
// rebuilds a chunk when
//   * its map data changed (paint, objects): only the chunks an edit
//     touched, before anything else, so edits show up at once. A build
//     that finishes after a newer edit is shown, then rebuilt again;
//   * the viewer has moved enough that its glyph sizes (chosen for the eye
//     at build time) are off: nearer -> finer, farther -> coarser, or looks
//     at it from a very different height (rows are spread by how low the
//     view grazes the ground). Screen density stays the same everywhere.
// Memory stays bounded: only chunks within `radius` (+2 before dropping)
// are kept; the edits themselves live in MapData, not here.

import type { EngineClient } from '../engine/client';
import type { WorldChunkData, WorldInfo } from '../engine/protocol';
import { glyphAspect } from '../render/atlas';
import type { Viewer } from '../render/viewer';
import { chunkKey, type MapData } from './map';
import { ColliderGrid, type Ground } from './physics';

interface Loaded {
  data: WorldChunkData;
  colliders: ColliderGrid;
}

export class WorldStreamer implements Ground {
  /** View distance in chunks. */
  radius = 9;
  /** Chunk requests in flight at once: two per chunk worker, so none sits idle. */
  maxInflight: number;
  private loaded = new Map<string, Loaded>();
  private inflight = new Set<string>();
  /** Loaded chunks whose map data changed since they were built. */
  private dirty = new Set<string>();
  private lastCheck = 0;
  private lastEye = { x: 0, y: 0, z: 0 };
  private alive = true;
  private unsubscribe: () => void;
  /** Chunks built so far (for tests and stats). */
  built = 0;
  /** Of those, rebuilds because the map data changed. */
  editBuilds = 0;
  /** Of those, rebuilds of loaded chunks because the viewer moved (glyph sizes). */
  viewBuilds = 0;
  private flushQueued = false;

  constructor(
    private engine: EngineClient,
    private viewer: Viewer,
    readonly info: WorldInfo,
    readonly map: MapData,
    private onError: (e: unknown) => void,
  ) {
    this.maxInflight = engine.chunkWorkers * 2;
    this.unsubscribe = map.onChange((keys) => {
      for (const k of keys) if (this.loaded.has(k) || this.inflight.has(k)) this.dirty.add(k);
      // Edits made together (one brush stroke, a script) start one build per chunk.
      if (this.flushQueued) return;
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        if (this.alive) this.update(this.lastEye, true);
      });
    });
  }

  private key(cx: number, cz: number): string {
    return chunkKey(cx, cz);
  }

  /** Loaded chunks still waiting for a rebuild after an edit. */
  get dirtyCount(): number {
    return this.dirty.size;
  }

  get loadedCount(): number {
    return this.loaded.size;
  }

  get pending(): number {
    return this.inflight.size;
  }

  /** Call every frame with the viewer's position. */
  update(eye: { x: number; y: number; z: number }, force = false): void {
    this.lastEye = { x: eye.x, y: eye.y, z: eye.z };
    const now = performance.now();
    if (!force && now - this.lastCheck < 150) return;
    this.lastCheck = now;
    const S = this.info.chunkSize;
    const ccx = Math.floor(eye.x / S), ccz = Math.floor(eye.z / S);
    const want: { cx: number; cz: number; prio: number }[] = [];
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        if (dx * dx + dz * dz > this.radius * this.radius + 1) continue;
        const cx = ccx + dx, cz = ccz + dz;
        const k = this.key(cx, cz);
        if (this.inflight.has(k)) continue;
        const centre = [(cx + 0.5) * S, (cz + 0.5) * S] as const;
        const dNow = Math.hypot(eye.x - centre[0], eye.z - centre[1]);
        const have = this.loaded.get(k);
        if (!have) {
          want.push({ cx, cz, prio: dNow });
          continue;
        }
        if (this.dirty.has(k)) {
          want.push({ cx, cz, prio: dNow - 1e6 }); // edits first
          continue;
        }
        // Rebuild when the glyph sizes chosen at build time are off by much.
        const [bx, by, bz] = have.data.eye;
        const dBuilt = Math.hypot(bx - centre[0], bz - centre[1]);
        const floor = S * 1.5;
        const ratio = Math.max(dNow, floor) / Math.max(dBuilt, floor);
        const moved = Math.hypot(eye.x - bx, eye.y - by, eye.z - bz);
        // ... or the view grazes the ground at a very different angle: the
        // engine spreads rows by it (glyph stacking), from the build eye.
        const g = this.info.ground;
        const graze = (h: number, d: number) => Math.max(h - g, 0.5) / Math.hypot(Math.max(h - g, 0.5), d);
        const angle = graze(eye.y, Math.max(dNow, floor)) / graze(by, Math.max(dBuilt, floor));
        if (ratio > 1.7 || ratio < 0.6 || angle > 1.7 || angle < 0.6 || moved > 0.6 * Math.max(dNow, floor)) want.push({ cx, cz, prio: dNow + 1000 });
      }
    }
    // Drop chunks well out of range.
    for (const [k, l] of this.loaded) {
      if (Math.hypot(l.data.cx - ccx, l.data.cz - ccz) > this.radius + 2) this.drop(k);
    }
    want.sort((a, b) => a.prio - b.prio);
    for (const w of want) {
      if (this.inflight.size >= this.maxInflight) break;
      this.request(w.cx, w.cz, [eye.x, eye.y, eye.z]);
    }
  }

  private request(cx: number, cz: number, eye: [number, number, number]): void {
    const k = this.key(cx, cz);
    this.inflight.add(k);
    const wasDirty = this.dirty.delete(k);
    const reload = !wasDirty && this.loaded.has(k);
    this.engine.worldChunk(cx, cz, eye, glyphAspect(), this.map.payload(cx, cz)).then(
      (res) => {
        this.inflight.delete(k);
        if (!this.alive || !res.chunk) return;
        // Edited again while this was building: show it, then build again.
        if (res.chunk.rev !== this.map.revision(k)) this.dirty.add(k);
        if (wasDirty) this.editBuilds++;
        if (reload) this.viewBuilds++;
        // Replace the old version only now, so nothing flickers out meanwhile.
        this.viewer.cards.addSet(k, res.cards, res.stride, res.chunks);
        if (res.mesh) this.viewer.addBody(k, res.mesh.positions, res.mesh.normals);
        this.loaded.set(k, { data: res.chunk, colliders: new ColliderGrid(res.chunk.colliders) });
        this.built++;
        this.viewer.requestRender();
      },
      (err) => {
        this.inflight.delete(k);
        if (wasDirty) this.dirty.add(k);
        if (this.alive && !(err instanceof Error && err.name === 'SupersededError')) this.onError(err);
      },
    );
  }

  private drop(k: string): void {
    this.viewer.cards.removeSet(k);
    this.viewer.removeBody(k);
    this.loaded.delete(k);
    this.dirty.delete(k);
  }

  dispose(): void {
    this.alive = false;
    this.unsubscribe();
    for (const k of [...this.loaded.keys()]) this.drop(k);
  }

  // ---- Ground (for the player physics) ---------------------------------------
  private chunkAt(x: number, z: number): Loaded | undefined {
    const S = this.info.chunkSize;
    return this.loaded.get(this.key(Math.floor(x / S), Math.floor(z / S)));
  }

  height(x: number, z: number): number {
    const l = this.chunkAt(x, z);
    if (!l) return NaN;
    const S = this.info.chunkSize;
    const n = this.info.grid + 1;
    const fx = Math.min(Math.max(x - l.data.cx * S, 0), n - 1.001);
    const fz = Math.min(Math.max(z - l.data.cz * S, 0), n - 1.001);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const tx = fx - ix, tz = fz - iz;
    const h = l.data.heights;
    const at = (i: number, j: number) => h[j * n + i]!;
    return (at(ix, iz) * (1 - tx) + at(ix + 1, iz) * tx) * (1 - tz) + (at(ix, iz + 1) * (1 - tx) + at(ix + 1, iz + 1) * tx) * tz;
  }

  isWater(_x: number, _z: number): boolean {
    return false; // a blank canvas has no water yet
  }

  inBounds(x: number, z: number): boolean {
    return this.chunkAt(x, z) !== undefined;
  }

  collidersNear(x: number, z: number, f: (cx: number, cz: number, r: number, top: number) => void): void {
    // Colliders can reach a little over a chunk edge: check the neighbours too.
    const S = this.info.chunkSize;
    const cx = Math.floor(x / S), cz = Math.floor(z / S);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) this.loaded.get(this.key(cx + dx, cz + dz))?.colliders.near(x, z, f);
    }
  }
}
