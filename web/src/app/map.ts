// The edited map: everything painted or placed on the canvas, stored per
// chunk. This is the source of truth for the scene: the engine only turns
// one chunk's data into glyphs, and the streamer rebuilds a chunk whenever
// its data changes. Saving (TODO step 9) will write out exactly this.
//
// Rules for things that cross chunk borders:
//   * ground tiles: each tile belongs to exactly one chunk, by coordinates.
//     A paint over a border writes into every chunk it touches.
//   * objects: belong to the chunk holding their base point (x, z), even if
//     their crown hangs over the next chunk. That chunk draws them whole.
// Chunks with no paint and no objects are not stored at all.

export interface MapInfo {
  /** Chunk side (m). */
  chunkSize: number;
  /** Ground tile side (m). */
  tile: number;
  /** Tiles per chunk side. */
  tiles: number;
  /** Ground paint names; the index is the byte stored per tile (0 = canvas). */
  groundKinds: string[];
  /** Object kind names ("tree:oak"); the index is the kind code. */
  objectKinds: string[];
}

export interface PlacedObject {
  id: number;
  /** One of `MapInfo.objectKinds`, e.g. "tree:oak". */
  kind: string;
  /** Picks the generated variant. */
  seed: number;
  x: number;
  z: number;
  /** Rotation round the vertical axis, radians. */
  yaw: number;
  scale: number;
}

export type NewObject = Omit<PlacedObject, 'id' | 'yaw' | 'scale' | 'seed'> & Partial<Pick<PlacedObject, 'yaw' | 'scale' | 'seed'>>;

interface ChunkEdits {
  /** tiles x tiles ground codes, row-major (z rows), or null for all canvas. */
  tiles: Uint8Array | null;
  objects: PlacedObject[];
}

/** What the engine needs to build one chunk. */
export interface ChunkPayload {
  tiles: Uint8Array | null;
  /** kind code, seed, x, z, yaw, scale per object. */
  objects: Float32Array;
  /** Changes every time the chunk's data changes. */
  rev: number;
}

export const OBJECT_FLOATS = 6;

export function chunkKey(cx: number, cz: number): string {
  return `w${cx},${cz}`;
}

export class MapData {
  private chunks = new Map<string, ChunkEdits>();
  /** Revision per chunk key; never forgotten, so stale builds are always recognised. */
  private revs = new Map<string, number>();
  private counter = 0;
  private nextId = 1;
  private listeners = new Set<(keys: string[]) => void>();

  constructor(readonly info: MapInfo) {}

