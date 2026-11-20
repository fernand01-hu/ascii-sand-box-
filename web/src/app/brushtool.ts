// The terrain brush: paint the canvas with grass, sand, water or rock, or
// erase back to the '#' canvas.
//
//   P          brush on / off. While on, the left mouse button paints
//              (orbit view: middle drag rotates; both views: right drag
//              pans, wheel zooms).
//   1-4        grass, sand, water, rock     E   eraser (canvas) on / off
//   [ / ]      smaller / bigger brush
// Size, circle or square, strength and soft edge are in the brush panel, the
// terminal (`brush ...`) and remembered between visits. A stroke follows the
// (snapped) ground point under the mouse, with dabs evenly spaced along the
// path; when it ends, listeners get the stroke's tile changes (undo, step 8).

import { COLORS, DebugDraw, Lines } from '../render/debugdraw';
import { addRootKeys } from '../ui/widgets';
import type { App } from './app';
import { BRUSH_SIZES, dabSpacing, dabTiles, strokePoints, type BrushOptions, type BrushShape } from './brush';
import type { Editor } from './editor';
import type { TileChange } from './map';
import type { Settings } from './settings';

/** Paints the number keys pick, in order. */
export const PAINT_KEYS = ['grass', 'sand', 'water', 'rock'];

/** A finished stroke: what it painted and every tile it changed. */
export interface Stroke {
  kind: string;
  changes: TileChange[];
}

export class BrushTool implements BrushOptions {
  active = false;
  kind = 'grass';
  radius = 2;
  shape: BrushShape = 'circle';
  strength = 1;
  soft = 0.3;
  private beforeEraser = 'grass';
  private stroking: { seed: number; last: { x: number; z: number }; changes: TileChange[] } | null = null;
  private listeners = new Set<() => void>();
  private strokeListeners = new Set<(s: Stroke) => void>();
  private draw: DebugDraw;
  /** Set by the undo history: each stroke becomes one undoable action. */
  group: { begin(label: string): void; end(label?: string): void } | null = null;

