// The object brush maths, with no imports so it can be unit-tested
// (`npm run test:unit`).
//
// A dab throws darts in the brush area and keeps those far enough from
// every object already there (and from each other): an even, natural
// spread with no clumps, whichever chunk the neighbours are in. How far is
// "far enough" depends on the kind (trees need more room than grass) times
// the brush's spacing setting. How many a dab tries for comes from the
// density (objects per 100 m^2). Painting over the same spot again fills
// the gaps and then stops: the spacing caps it.

export type SprayShape = 'circle' | 'square';

/** Room each family needs (m) at spacing 1. */
export const FAMILY_SPACING: Record<string, number> = { tree: 4, bush: 1.6, rock: 1.4, plant: 0.6 };

export function familyOf(kind: string): string {
  return kind.split(':')[0] ?? kind;
}

/** Minimum distance (m) to keep round an object of this kind. */
export function spacingFor(kind: string, factor = 1): number {
  return (FAMILY_SPACING[familyOf(kind)] ?? 1) * Math.max(0.05, factor);
}

/** "tree:*" (any tree) or a single kind: the kind to place, picked from `kinds`. */
export function pickKind(kind: string, kinds: readonly string[], random: () => number): string {
  if (!kind.endsWith(':*')) return kind;
  const fam = kinds.filter((k) => familyOf(k) === familyOf(kind));
  return fam.length ? fam[Math.floor(random() * fam.length)]! : kind;
}

export interface SprayOptions {
  radius: number;
  shape: SprayShape;
  /** Objects per 100 m^2 a dab aims for. */
  density: number;
  /** Minimum distance between the new objects and anything already there (m). */
  spacing: number;
}

export interface Neighbour {
  x: number;
  z: number;
  /** The room this neighbour needs. */
  spacing: number;
}

/**
 * New object positions for one dab at (x, z): about density x area / 100
 * of them, each at least max(own, neighbour's) spacing from every
 * neighbour and from each other.
 */
export function sprayDab(x: number, z: number, o: SprayOptions, near: readonly Neighbour[], random: () => number): { x: number; z: number }[] {
  const r = Math.max(0, o.radius);
  const area = o.shape === 'square' ? 4 * r * r : Math.PI * r * r;
  const want = (o.density * area) / 100;
  const n = Math.floor(want) + (random() < want - Math.floor(want) ? 1 : 0);
  const out: { x: number; z: number }[] = [];
  const taken: Neighbour[] = [...near];
  for (let tries = 0; out.length < n && tries < n * 30 + 10; tries++) {
    let dx: number, dz: number;
    if (o.shape === 'square') {
      dx = (random() * 2 - 1) * r;
      dz = (random() * 2 - 1) * r;
    } else {
      const a = random() * Math.PI * 2, d = r * Math.sqrt(random());
      dx = d * Math.cos(a);
      dz = d * Math.sin(a);
    }
    const p = { x: x + dx, z: z + dz };
    if (taken.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < Math.max(q.spacing, o.spacing))) continue;
    out.push(p);
    taken.push({ ...p, spacing: o.spacing });
  }
  return out;
}

/** A small seeded random generator (mulberry32), so tests are repeatable. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VaryRange {
  min: number;
  max: number;
  /** 1 or more: a whole-number setting. */
  step: number;
}

/**
 * A random value round `base`: +- spread (0-1) of the base, or of half the
 * range when the base is 0 (so a 0 setting can vary too); kept in range,
 * rounded for whole-number settings.
 */
export function vary(base: number, spread: number, r: VaryRange, random: () => number): number {
  if (spread <= 0) return base;
  const amount = Math.abs(base) > 1e-6 ? Math.abs(base) * spread : ((r.max - r.min) / 2) * spread;
  let v = base + (random() * 2 - 1) * amount;
  v = Math.min(r.max, Math.max(r.min, v));
  return r.step >= 1 ? Math.round(v) : v;
}