  /** Called with the keys of the chunks whose data changed. */
  onChange(f: (keys: string[]) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  chunkOf(x: number, z: number): [number, number] {
    const S = this.info.chunkSize;
    return [Math.floor(x / S), Math.floor(z / S)];
  }

  /** Number of chunks holding paint or objects. */
  get editedChunks(): number {
    return this.chunks.size;
  }

  get objectCount(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.objects.length;
    return n;
  }

  revision(key: string): number {
    return this.revs.get(key) ?? 0;
  }

  /** Ground paint at (x, z). */
  groundAt(x: number, z: number): string {
    const [cx, cz] = this.chunkOf(x, z);
    const tiles = this.chunks.get(chunkKey(cx, cz))?.tiles;
    if (!tiles) return this.info.groundKinds[0]!;
    const { tile, tiles: n, chunkSize: S } = this.info;
    const ti = Math.min(Math.floor((x - cx * S) / tile), n - 1);
    const tj = Math.min(Math.floor((z - cz * S) / tile), n - 1);
    return this.info.groundKinds[tiles[tj * n + ti]!]!;
  }

  /**
   * Paint every tile whose centre lies in the rectangle [x0, x1) x [z0, z1)
   * with `kind` ("canvas" erases). Returns the keys of the chunks that changed.
   */
  paintRect(x0: number, z0: number, x1: number, z1: number, kind: string): string[] {
    const t = this.info.tile;
    return this.paintTiles(Math.floor(x0 / t), Math.floor(z0 / t), Math.ceil(x1 / t), Math.ceil(z1 / t), kind,
      (gi, gj) => {
        const x = (gi + 0.5) * t, z = (gj + 0.5) * t;
        return x >= x0 && x < x1 && z >= z0 && z < z1;
      });
  }

  /** Paint every tile whose centre lies within `r` metres of (x, z). */
  paintCircle(x: number, z: number, r: number, kind: string): string[] {
    const t = this.info.tile;
    return this.paintTiles(Math.floor((x - r) / t), Math.floor((z - r) / t), Math.ceil((x + r) / t), Math.ceil((z + r) / t), kind,
      (gi, gj) => Math.hypot((gi + 0.5) * t - x, (gj + 0.5) * t - z) <= r);
  }

  /** Paint global tiles [gi0, gi1) x [gj0, gj1) that pass `inside`. */
  private paintTiles(gi0: number, gj0: number, gi1: number, gj1: number, kind: string, inside: (gi: number, gj: number) => boolean): string[] {
    const code = this.info.groundKinds.indexOf(kind);
    if (code < 0) throw new Error(`unknown ground ${JSON.stringify(kind)} (${this.info.groundKinds.join(', ')})`);
    const n = this.info.tiles;
    const changed = new Set<string>();
    for (let gj = gj0; gj < gj1; gj++) {
      for (let gi = gi0; gi < gi1; gi++) {
        if (!inside(gi, gj)) continue;
        const cx = Math.floor(gi / n), cz = Math.floor(gj / n);
        const key = chunkKey(cx, cz);
        let c = this.chunks.get(key);
        const old = c?.tiles?.[(gj - cz * n) * n + (gi - cx * n)] ?? 0;
        if (old === code) continue;
        if (!c) this.chunks.set(key, (c = { tiles: null, objects: [] }));
        c.tiles ??= new Uint8Array(n * n);
        c.tiles[(gj - cz * n) * n + (gi - cx * n)] = code;
        changed.add(key);
      }
    }
    for (const key of changed) this.tidy(key);
    return this.changed([...changed]);
  }

  /** Place an object; it belongs to the chunk holding (x, z). */
  addObject(o: NewObject): PlacedObject {
    if (!this.info.objectKinds.includes(o.kind)) throw new Error(`unknown object ${JSON.stringify(o.kind)}`);
    if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) throw new Error('object position must be finite');
    const obj: PlacedObject = {
      id: this.nextId++, kind: o.kind, x: o.x, z: o.z,
      seed: (o.seed ?? Math.floor(Math.random() * 0xffff)) >>> 0, yaw: o.yaw ?? 0, scale: o.scale ?? 1,
    };
    const key = chunkKey(...this.chunkOf(obj.x, obj.z));
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = { tiles: null, objects: [] }));
    c.objects.push(obj);
    this.changed([key]);
    return obj;
  }

  removeObject(id: number): boolean {
    for (const [key, c] of this.chunks) {
      const i = c.objects.findIndex((o) => o.id === id);
      if (i < 0) continue;
      c.objects.splice(i, 1);
      this.tidy(key);
      this.changed([key]);
      return true;
    }
    return false;
  }

  /** Objects whose base is in chunk (cx, cz). */
  objectsIn(cx: number, cz: number): readonly PlacedObject[] {
    return this.chunks.get(chunkKey(cx, cz))?.objects ?? [];
  }

  /** Everything the engine needs to build chunk (cx, cz). */
  payload(cx: number, cz: number): ChunkPayload {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    const objs = c?.objects ?? [];
    const objects = new Float32Array(objs.length * OBJECT_FLOATS);
    objs.forEach((o, i) => objects.set([this.info.objectKinds.indexOf(o.kind), o.seed % 0x1000000, o.x, o.z, o.yaw, o.scale], i * OBJECT_FLOATS));
    return { tiles: c?.tiles ? c.tiles.slice() : null, objects, rev: this.revision(key) };
  }

  /** Forget a chunk's storage once it holds nothing (all canvas, no objects). */
  private tidy(key: string): void {
    const c = this.chunks.get(key);
    if (!c) return;
    if (c.tiles && c.tiles.every((v) => v === 0)) c.tiles = null;
    if (!c.tiles && c.objects.length === 0) this.chunks.delete(key);
  }

  private changed(keys: string[]): string[] {
    if (keys.length === 0) return keys;
    for (const k of keys) this.revs.set(k, ++this.counter);
    for (const f of this.listeners) f(keys);
    return keys;
  }
}
