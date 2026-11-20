// Water map (look lab, water variants): a small texture round the camera,
// 1 texel per metre, that tells the water shader what the water is doing.
//   red    how far into the water from the shore (0 .. 1 = 10 m+)
//   green  how far from the water on land
//   blue, alpha  the current: direction and speed (0.5 = still)
// Rebuilt when the camera has moved a chunk away from its centre, or the
// paint or the heights changed.
//
// The current follows the land, the way real water does:
//   * each body of water drains toward its lowest part. A priority flood
//     from there climbs to every other cell; each cell's current points to
//     the cell it was reached from, so water runs downhill along the
//     channel, round its bends, and flat stretches drain by the shortest way;
//   * narrow water (a river or stream) runs, faster where it's steep;
//     wide water (a lake) is still, so a river's current fades out as it
//     opens into the lake;
//   * the field is smoothed so the current turns gently, not in 45 degree steps.

import { DataTexture, LinearFilter, RGBAFormat, Vector3 } from 'three';
import type { MapData } from './map';

const N = 256; // texels (m) per side
const REACH = 10; // metres mapped to 0..1
/** Fastest current stored (m/s); the texture holds speed / MAX_SPEED. */
export const MAX_SPEED = 2.5;

export class ShoreMap {
  readonly texture: DataTexture;
  /** min x, min z, size (m). */
  readonly box = new Vector3(0, 0, N);
  private data = new Uint8Array(N * N * 4);
  private centre: [number, number] | null = null;
  private stale = true;
  /** The current per cell (m/s along x and z), for the debug arrows. */
  flow = new Float32Array(N * N * 2);
  water = new Uint8Array(N * N);
  heights = new Float32Array(N * N);
  revision = 0;

  constructor() {
    this.texture = new DataTexture(this.data, N, N, RGBAFormat);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
  }

  /** The paint or the land changed: rebuild on the next update. */
  invalidate(): void {
    this.stale = true;
  }

  get size(): number {
    return N;
  }

