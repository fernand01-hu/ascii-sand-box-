// Shore map (look lab, water variants): a small texture round the camera,
// 1 texel per metre, telling the water shader how far each spot of water is
// from the shore (red) and each spot of land from the water (green), up to
// 10 m. Shallow-water colour and lapping foam come from it. Rebuilt when
// the camera has moved a chunk away from its centre, or the paint changed.

import { DataTexture, LinearFilter, RGBAFormat, Vector3 } from 'three';
import type { MapData } from './map';

const N = 256; // texels (m) per side
const REACH = 10; // metres mapped to 0..1

export class ShoreMap {
  readonly texture: DataTexture;
  /** min x, min z, size (m). */
  readonly box = new Vector3(0, 0, N);
  private data = new Uint8Array(N * N * 4);
  private centre: [number, number] | null = null;
  private stale = true;

  constructor() {
    this.texture = new DataTexture(this.data, N, N, RGBAFormat);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
  }

  /** The paint changed: rebuild on the next update. */
  invalidate(): void {
    this.stale = true;
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
    // Water mask, then the distance to the other kind on each side (chamfer).
    const water = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) water[j * N + i] = map.groundAt(x0 + i + 0.5, z0 + j + 0.5) === 'water' ? 1 : 0;
    const toLand = chamfer(water, 1), toWater = chamfer(water, 0);
    for (let k = 0; k < N * N; k++) {
      this.data[k * 4] = water[k] ? Math.min(255, Math.round((toLand[k]! / REACH) * 255)) : 0;
      this.data[k * 4 + 1] = water[k] ? 0 : Math.min(255, Math.round((toWater[k]! / REACH) * 255));
      this.data[k * 4 + 2] = water[k]! * 255;
      this.data[k * 4 + 3] = 255;
    }
    this.texture.needsUpdate = true;
    return true;
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
