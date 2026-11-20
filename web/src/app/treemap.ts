// Tree map (look engine): how much tree canopy there is round each spot,
// in a small texture round the camera (2 m per texel, 256 m across). Blown
// leaves are drawn only where there are trees upwind, so they come from the
// trees instead of filling the air everywhere. Rebuilt when objects are
// added or removed, or the camera has moved a chunk away.

import { DataTexture, LinearFilter, RedFormat, UnsignedByteType, Vector3 } from 'three';
import type { MapData } from './map';

const N = 128;
const CELL = 2;

export class TreeMap {
  readonly texture: DataTexture;
  /** min x, min z, size (m). */
  readonly box = new Vector3(0, 0, N * CELL);
  private data = new Uint8Array(N * N);
  private centre: [number, number] | null = null;
  private stale = true;

  constructor() {
    this.texture = new DataTexture(this.data, N, N, RedFormat, UnsignedByteType);
    this.texture.minFilter = LinearFilter;
    this.texture.magFilter = LinearFilter;
  }

  invalidate(): void {
    this.stale = true;
  }

  update(map: MapData, x: number, z: number): boolean {
    const S = map.info.chunkSize;
    const cx = Math.round(x / S) * S, cz = Math.round(z / S) * S;
    if (!this.stale && this.centre && Math.hypot(cx - this.centre[0], cz - this.centre[1]) < S) return false;
    this.centre = [cx, cz];
    this.stale = false;
    const x0 = cx - (N * CELL) / 2, z0 = cz - (N * CELL) / 2;
    this.box.set(x0, z0, N * CELL);
    const d = new Float32Array(N * N);
    for (const o of map.allObjects()) {
      if (!o.kind.startsWith('tree:')) continue;
      const r = 5 * (o.scale ?? 1); // crown radius, roughly
      const ci = (o.x - x0) / CELL, cj = (o.z - z0) / CELL, rc = r / CELL;
      for (let j = Math.max(0, Math.floor(cj - rc)); j <= Math.min(N - 1, Math.ceil(cj + rc)); j++) {
        for (let i = Math.max(0, Math.floor(ci - rc)); i <= Math.min(N - 1, Math.ceil(ci + rc)); i++) {
          const t = 1 - Math.hypot(i - ci, j - cj) / rc;
          if (t > 0) d[j * N + i] = d[j * N + i]! + t;
        }
      }
    }
    for (let k = 0; k < N * N; k++) this.data[k] = Math.min(255, Math.round(d[k]! * 160));
    this.texture.needsUpdate = true;
    return true;
  }
}
