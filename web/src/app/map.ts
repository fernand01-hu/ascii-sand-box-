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
//
// Every change is also reported as an edit (tiles with old and new codes,
// objects added or removed), which the undo history records. This file has
// no runtime imports, so it can be unit-tested with node --test.

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
  /** Generator parameters per kind (from the engine), for defaults and names. */
  objectParams?: Record<string, ParamInfo[]>;
}

/** One generator parameter of a kind (see engine scenery/params.rs). */
export interface ParamInfo {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
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
  /**
   * Generator parameter values in the kind's order (see MapInfo.objectParams);
   * missing = all defaults. Never changed in place: replaced as a whole.
   */
  params?: number[];
}

export type NewObject = Omit<PlacedObject, 'id' | 'yaw' | 'scale' | 'seed'> & Partial<Pick<PlacedObject, 'yaw' | 'scale' | 'seed' | 'params'>>;

interface ChunkEdits {
  /** tiles x tiles ground codes, row-major (z rows), or null for all canvas. */
  tiles: Uint8Array | null;
  objects: PlacedObject[];
  /**
   * Ground heights at the (chunkSize + 1)^2 points of a 1 m grid from the
   * chunk corner, or null for flat. Border points are shared: written into
   * every chunk that holds them.
   */
  heights?: Float32Array | null;
}

/** What the engine needs to build one chunk. */
export interface ChunkPayload {
  tiles: Uint8Array | null;
  /** (chunkSize + 1)^2 heights or null (flat). */
  heights: Float32Array | null;
  /** kind code, seed, x, z, yaw, scale per object. */
  objects: Float32Array;
  /** Changes every time the chunk's data changes. */
  rev: number;
}

/** Parameter value slots per object in a chunk request (engine MAX_PARAMS). */
export const MAX_PARAMS = 16;
/** Floats per object in a chunk request: kind, seed, x, z, yaw, scale, parameters. */
export const OBJECT_FLOATS = 6 + MAX_PARAMS;

/** One chunk's saved ground: paint (or null) and heights (or null). */
export interface ChunkData {
  cx: number;
  cz: number;
  tiles: Uint8Array | null;
  heights: Float32Array | null;
}

/** One change to the map, as the undo history records it. */
export interface MapEdit {
  tiles?: TileChange[];
  heights?: HeightChange[];
  added?: PlacedObject[];
  removed?: PlacedObject[];
}

/** One ground height point moved: global point index (1 m grid), old and new height (m). */
export interface HeightChange {
  vi: number;
  vj: number;
  from: number;
  to: number;
}