  constructor(private app: App, private editor: Editor, settings: Settings) {
    this.draw = new DebugDraw(app.viewer.overlay);
    const el = app.viewer.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active || e.button !== 0 || !app.world) return;
      const p = editor.point();
      if (!p) return;
      el.setPointerCapture(e.pointerId);
      this.begin(p);
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.active ? editor.point() : null;
      if (this.stroking && p && e.buttons & 1) this.continueTo(p);
      this.updateOutline(p);
    });
    const finish = () => this.end();
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('pointerleave', () => this.updateOutline(null));
    editor.onChange(() => this.updateOutline(this.active ? editor.point() : null));
    app.onSceneChange((name) => {
      if (name !== 'canvas' && this.active) this.setActive(false); // the brush is for the canvas
    });

    addRootKeys((e) => {
      const k = e.key.toLowerCase();
      if (k === 'p') return this.setActive(!this.active), true;
      if (!this.active) return false;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= PAINT_KEYS.length) return this.setKind(PAINT_KEYS[n - 1]!), true;
      if (k === 'e') return this.setKind(this.kind === 'canvas' ? this.beforeEraser : 'canvas'), true;
      if (e.key === '[' || e.key === ']') return this.stepSize(e.key === ']' ? 1 : -1), true;
      return false;
    });

    const num = (v: string, what: string, lo: number, hi: number) => {
      const n = Number(v);
      if (v === '' || !Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what}: a number from ${lo} to ${hi}`);
      return n;
    };
    settings.add(
      {
        name: 'paint', help: 'what the brush paints: canvas (erases), grass, sand, water, rock', persist: true,
        get: () => this.kind, set: (v) => this.setKind(v),
      },
      { name: 'size', help: 'brush radius in metres (0.25-32)', persist: true, get: () => String(this.radius), set: (v) => this.setSize(num(v, 'size', 0.25, 32)) },
      {
        name: 'shape', help: 'brush shape: circle or square', persist: true, get: () => this.shape,
        set: (v) => {
          if (v !== 'circle' && v !== 'square') throw new Error('shape: circle or square');
          this.setShape(v);
        },
      },
      { name: 'strength', help: 'share of tiles a dab paints (0.05-1)', persist: true, get: () => String(this.strength), set: (v) => this.setStrength(num(v, 'strength', 0.05, 1)) },
      { name: 'soft', help: 'soft edge: part of the radius that fades out (0-1)', persist: true, get: () => String(this.soft), set: (v) => this.setSoft(num(v, 'soft', 0, 1)) },
    );
  }

  /** Called whenever an option changes (panel, status bar). */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Called with every finished stroke (undo will keep them). */
  onStroke(f: (s: Stroke) => void): () => void {
    this.strokeListeners.add(f);
    return () => this.strokeListeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
    this.updateOutline(this.active ? this.editor.point() : null);
  }

  setActive(on: boolean): void {
    if (on && !this.app.world) return; // only on the canvas
    this.end();
    this.active = on;
    this.editor.setPainting(on);
    this.changed();
  }

  setKind(kind: string): void {
    const kinds = this.app.map?.info.groundKinds ?? ['canvas', ...PAINT_KEYS];
    if (!kinds.includes(kind)) throw new Error(`paint: one of ${kinds.join(', ')}`);
    if (kind === 'canvas' && this.kind !== 'canvas') this.beforeEraser = this.kind;
    this.kind = kind;
    this.changed();
  }

  setSize(r: number): void {
    this.radius = Math.min(32, Math.max(0.25, r));
    this.changed();
  }

  /** One step along the brush sizes. */
  stepSize(dir: 1 | -1): void {
    const i = BRUSH_SIZES.findIndex((s) => s >= this.radius - 1e-9);
    const next = BRUSH_SIZES[Math.min(BRUSH_SIZES.length - 1, Math.max(0, (i < 0 ? BRUSH_SIZES.length - 1 : i) + dir))]!;
    this.setSize(next);
  }

  setShape(s: BrushShape): void {
    this.shape = s;
    this.changed();
  }

  setStrength(v: number): void {
    this.strength = Math.min(1, Math.max(0.05, v));
    this.changed();
  }

  setSoft(v: number): void {
    this.soft = Math.min(1, Math.max(0, v));
    this.changed();
  }

  /** Start a stroke at p (one dab there). */
  begin(p: { x: number; z: number }): void {
    this.end();
    this.group?.begin(this.kind === 'canvas' ? 'erase' : `paint ${this.kind}`);
    this.stroking = { seed: (Math.random() * 0x7fffffff) | 0, last: p, changes: [] };
    this.dab(p);
  }

  /** Carry the stroke on to p, dabbing evenly along the way. */
  continueTo(p: { x: number; z: number }): void {
    const s = this.stroking, map = this.app.map;
    if (!s || !map) return;
    if (Math.hypot(p.x - s.last.x, p.z - s.last.z) < dabSpacing(this, map.info.tile)) return;
    for (const q of strokePoints(s.last, p, dabSpacing(this, map.info.tile))) this.dab(q);
    s.last = p;
  }

  /** Finish the stroke; listeners get what it changed. Returns the stroke (null if none). */
  end(): Stroke | null {
    const s = this.stroking;
    this.stroking = null;
    if (!s) return null;
    const n = s.changes.length;
    this.group?.end(n ? `${this.kind === 'canvas' ? 'erase' : `paint ${this.kind}`} (${n} tiles)` : undefined);
    if (n === 0) return null;
    const stroke = { kind: this.kind, changes: s.changes };
    for (const f of this.strokeListeners) f(stroke);
    return stroke;
  }

  /** A whole stroke from a to b (terminal, tests). Returns the tiles it changed. */
  strokeLine(a: { x: number; z: number }, b: { x: number; z: number }): number {
    this.begin(a);
    for (const q of strokePoints(a, b, dabSpacing(this, this.app.map?.info.tile ?? 0.5))) this.dab(q);
    return this.end()?.changes.length ?? 0;
  }

  private dab(p: { x: number; z: number }): void {
    const map = this.app.map, s = this.stroking;
    if (!map || !s) return;
    const { changes } = map.paintTileList(dabTiles(p.x, p.z, this, map.info.tile, s.seed), this.kind);
    // A tile painted twice in one stroke keeps its first "from" (undo restores the start).
    s.changes.push(...changes);
  }

  /** The brush outline on the ground under the mouse (and its solid core when soft). */
  private updateOutline(p: { x: number; z: number } | null): void {
    if (!p || !this.active || !this.app.world) {
      if (this.draw.has('tiles')) {
        this.draw.set('tiles', null);
        this.app.viewer.requestRender();
      }
      return;
    }
    const y = this.app.world.info.ground + 0.1, r = this.radius, l = new Lines();
    const ring = (rad: number) => {
      if (this.shape === 'square') l.box(p.x - rad, y, p.z - rad, p.x + rad, y, p.z + rad, COLORS.marker);
      else l.circle(p.x, y, p.z, rad, COLORS.marker, 40);
    };
    ring(r);
    if (this.soft > 0.05 && r * (1 - this.soft) > 0.1) ring(r * (1 - this.soft));
    this.draw.set('tiles', l);
    this.app.viewer.requestRender();
  }
}
