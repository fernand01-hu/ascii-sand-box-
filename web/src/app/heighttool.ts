// The height brush (H): shape the ground.
//
//   raise (1)    left drag lifts the ground under the brush
//   lower (2)    digs it down
//   smooth (3)   evens out bumps
//   flatten (4)  levels it to the height where the stroke started
//   [ / ]        brush size
// Strength is metres per dab (raise / lower) or the share of the way moved
// (smooth / flatten). One stroke is one undoable action. Maths in
// app/heightbrush.ts.

import { COLORS, DebugDraw, Lines } from '../render/debugdraw';
import { addRootKeys } from '../ui/widgets';
import type { App } from './app';
import type { Editor } from './editor';
import { heightDab, HEIGHT_MODES, type HeightMode } from './heightbrush';
import type { Settings } from './settings';
import type { ToolSwitch } from './tools';
import type { Undo } from './undo';

const SIZES = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32];

export class HeightTool {
  active = false;
  mode: HeightMode = 'raise';
  radius = 6;
  strength = 0.5;
  private stroke: { last: { x: number; z: number }; level: number } | null = null;
  private listeners = new Set<() => void>();
  private draw: DebugDraw;

  constructor(private app: App, private editor: Editor, private undo: Undo, private tools: ToolSwitch, settings: Settings) {
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
      if (this.stroke && p && e.buttons & 1) this.continueTo(p);
      this.outline(p);
    });
    for (const t of ['pointerup', 'pointercancel'] as const) el.addEventListener(t, () => this.end());
    el.addEventListener('pointerleave', () => this.outline(null));
    app.onSceneChange((name) => {
      if (name !== 'canvas' && this.active) this.setActive(false);
    });
    addRootKeys((e) => {
      const k = e.key.toLowerCase();
      if (k === 'h') return this.setActive(!this.active), true;
      if (!this.active) return false;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= HEIGHT_MODES.length) return this.setMode(HEIGHT_MODES[n - 1]!), true;
      if (e.key === '[' || e.key === ']') return this.stepSize(e.key === ']' ? 1 : -1), true;
      return false;
    });
    const num = (v: string, what: string, lo: number, hi: number) => {
      const x = Number(v);
      if (v === '' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what}: a number from ${lo} to ${hi}`);
      return x;
    };
    settings.add(
      {
        name: 'heightmode', help: 'height brush: raise, lower, smooth or flatten', persist: true, get: () => this.mode,
        set: (v) => {
          if (!HEIGHT_MODES.includes(v as HeightMode)) throw new Error(`heightmode: ${HEIGHT_MODES.join(', ')}`);
          this.setMode(v as HeightMode);
        },
      },
      { name: 'heightsize', help: 'height brush radius (m)', persist: true, get: () => String(this.radius), set: (v) => this.set({ radius: num(v, 'heightsize', 0.5, 64) }) },
      { name: 'heightstrength', help: 'height brush strength (m per dab, or share for smooth / flatten)', persist: true, get: () => String(this.strength), set: (v) => this.set({ strength: num(v, 'heightstrength', 0.01, 10) }) },
    );
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
    this.outline(this.active ? this.editor.point() : null);
  }

  setActive(on: boolean): void {
    if (on && !this.app.world) return;
    if (on === this.active) return;
    this.end();
    if (on) this.tools.claim('height', () => this.setActive(false));
    else this.tools.release('height');
    this.active = on;
    this.editor.setPainting(on);
    this.changed();
  }

  setMode(m: HeightMode): void {
    this.mode = m;
    this.changed();
  }

  set(o: Partial<Pick<HeightTool, 'radius' | 'strength'>>): void {
    Object.assign(this, o);
    this.changed();
  }

  stepSize(dir: 1 | -1): void {
    const i = SIZES.findIndex((s) => s >= this.radius - 1e-9);
    this.set({ radius: SIZES[Math.min(SIZES.length - 1, Math.max(0, (i < 0 ? SIZES.length - 1 : i) + dir))]! });
  }

  begin(p: { x: number; z: number }): void {
    this.end();
    this.undo.begin(`${this.mode} ground`);
    this.stroke = { last: p, level: this.app.map?.heightAt(p.x, p.z) ?? 0 };
    this.dab(p);
  }

  continueTo(p: { x: number; z: number }): void {
    const s = this.stroke;
    if (!s) return;
    const step = Math.max(0.5, this.radius * 0.3);
    const d = Math.hypot(p.x - s.last.x, p.z - s.last.z);
    if (d < step) return;
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) this.dab({ x: s.last.x + ((p.x - s.last.x) * k) / n, z: s.last.z + ((p.z - s.last.z) * k) / n });
    s.last = p;
  }

  end(): void {
    if (!this.stroke) return;
    this.stroke = null;
    this.undo.end();
  }

  /** A whole stroke from a to b (terminal, tests). Returns the points moved. */
  strokeLine(a: { x: number; z: number }, b: { x: number; z: number }): number {
    let moved = 0;
    const map = this.app.map;
    const off = map?.onEdit((e) => (moved += e.heights?.length ?? 0));
    this.begin(a);
    this.continueTo(b);
    this.end();
    off?.();
    return moved;
  }

  private dab(p: { x: number; z: number }): void {
    const map = this.app.map, s = this.stroke;
    if (!map || !s) return;
    map.setHeights(heightDab(p.x, p.z, { radius: this.radius, mode: this.mode, strength: this.strength, level: s.level }, (i, j) => map.pointHeight(i, j)));
  }

  private outline(p: { x: number; z: number } | null): void {
    const w = this.app.world, map = this.app.map;
    if (!p || !this.active || !w || !map) {
      if (this.draw.has('tiles')) {
        this.draw.set('tiles', null);
        this.app.viewer.requestRender();
      }
      return;
    }
    const g = w.info.ground, yAt = (x: number, z: number) => g + map.heightAt(x, z), l = new Lines();
    const col = this.mode === 'lower' ? COLORS.dirty : this.mode === 'raise' ? COLORS.edited : COLORS.culling;
    l.circleOn(p.x, p.z, this.radius, col, yAt, 0.12, 48);
    l.circleOn(p.x, p.z, this.radius / 2, col, yAt, 0.12, 32);
    this.draw.set('tiles', l);
    this.app.viewer.requestRender();
  }
}
