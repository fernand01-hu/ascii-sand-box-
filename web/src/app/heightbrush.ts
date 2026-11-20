// The height brush maths, with no imports so it can be unit-tested
// (`npm run test:unit`).
//
// A dab moves the ground points (1 m grid) within the brush radius, weighted
// by a smooth falloff (1 in the middle, 0 at the rim, cosine in between, so
// no ridge at the edge):
//   raise / lower   up / down by strength (m) x weight
//   smooth          toward the average of the 3 x 3 points round it
//   flatten         toward a level (the height where the stroke started)
// For smooth and flatten, strength is the share of the way moved (0-1).

export type HeightMode = 'raise' | 'lower' | 'smooth' | 'flatten';
export const HEIGHT_MODES: HeightMode[] = ['raise', 'lower', 'smooth', 'flatten'];

export interface HeightOptions {
  radius: number;
  mode: HeightMode;
  /** Metres per dab (raise / lower) or share of the way (smooth / flatten). */
  strength: number;
  /** Target for flatten. */
  level?: number;
}

/** Weight at normalised distance d: 1 at the centre, 0 at and past the rim, smooth. */
export function falloff(d: number): number {
  if (d >= 1) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * Math.max(0, d)));
}

/** The new heights of the points one dab at (x, z) moves. */
export function heightDab(x: number, z: number, o: HeightOptions, get: (vi: number, vj: number) => number): { vi: number; vj: number; h: number }[] {
  const r = Math.max(0.5, o.radius);
  const out: { vi: number; vj: number; h: number }[] = [];
  const share = Math.min(1, Math.max(0, o.strength));
  for (let vj = Math.ceil(z - r); vj <= Math.floor(z + r); vj++) {
    for (let vi = Math.ceil(x - r); vi <= Math.floor(x + r); vi++) {
      const w = falloff(Math.hypot(vi - x, vj - z) / r);
      if (w <= 0) continue;
      const h = get(vi, vj);
      let next = h;
      if (o.mode === 'raise') next = h + o.strength * w;
      else if (o.mode === 'lower') next = h - o.strength * w;
      else if (o.mode === 'smooth') {
        let sum = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) sum += get(vi + di, vj + dj);
        next = h + (sum / 9 - h) * share * w;
      } else next = h + ((o.level ?? 0) - h) * share * w;
      if (Math.abs(next - h) > 1e-6) out.push({ vi, vj, h: next });
    }
  }
  return out;
}
