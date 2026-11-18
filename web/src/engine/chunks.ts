// Spatial chunks for render-time culling and level of detail.
//
// Cards are grouped into square ground cells (CHUNK_SIZE metres); the renderer
// skips chunks outside the view entirely (frustum culling).
// Sky, rain and blown leaves go in one "global" chunk that is always drawn
// in full. Runs in the worker.

/** Chunk side in metres. */
export const CHUNK_SIZE = 16;

/** Floats per chunk record. */
export const CHUNK_FLOATS = 10;
// start, count, min x, min y, min z, max x, max y, max z, max card size, global (0/1)

const MATERIAL_SHIFT = 1024;
const MAX_MATERIALS = 64;
/** Card modes that are never culled or thinned: sky (4), rain (5), leaves (6). */
const GLOBAL_MODES = new Set([4, 5, 6]);

export interface Chunked {
  cards: Float32Array;
  chunks: Float32Array;
}

/** Small deterministic PRNG (mulberry32), so shuffles are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Group, shuffle and reorder cards; `allGlobal` puts everything in one unthinned chunk. */
export function chunkCards(cards: Float32Array, stride: number, allGlobal = false): Chunked {
  const n = cards.length / stride;
  const keyOf = new Int32Array(n);
  const ids = new Map<number, number>(); // cell key -> chunk index
  const counts: number[] = [];
  const GLOBAL_KEY = 0x7fffffff;
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const mode = Math.floor(cards[o + 13]! / MATERIAL_SHIFT / MAX_MATERIALS);
    let key = GLOBAL_KEY;
    if (!allGlobal && !GLOBAL_MODES.has(mode)) {
      const cx = Math.floor(cards[o]! / CHUNK_SIZE) + 512;
      const cz = Math.floor(cards[o + 2]! / CHUNK_SIZE) + 512;
      key = cx * 1024 + cz;
    }
    let c = ids.get(key);
    if (c === undefined) {
      c = counts.length;
      ids.set(key, c);
      counts.push(0);
    }
    keyOf[i] = c;
    counts[c]!++;
  }
  const starts = new Int32Array(counts.length);
  for (let c = 1; c < counts.length; c++) starts[c] = starts[c - 1]! + counts[c - 1]!;
  const fill = starts.slice();
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[keyOf[i]!]!++] = i;

  const out = new Float32Array(cards.length);
  const chunks = new Float32Array(counts.length * CHUNK_FLOATS);
  const globalIndex = ids.get(GLOBAL_KEY);
  for (let c = 0; c < counts.length; c++) {
    const s = starts[c]!;
    const m = counts[c]!;
    // Shuffle so any prefix of the chunk is a uniform sample of it.
    const r = rng(c * 7919 + 13);
    for (let i = m - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = order[s + i]!;
      order[s + i] = order[s + j]!;
      order[s + j] = t;
    }
    let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity, size = 0;
    for (let k = 0; k < m; k++) {
      const src = order[s + k]! * stride;
      const dst = (s + k) * stride;
      out.set(cards.subarray(src, src + stride), dst);
      const x = cards[src]!, y = cards[src + 1]!, z = cards[src + 2]!;
      if (x < lx) lx = x;
      if (y < ly) ly = y;
      if (z < lz) lz = z;
      if (x > hx) hx = x;
      if (y > hy) hy = y;
      if (z > hz) hz = z;
      const v = Math.hypot(cards[src + 6]!, cards[src + 7]!, cards[src + 8]!);
      if (v > size) size = v;
    }
    chunks.set([s, m, lx, ly, lz, hx, hy, hz, size, c === globalIndex ? 1 : 0], c * CHUNK_FLOATS);
  }
  return { cards: out, chunks };
}