  /** Rebuild if needed for a camera at (x, z). Returns true when it was rebuilt. */
  update(map: MapData, x: number, z: number): boolean {
    const S = map.info.chunkSize;
    const cx = Math.round(x / S) * S, cz = Math.round(z / S) * S;
    if (!this.stale && this.centre && Math.hypot(cx - this.centre[0], cz - this.centre[1]) < S) return false;
    this.centre = [cx, cz];
    this.stale = false;
    const x0 = cx - N / 2, z0 = cz - N / 2;
    this.box.set(x0, z0, N);
    const water = this.water, H = this.heights;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const k = j * N + i, wx = x0 + i + 0.5, wz = z0 + j + 0.5;
        water[k] = map.groundAt(wx, wz) === 'water' ? 1 : 0;
        H[k] = water[k] ? map.heightAt(wx, wz) : 0;
      }
    }
    const toLand = chamfer(water, 1), toWater = chamfer(water, 0);
    this.computeFlow(toLand);
    for (let k = 0; k < N * N; k++) {
      this.data[k * 4] = water[k] ? Math.min(255, Math.round((toLand[k]! / REACH) * 255)) : 0;
      this.data[k * 4 + 1] = water[k] ? 0 : Math.min(255, Math.round((toWater[k]! / REACH) * 255));
      const fx = this.flow[k * 2]! / MAX_SPEED, fz = this.flow[k * 2 + 1]! / MAX_SPEED;
      this.data[k * 4 + 2] = Math.round(127.5 + 127 * Math.max(-1, Math.min(1, fx)));
      this.data[k * 4 + 3] = Math.round(127.5 + 127 * Math.max(-1, Math.min(1, fz)));
    }
    this.texture.needsUpdate = true;
    this.revision++;
    return true;
  }

  private computeFlow(toLand: Float32Array): void {
    const water = this.water, H = this.heights;
    const flow = this.flow.fill(0);
    // How wide the water is round each cell: the deepest point within 6 m.
    const wide = maxFilter(toLand, 6);
    const WIDE = 7;
    // Bodies of water (8-connected).
    const comp = new Int32Array(N * N).fill(-1);
    const bodies: number[][] = [];
    const stack: number[] = [];
    for (let s = 0; s < N * N; s++) {
      if (!water[s] || comp[s]! >= 0) continue;
      const id = bodies.length, cells: number[] = [];
      comp[s] = id;
      stack.push(s);
      while (stack.length) {
        const k = stack.pop()!;
        cells.push(k);
        forNeighbours(k, (n) => {
          if (water[n] && comp[n]! < 0) {
            comp[n] = id;
            stack.push(n);
          }
        });
      }
      bodies.push(cells);
    }
    // Where each body drains to: its lowest part; on flat water, the lake in
    // it, or else the far end of the stream.
    const dist = new Float32Array(N * N).fill(Infinity);
    const heap = new Heap();
    const sinks: number[] = [];
    for (const cells of bodies) {
      let lo = Infinity, hi = -Infinity;
      for (const k of cells) {
        lo = Math.min(lo, H[k]!);
        hi = Math.max(hi, H[k]!);
      }
      if (hi - lo > 0.1) {
        for (const k of cells) if (H[k]! <= lo + 0.05) sinks.push(k);
      } else {
        const lake = cells.filter((k) => wide[k]! >= WIDE);
        if (lake.length) sinks.push(...lake);
        else sinks.push(farthest(farthest(cells[0]!, water), water));
      }
    }
    for (const k of sinks) {
      dist[k] = 0;
      heap.push(k, 0);
    }
    // Distance along the water to where it drains (Dijkstra, 8 neighbours).
    while (heap.size) {
      const k = heap.pop();
      const dk = dist[k]!;
      const i = k % N, j = (k - i) / N;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const n = jj * N + ii;
        if (!water[n]) continue;
        const nd = dk + (di && dj ? Math.SQRT2 : 1);
        if (nd < dist[n]! - 1e-6) {
          dist[n] = nd;
          heap.push(n, nd);
        }
      }
    }
    // The current runs down that distance: along the channel, round its bends.
    // Narrow water runs (faster where the bed is steep); wide water is still.
    const at = (f: Float32Array, k: number, di: number, dj: number, fallback: number) => {
      const i = (k % N) + di, j = Math.floor(k / N) + dj;
      if (i < 0 || j < 0 || i >= N || j >= N) return fallback;
      const n = j * N + i;
      return water[n] && Number.isFinite(f[n]!) ? f[n]! : fallback;
    };
    for (let k = 0; k < N * N; k++) {
      if (!water[k] || !Number.isFinite(dist[k]!)) continue;
      const d0 = dist[k]!;
      // One-sided where a neighbour is land, so banks don't bend the current.
      const gx = (at(dist, k, 1, 0, d0) - at(dist, k, -1, 0, d0)) / 2;
      const gz = (at(dist, k, 0, 1, d0) - at(dist, k, 0, -1, d0)) / 2;
      const g = Math.hypot(gx, gz);
      if (g < 1e-4) continue;
      const dx = -gx / g, dz = -gz / g;
      const h0 = H[k]!;
      const hx = (at(H, k, 1, 0, h0) - at(H, k, -1, 0, h0)) / 2, hz = (at(H, k, 0, 1, h0) - at(H, k, 0, -1, h0)) / 2;
      const slope = Math.max(0, -(hx * dx + hz * dz));
      const narrow = 1 - smoothstep(3.5, WIDE, wide[k]!);
      const speed = narrow * Math.min(MAX_SPEED, 0.7 + 6 * slope);
      flow[k * 2] = dx * speed;
      flow[k * 2 + 1] = dz * speed;
    }
    // Smooth the current (within the water only), so it turns gently.
    for (let pass = 0; pass < 3; pass++) {
      const src = flow.slice();
      for (let k = 0; k < N * N; k++) {
        if (!water[k]) continue;
        let sx = 0, sz = 0, n = 0;
        forNeighbours(k, (q) => {
          if (!water[q]) return;
          sx += src[q * 2]!;
          sz += src[q * 2 + 1]!;
          n++;
        }, true);
        flow[k * 2] = sx / n;
        flow[k * 2 + 1] = sz / n;
      }
    }
  }
}

