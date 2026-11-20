// Debug lines drawn over the scene: chunk borders coloured by state,
// culling boxes, object outlines, the paint tile grid near the cursor, the
// origin with its axes, and the hidden solid shapes as wireframe. Plain
// lines, not glyph cards: they cost almost nothing and never count as glyph
// stacking. Each layer exists only while switched on.

import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  WireframeGeometry,
  type Group,
  type Mesh,
} from 'three';

export type Layer = 'chunks' | 'culling' | 'outlines' | 'tiles' | 'axes' | 'bodies' | 'grid' | 'marker';

/** Colours (r, g, b 0..1), in the TUI palette. */
export const COLORS = {
  loaded: [0.42, 0.46, 0.51],
  building: [0.89, 0.7, 0.25],
  dirty: [1.0, 0.48, 0.45],
  edited: [0.55, 0.82, 0.49],
  culling: [0.47, 0.75, 1.0],
  outline: [0.89, 0.7, 0.25],
  tiles: [0.79, 0.82, 0.85],
  x: [1.0, 0.45, 0.4],
  y: [0.55, 0.82, 0.49],
  z: [0.47, 0.6, 1.0],
  body: [0.75, 0.45, 0.9],
  grid: [0.3, 0.34, 0.4],
  gridMajor: [0.55, 0.6, 0.68],
  marker: [0.89, 0.7, 0.25],
} as const;

type RGB = readonly [number, number, number];

/** Line segments being built: push pairs of points with a colour. */
export class Lines {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  seg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: RGB): void {
    this.pos.push(ax, ay, az, bx, by, bz);
    this.col.push(...c, ...c);
  }

  /** Axis-aligned box outline. */
  box(lx: number, ly: number, lz: number, hx: number, hy: number, hz: number, c: RGB): void {
    for (const y of [ly, hy]) {
      this.seg(lx, y, lz, hx, y, lz, c);
      this.seg(hx, y, lz, hx, y, hz, c);
      this.seg(hx, y, hz, lx, y, hz, c);
      this.seg(lx, y, hz, lx, y, lz, c);
    }
    for (const [x, z] of [[lx, lz], [hx, lz], [hx, hz], [lx, hz]] as const) this.seg(x, ly, z, x, hy, z, c);
  }

  /**
   * A line from (ax, az) to (bx, bz) lying on the ground: y = yAt(x, z) +
   * lift, cut into pieces about `step` metres long (one piece when flat).
   */
  drape(ax: number, az: number, bx: number, bz: number, c: RGB, yAt: (x: number, z: number) => number, lift: number, step: number): void {
    const n = Number.isFinite(step) ? Math.max(1, Math.min(400, Math.ceil(Math.hypot(bx - ax, bz - az) / step))) : 1;
    for (let k = 0; k < n; k++) {
      const x0 = ax + ((bx - ax) * k) / n, z0 = az + ((bz - az) * k) / n;
      const x1 = ax + ((bx - ax) * (k + 1)) / n, z1 = az + ((bz - az) * (k + 1)) / n;
      this.seg(x0, yAt(x0, z0) + lift, z0, x1, yAt(x1, z1) + lift, z1, c);
    }
  }

  /** A circle lying on the ground (see `drape`). */
  circleOn(x: number, z: number, r: number, c: RGB, yAt: (x: number, z: number) => number, lift: number, n = 32): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      const ax = x + r * Math.cos(a), az = z + r * Math.sin(a), bx = x + r * Math.cos(b), bz = z + r * Math.sin(b);
      this.seg(ax, yAt(ax, az) + lift, az, bx, yAt(bx, bz) + lift, bz, c);
    }
  }

  /** A square (half side r) lying on the ground. */
  squareOn(x: number, z: number, r: number, c: RGB, yAt: (x: number, z: number) => number, lift: number, step: number): void {
    this.drape(x - r, z - r, x + r, z - r, c, yAt, lift, step);
    this.drape(x + r, z - r, x + r, z + r, c, yAt, lift, step);
    this.drape(x + r, z + r, x - r, z + r, c, yAt, lift, step);
    this.drape(x - r, z + r, x - r, z - r, c, yAt, lift, step);
  }

  /** Flat circle at height y. */
  circle(x: number, y: number, z: number, r: number, c: RGB, n = 24): void {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2;
      this.seg(x + r * Math.cos(a), y, z + r * Math.sin(a), x + r * Math.cos(b), y, z + r * Math.sin(b), c);
    }
  }
}

export class DebugDraw {
  private layers = new Map<Layer, LineSegments>();
  private material = new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: true });
  private bodyKeys = '';

  constructor(private overlay: Group) {}

  has(layer: Layer): boolean {
    return this.layers.has(layer);
  }

  /** Replace a layer's lines (null removes the layer). */
  set(layer: Layer, lines: Lines | null): void {
    const old = this.layers.get(layer);
    if (old) {
      this.overlay.remove(old);
      old.geometry.dispose();
      this.layers.delete(layer);
    }
    if (layer === 'bodies') this.bodyKeys = '';
    if (!lines || lines.pos.length === 0) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(lines.pos, 3));
    g.setAttribute('color', new Float32BufferAttribute(lines.col, 3));
    const seg = new LineSegments(g, this.material);
    seg.frustumCulled = false;
    seg.renderOrder = 3;
    this.overlay.add(seg);
    this.layers.set(layer, seg);
  }

  /** The hidden solid shapes as wireframe; rebuilt only when the set of bodies changed. */
  setBodies(bodies: ReadonlyMap<string, Mesh> | null): void {
    if (!bodies) return this.set('bodies', null);
    const keys = [...bodies.entries()].map(([k, m]) => `${k}:${m.geometry.id}`).join('|');
    if (keys === this.bodyKeys && this.layers.has('bodies')) return;
    const lines = new Lines();
    for (const m of bodies.values()) {
      const w = new WireframeGeometry(m.geometry);
      const p = w.getAttribute('position');
      for (let i = 0; i + 1 < p.count; i += 2) {
        lines.seg(p.getX(i), p.getY(i) + 0.02, p.getZ(i), p.getX(i + 1), p.getY(i + 1) + 0.02, p.getZ(i + 1), COLORS.body);
      }
      w.dispose();
    }
    this.set('bodies', lines);
    this.bodyKeys = keys;
  }
}
