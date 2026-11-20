// The brush maths, with no other imports so it can be unit-tested on its own
// (`npm run test:unit`, node --test web/src/app/brush.test.ts).
//
// A dab covers the ground tiles whose centre is inside the brush (a circle
// or a square of radius r). Each is painted with probability
//   strength x edge(d)
// where edge is 1 in the middle and falls smoothly to 0 at the rim over the
// outer `soft` part of the radius. With a soft edge, tiles near the rim are
// painted here and there, so sand fades into grass instead of ending in a
// hard line. The dice come from a hash of (tile, stroke seed): the same
// stroke over the same spot paints the same tiles, so passing the brush
// back and forth doesn't flicker.

export type BrushShape = 'circle' | 'square';

export interface BrushOptions {
  /** Radius in metres (half the side of a square). */
  radius: number;
  shape: BrushShape;
  /** 0..1: chance to paint each tile under the middle of the brush. */
  strength: number;
  /** 0..1: how much of the radius (from the rim inwards) fades out. */
  soft: number;
}

/** Brush sizes offered by the panel and `[` / `]` (radius, m). */
export const BRUSH_SIZES = [0.25, 0.5, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** A stable pseudo-random number in [0, 1) for a tile and a seed. */
export function tileDice(gi: number, gj: number, seed: number): number {
  let h = Math.imul(gi | 0, 0x27d4eb2d) ^ Math.imul(gj | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** How strongly the brush paints at normalised distance `d` (0 centre, 1 rim). */
export function edgeWeight(d: number, soft: number): number {
  if (d > 1) return 0;
  if (soft <= 0) return 1;
  return 1 - smoothstep(1 - soft, 1, d);
}

/**
 * The tiles one dab paints, as global tile indices [gi, gj] (tile i covers
 * x in [i * tile, (i + 1) * tile)). At strength 1 the tile under the centre
 * is always painted, so even the smallest brush leaves a mark.
 */
export function dabTiles(x: number, z: number, o: BrushOptions, tile: number, seed: number): [number, number][] {
  const r = Math.max(0, o.radius);
  const out: [number, number][] = [];
  if (o.strength <= 0) return out;
  const gi0 = Math.floor((x - r) / tile), gi1 = Math.floor((x + r) / tile);
  const gj0 = Math.floor((z - r) / tile), gj1 = Math.floor((z + r) / tile);
  const ci = Math.floor(x / tile), cj = Math.floor(z / tile);
  for (let gj = gj0; gj <= gj1; gj++) {
    for (let gi = gi0; gi <= gi1; gi++) {
      const dx = (gi + 0.5) * tile - x, dz = (gj + 0.5) * tile - z;
      // The tile under the centre counts as distance 0, so a tiny brush still paints it.
      const centre = gi === ci && gj === cj;
      const d = centre ? 0 : r <= 0 ? Infinity : o.shape === 'square' ? Math.max(Math.abs(dx), Math.abs(dz)) / r : Math.hypot(dx, dz) / r;
      if (d > 1) continue;
      if (tileDice(gi, gj, seed) < o.strength * edgeWeight(d, o.soft)) out.push([gi, gj]);
    }
  }
  return out;
}

/**
 * Dab centres along a stroke segment from a to b, `spacing` metres apart,
 * not including a (it was dabbed already) but always including b.
 */
export function strokePoints(a: { x: number; z: number }, b: { x: number; z: number }, spacing: number): { x: number; z: number }[] {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / Math.max(spacing, 1e-3)));
  const out: { x: number; z: number }[] = [];
  for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  return out;
}

/** Dab spacing for a brush: a third of its radius, at least one tile. */
export function dabSpacing(o: BrushOptions, tile: number): number {
  return Math.max(tile, o.radius / 3);
}