/** Call f for each of the 8 neighbours of cell k on the map (and k itself if `self`). */
function forNeighbours(k: number, f: (n: number) => void, self = false): void {
  const i = k % N, j = (k - i) / N;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj && !self) continue;
    const ii = i + di, jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
    f(jj * N + ii);
  }
}

/** The water cell farthest (in steps through water) from `start`. */
function farthest(start: number, water: Uint8Array): number {
  const seen = new Uint8Array(N * N);
  let queue = [start], last = start;
  seen[start] = 1;
  while (queue.length) {
    const next: number[] = [];
    for (const k of queue) {
      last = k;
      forNeighbours(k, (n) => {
        if (water[n] && !seen[n]) {
          seen[n] = 1;
          next.push(n);
        }
      });
    }
    queue = next;
  }
  return last;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** The largest value within r cells (square window), rows then columns. */
function maxFilter(src: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(N * N), out = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let d = Math.max(0, i - r); d <= Math.min(N - 1, i + r); d++) m = Math.max(m, src[j * N + d]!);
      tmp[j * N + i] = m;
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let d = Math.max(0, j - r); d <= Math.min(N - 1, j + r); d++) m = Math.max(m, tmp[d * N + i]!);
      out[j * N + i] = m;
    }
  }
  return out;
}

/** A min-heap of cells by key; ties come out in the order they went in. */
class Heap {
  private keys: number[] = [];
  private cells: number[] = [];
  private seqs: number[] = [];
  private seq = 0;

  get size(): number {
    return this.cells.length;
  }

  private less(a: number, b: number): boolean {
    return this.keys[a]! < this.keys[b]! || (this.keys[a] === this.keys[b] && this.seqs[a]! < this.seqs[b]!);
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
    [this.cells[a], this.cells[b]] = [this.cells[b]!, this.cells[a]!];
    [this.seqs[a], this.seqs[b]] = [this.seqs[b]!, this.seqs[a]!];
  }

  push(cell: number, key: number): void {
    this.keys.push(key);
    this.cells.push(cell);
    this.seqs.push(this.seq++);
    let i = this.cells.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.cells[0]!;
    const last = this.cells.length - 1;
    this.swap(0, last);
    this.keys.pop();
    this.cells.pop();
    this.seqs.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.cells.length && this.less(l, m)) m = l;
      if (r < this.cells.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

/** Distance (m) from each cell whose mask is `inside` to the nearest cell that isn't, capped past REACH. */
function chamfer(mask: Uint8Array, inside: number): Float32Array {
  const d = new Float32Array(N * N);
  const far = REACH + 2;
  for (let k = 0; k < N * N; k++) d[k] = mask[k] === inside ? far : 0;
  const D = Math.SQRT2;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (d[k] === 0) continue;
      let v = d[k]!;
      if (i > 0) v = Math.min(v, d[k - 1]! + 1);
      if (j > 0) {
        v = Math.min(v, d[k - N]! + 1);
        if (i > 0) v = Math.min(v, d[k - N - 1]! + D);
        if (i < N - 1) v = Math.min(v, d[k - N + 1]! + D);
      }
      d[k] = v;
    }
  }
  for (let j = N - 1; j >= 0; j--) {
    for (let i = N - 1; i >= 0; i--) {
      const k = j * N + i;
      if (d[k] === 0) continue;
      let v = d[k]!;
      if (i < N - 1) v = Math.min(v, d[k + 1]! + 1);
      if (j < N - 1) {
        v = Math.min(v, d[k + N]! + 1);
        if (i < N - 1) v = Math.min(v, d[k + N + 1]! + D);
        if (i > 0) v = Math.min(v, d[k + N - 1]! + D);
      }
      d[k] = v;
    }
  }
  // Cells at the boundary measure half a cell to the shore line, not zero.
  for (let k = 0; k < N * N; k++) if (mask[k] === inside) d[k] = Math.max(0, d[k]! - 0.5);
  return d;
}