/** One tile repainted: global tile index, old and new ground code. */
export interface TileChange {
  gi: number;
  gj: number;
  from: number;
  to: number;
}

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
  private editListeners = new Set<(edit: MapEdit) => void>();
  readonly info: MapInfo;
  /** Height points per chunk side (1 m apart, borders shared). */
  readonly hv: number;
  /** Chunks holding heights (so a flat map answers height questions fast). */
  private hilly = 0;

  constructor(info: MapInfo) {
    this.info = info;
    this.hv = Math.round(info.chunkSize) + 1;
  }

  // ---- heights -------------------------------------------------------------------

  /** Height (m) of global point (vi, vj) on the 1 m grid. */
  pointHeight(vi: number, vj: number): number {
    if (!this.hilly) return 0;
    const S = this.hv - 1, cx = Math.floor(vi / S), cz = Math.floor(vj / S);
    return this.chunks.get(chunkKey(cx, cz))?.heights?.[(vj - cz * S) * this.hv + (vi - cx * S)] ?? 0;
  }

  /** Ground height (m) at (x, z), bilinear between the 1 m points. */
  heightAt(x: number, z: number): number {
    if (!this.hilly) return 0;
    const i = Math.floor(x), j = Math.floor(z), tx = x - i, tz = z - j;
    const a = this.pointHeight(i, j) * (1 - tx) + this.pointHeight(i + 1, j) * tx;
    const b = this.pointHeight(i, j + 1) * (1 - tx) + this.pointHeight(i + 1, j + 1) * tx;
    return a * (1 - tz) + b * tz;
  }

  /** Whether any chunk holds heights. */
  get hasHeights(): boolean {
    return this.hilly > 0;
  }

  /** Whether chunk (cx, cz) holds heights. */
  hasHeightsIn(cx: number, cz: number): boolean {
    return !!this.chunks.get(chunkKey(cx, cz))?.heights;
  }

  /**
   * Set ground heights at global points. A border point goes into every
   * chunk that holds it, so neighbours always agree. Reported as one edit.
   */
  setHeights(list: readonly { vi: number; vj: number; h: number }[]): { keys: string[]; changes: HeightChange[] } {
    const S = this.hv - 1, n = this.hv;
    const changed = new Set<string>();
    const changes: HeightChange[] = [];
    for (const { vi, vj, h } of list) {
      if (!Number.isFinite(h)) throw new Error('heights must be finite');
      const v = Math.max(-300, Math.min(300, h));
      const old = this.pointHeight(vi, vj);
      if (Math.abs(old - v) < 1e-6) continue;
      const cxs = [Math.floor(vi / S)], czs = [Math.floor(vj / S)];
      if (vi % S === 0) cxs.push(vi / S - 1);
      if (vj % S === 0) czs.push(vj / S - 1);
      for (const cx of cxs) {
        for (const cz of czs) {
          const key = chunkKey(cx, cz);
          let c = this.chunks.get(key);
          if (!c) this.chunks.set(key, (c = { tiles: null, objects: [] }));
          if (!c.heights) {
            c.heights = new Float32Array(n * n);
            this.hilly++;
          }
          c.heights[(vj - cz * S) * n + (vi - cx * S)] = v;
          changed.add(key);
        }
      }
      changes.push({ vi, vj, from: old, to: v });
    }
    for (const key of changed) this.tidy(key);
    if (changes.length) this.edited({ heights: changes });
    return { keys: this.changed([...changed]), changes };
  }

  /** Called with every edit (for the undo history). */
  onEdit(f: (edit: MapEdit) => void): () => void {
    this.editListeners.add(f);
    return () => this.editListeners.delete(f);
  }

  private edited(edit: MapEdit): void {
    for (const f of this.editListeners) f(edit);
  }

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
    const tiles: [number, number][] = [];
    for (let gj = gj0; gj < gj1; gj++) for (let gi = gi0; gi < gi1; gi++) if (inside(gi, gj)) tiles.push([gi, gj]);
    return this.paintTileList(tiles, kind).keys;
  }

  /**
   * Paint these global tiles (index i covers [i * tile, (i + 1) * tile))
   * with `kind`. Returns the chunks that changed and, per tile that really
   * changed, its old and new code: everything undo needs.
   */
  paintTileList(tiles: readonly (readonly [number, number])[], kind: string): { keys: string[]; changes: TileChange[] } {
    const code = this.info.groundKinds.indexOf(kind);
    if (code < 0) throw new Error(`unknown ground ${JSON.stringify(kind)} (${this.info.groundKinds.join(', ')})`);
    return this.setTiles(tiles.map(([gi, gj]) => ({ gi, gj, code })));
  }

  /** Set tiles to codes (undo / redo use this with a change list). */
  setTiles(list: readonly { gi: number; gj: number; code: number }[]): { keys: string[]; changes: TileChange[] } {
    const n = this.info.tiles;
    const changed = new Set<string>();
    const changes: TileChange[] = [];
    for (const { gi, gj, code } of list) {
      if (!Number.isInteger(code) || code < 0 || code >= this.info.groundKinds.length) throw new Error(`bad ground code ${code}`);
      const cx = Math.floor(gi / n), cz = Math.floor(gj / n);
      const key = chunkKey(cx, cz);
      let c = this.chunks.get(key);
      const at = (gj - cz * n) * n + (gi - cx * n);
      const old = c?.tiles?.[at] ?? 0;
      if (old === code) continue;
      if (!c) this.chunks.set(key, (c = { tiles: null, objects: [] }));
      c.tiles ??= new Uint8Array(n * n);
      c.tiles[at] = code;
      changes.push({ gi, gj, from: old, to: code });
      changed.add(key);
    }
    for (const key of changed) this.tidy(key);
    if (changes.length) this.edited({ tiles: changes });
    return { keys: this.changed([...changed]), changes };
  }

  /** The ground code of global tile (gi, gj). */
  tileCode(gi: number, gj: number): number {
    const n = this.info.tiles, cx = Math.floor(gi / n), cz = Math.floor(gj / n);
    return this.chunks.get(chunkKey(cx, cz))?.tiles?.[(gj - cz * n) * n + (gi - cx * n)] ?? 0;
  }

  /** Place an object; it belongs to the chunk holding (x, z). */
  addObject(o: NewObject): PlacedObject {
    if (!this.info.objectKinds.includes(o.kind)) throw new Error(`unknown object ${JSON.stringify(o.kind)}`);
    if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) throw new Error('object position must be finite');
    if (o.params && (o.params.length > MAX_PARAMS || !o.params.every(Number.isFinite))) throw new Error('object parameters must be at most 16 finite numbers');
    const obj: PlacedObject = {
      id: this.nextId++, kind: o.kind, x: o.x, z: o.z,
      seed: (o.seed ?? Math.floor(Math.random() * 0xffff)) >>> 0, yaw: o.yaw ?? 0, scale: o.scale ?? 1,
      ...(o.params?.length ? { params: [...o.params] } : {}),
    };
    this.insert(obj);
    return obj;
  }

  /** Put back an object exactly as it was, id included (undo / redo). */
  restoreObject(o: PlacedObject): void {
    if (this.object(o.id)) return;
    this.nextId = Math.max(this.nextId, o.id + 1);
    this.insert({ ...o });
  }

  private insert(obj: PlacedObject): void {
    const key = chunkKey(...this.chunkOf(obj.x, obj.z));
    let c = this.chunks.get(key);
    if (!c) this.chunks.set(key, (c = { tiles: null, objects: [] }));
    c.objects.push(obj);
    this.edited({ added: [{ ...obj }] });
    this.changed([key]);
  }

  removeObject(id: number): boolean {
    for (const [key, c] of this.chunks) {
      const i = c.objects.findIndex((o) => o.id === id);
      if (i < 0) continue;
      const [gone] = c.objects.splice(i, 1);
      this.tidy(key);
      this.edited({ removed: [{ ...gone! }] });
      this.changed([key]);
      return true;
    }
    return false;
  }

  /** Everything the map holds, for saving: painted chunks (tile codes, copied) and objects. */
  exportData(): { chunks: ChunkData[]; objects: PlacedObject[] } {
    const chunks: ChunkData[] = [];
    const objects: PlacedObject[] = [];
    for (const [key, c] of this.chunks) {
      const m = /^w(-?\d+),(-?\d+)$/.exec(key);
      if ((c.tiles || c.heights) && m) chunks.push({ cx: Number(m[1]), cz: Number(m[2]), tiles: c.tiles ? c.tiles.slice() : null, heights: c.heights ? c.heights.slice() : null });
      objects.push(...c.objects.map((o) => ({ ...o })));
    }
    return { chunks, objects };
  }

  /**
   * Replace everything with saved content (tile codes already in this map's
   * ground list). Reported as edits like any change, so it can be undone.
   */
  replaceWith(chunks: readonly ChunkData[], objects: readonly PlacedObject[]): void {
    this.clear();
    const n = this.info.tiles, hv = this.hv, S = hv - 1;
    const list: { gi: number; gj: number; code: number }[] = [];
    const hs: { vi: number; vj: number; h: number }[] = [];
    for (const k of chunks) {
      if (k.tiles && k.tiles.length !== n * n) throw new Error(`chunk ${k.cx},${k.cz}: ${k.tiles.length} tiles, expected ${n * n}`);
      if (k.heights && k.heights.length !== hv * hv) throw new Error(`chunk ${k.cx},${k.cz}: ${k.heights.length} heights, expected ${hv * hv}`);
      k.tiles?.forEach((code, at) => {
        if (code) list.push({ gi: k.cx * n + (at % n), gj: k.cz * n + Math.floor(at / n), code });
      });
      k.heights?.forEach((h, at) => {
        if (h) hs.push({ vi: k.cx * S + (at % hv), vj: k.cz * S + Math.floor(at / hv), h });
      });
    }
    if (list.length) this.setTiles(list);
    if (hs.length) this.setHeights(hs);
    for (const o of objects) {
      if (!this.info.objectKinds.includes(o.kind)) throw new Error(`unknown object ${JSON.stringify(o.kind)}`);
      this.restoreObject(o);
    }
  }

  /** Every placed object, in no particular order. */
  allObjects(): PlacedObject[] {
    return [...this.chunks.values()].flatMap((c) => c.objects);
  }

  /** Whether chunk (cx, cz) holds any paint. */
  hasPaint(cx: number, cz: number): boolean {
    return !!this.chunks.get(chunkKey(cx, cz))?.tiles;
  }

  /** Painted tiles per ground kind in chunk (cx, cz) (canvas included). */
  paintCounts(cx: number, cz: number): Record<string, number> {
    const tiles = this.chunks.get(chunkKey(cx, cz))?.tiles;
    const out: Record<string, number> = {};
    if (!tiles) return out;
    for (const v of tiles) {
      const k = this.info.groundKinds[v] ?? `#${v}`;
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  /** The object with this id, or undefined. */
  object(id: number): PlacedObject | undefined {
    for (const c of this.chunks.values()) {
      const o = c.objects.find((o) => o.id === id);
      if (o) return o;
    }
    return undefined;
  }

  /** Remove every edit. Returns the keys of the chunks that changed. */
  clear(): string[] {
    const keys = [...this.chunks.keys()];
    // Report what goes, so clearing can be undone.
    const n = this.info.tiles, tiles: TileChange[] = [], removed: PlacedObject[] = [], heights: HeightChange[] = [];
    const hv = this.hv, S = hv - 1;
    for (const [key, c] of this.chunks) {
      const m = /^w(-?\d+),(-?\d+)$/.exec(key);
      if (!m) continue;
      const cx = Number(m[1]), cz = Number(m[2]);
      c.tiles?.forEach((code, at) => {
        if (code) tiles.push({ gi: cx * n + (at % n), gj: cz * n + Math.floor(at / n), from: code, to: 0 });
      });
      // Each point once: from the chunk it belongs to (local index below the far border).
      c.heights?.forEach((h, at) => {
        const i = at % hv, j = Math.floor(at / hv);
        if (h && i < S && j < S) heights.push({ vi: cx * S + i, vj: cz * S + j, from: h, to: 0 });
      });
      removed.push(...c.objects.map((o) => ({ ...o })));
    }
    this.chunks.clear();
    this.hilly = 0;
    if (tiles.length || removed.length || heights.length) this.edited({ tiles, removed, ...(heights.length ? { heights } : {}) });
    return this.changed(keys);
  }

  /** Objects whose base is within `r` metres of (x, z), from every chunk that close. */
  objectsNear(x: number, z: number, r: number): PlacedObject[] {
    const S = this.info.chunkSize, out: PlacedObject[] = [];
    for (let cz = Math.floor((z - r) / S); cz <= Math.floor((z + r) / S); cz++) {
      for (let cx = Math.floor((x - r) / S); cx <= Math.floor((x + r) / S); cx++) {
        for (const o of this.chunks.get(chunkKey(cx, cz))?.objects ?? []) if (Math.hypot(o.x - x, o.z - z) <= r) out.push(o);
      }
    }
    return out;
  }

  /**
   * Move / turn / resize an object, keeping its id (it may change chunk).
   * One edit (removed old + added new), so it undoes in one go.
   */
  updateObject(id: number, change: Partial<Pick<PlacedObject, 'x' | 'z' | 'yaw' | 'scale' | 'params'>>): PlacedObject | null {
    const old = this.object(id);
    if (!old) return null;
    const next: PlacedObject = { ...old, ...change };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.z)) throw new Error('object position must be finite');
    const oldKey = chunkKey(...this.chunkOf(old.x, old.z));
    const c = this.chunks.get(oldKey)!;
    c.objects.splice(c.objects.indexOf(old), 1);
    this.tidy(oldKey);
    const newKey = chunkKey(...this.chunkOf(next.x, next.z));
    let n = this.chunks.get(newKey);
    if (!n) this.chunks.set(newKey, (n = { tiles: null, objects: [] }));
    n.objects.push(next);
    this.edited({ removed: [{ ...old }], added: [{ ...next }] });
    this.changed(oldKey === newKey ? [oldKey] : [oldKey, newKey]);
    return next;
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
    objs.forEach((o, i) => {
      const at = i * OBJECT_FLOATS;
      objects.set([this.info.objectKinds.indexOf(o.kind), o.seed % 0x1000000, o.x, o.z, o.yaw, o.scale], at);
      // Parameters, or NaN: "the default" for the engine.
      for (let k = 0; k < MAX_PARAMS; k++) objects[at + 6 + k] = o.params?.[k] ?? NaN;
    });
    return { tiles: c?.tiles ? c.tiles.slice() : null, heights: c?.heights ? c.heights.slice() : null, objects, rev: this.revision(key) };
  }

  /** Forget a chunk's storage once it holds nothing (all canvas, no objects). */
  private tidy(key: string): void {
    const c = this.chunks.get(key);
    if (!c) return;
    if (c.tiles && c.tiles.every((v) => v === 0)) c.tiles = null;
    if (c.heights && c.heights.every((v) => v === 0)) {
      c.heights = null;
      this.hilly--;
    }
    if (!c.tiles && !c.heights && c.objects.length === 0) this.chunks.delete(key);
  }

  private changed(keys: string[]): string[] {
    if (keys.length === 0) return keys;
    for (const k of keys) this.revs.set(k, ++this.counter);
    for (const f of this.listeners) f(keys);
    return keys;
  }
}
