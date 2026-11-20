// The select tool (V): click an object to select it (its box is outlined),
// drag it to move it (snapping applies), Delete / Backspace removes it,
// R turns it 15 degrees (Shift+R back), [ / ] make it smaller / bigger, Esc
// lets go. A drag is one undoable move; the object keeps its id.

import { COLORS, DebugDraw, Lines } from '../render/debugdraw';
import { addRootKeys } from '../ui/widgets';
import type { App } from './app';
import { snapTo, type Editor } from './editor';
import type { PlacedObject } from './map';
import type { ToolSwitch } from './tools';
import type { Undo } from './undo';

/** Footprint radius (m) used before the engine has reported an object's box. */
const GUESS: Record<string, number> = { tree: 1.2, bush: 0.9, rock: 0.9, plant: 0.4 };

export class SelectTool {
  active = false;
  selected: number | null = null;
  private drag: { dx: number; dz: number; moved: boolean } | null = null;
  private listeners = new Set<() => void>();
  private draw: DebugDraw;
  private lastMove = 0;

  constructor(private app: App, private editor: Editor, private undo: Undo, private tools: ToolSwitch) {
    this.draw = new DebugDraw(app.viewer.overlay);
    const el = app.viewer.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      if (!this.active || e.button !== 0 || !app.world) return;
      const g = editor.point();
      const hit = g ? this.pick(g.x, g.z) : null;
      this.select(hit?.id ?? null);
      if (hit && g) {
        el.setPointerCapture(e.pointerId);
        this.drag = { dx: hit.x - g.x, dz: hit.z - g.z, moved: false };
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.drag || !(e.buttons & 1) || this.selected === null) return;
      const now = performance.now();
      if (now - this.lastMove < 60) return; // each move rebuilds a chunk or two
      this.lastMove = now;
      const g = this.editor.cursor.ground();
      if (!g) return;
      const p = snapTo(g.x + this.drag.dx, g.z + this.drag.dz, editor.snap);
      if (!this.drag.moved) {
        this.undo.begin('move object');
        this.drag.moved = true;
      }
      app.map?.updateObject(this.selected, p);
      this.changed();
    });
    const up = () => {
      if (this.drag?.moved) this.undo.end();
      this.drag = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    app.onSceneChange((name) => {
      if (name !== 'canvas' && this.active) this.setActive(false);
    });
    // The outline follows the object's real box once its chunk is rebuilt.
    window.setInterval(() => {
      if (this.selected !== null) this.highlight();
    }, 300);
    addRootKeys((e) => {
      const k = e.key.toLowerCase();
      if (k === 'v') return this.setActive(!this.active), true;
      if (!this.active) return false;
      if (e.key === 'Escape' && this.selected !== null) return this.select(null), true;
      if (this.selected === null) return false;
      if (e.key === 'Delete' || e.key === 'Backspace') return this.removeSelected(), true;
      if (k === 'r') return this.turn(e.shiftKey ? -15 : 15), true;
      if (e.key === '[' || e.key === ']') return this.resize(e.key === ']' ? 1.1 : 1 / 1.1), true;
      return false;
    });
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
    this.highlight();
  }

  setActive(on: boolean): void {
    if (on && !this.app.world) return;
    if (on === this.active) return;
    if (on) this.tools.claim('select', () => this.setActive(false));
    else this.tools.release('select');
    this.active = on;
    if (!on) this.selected = null;
    this.editor.setPainting(on);
    this.changed();
  }

  /** The selected object, if it still exists. */
  object(): PlacedObject | null {
    return this.selected === null ? null : this.app.map?.object(this.selected) ?? null;
  }

  select(id: number | null): void {
    this.selected = id !== null && this.app.map?.object(id) ? id : null;
    this.changed();
  }

  /** The object under (x, z): inside its footprint, nearest centre first. */
  pick(x: number, z: number): PlacedObject | null {
    const map = this.app.map;
    if (!map) return null;
    let best: PlacedObject | null = null, bd = Infinity;
    for (const o of map.objectsNear(x, z, 12)) {
      const d = Math.hypot(o.x - x, o.z - z);
      if (d <= this.footprint(o) && d < bd) {
        best = o;
        bd = d;
      }
    }
    return best;
  }

  /** Footprint radius from the engine's box (or a guess per family). */
  private footprint(o: PlacedObject): number {
    const box = this.box(o);
    if (box) return Math.max(0.3, Math.min(box[3]! - box[0]!, box[5]! - box[2]!) * 0.35);
    return (GUESS[o.kind.split(':')[0] ?? ''] ?? 1) * o.scale;
  }

  /** The object's world box [min x, y, z, max x, y, z] from its chunk's last build. */
  private box(o: PlacedObject): number[] | null {
    const map = this.app.map, w = this.app.world;
    if (!map || !w) return null;
    const [cx, cz] = map.chunkOf(o.x, o.z);
    const b = w.chunk(cx, cz)?.data.bounds, i = map.objectsIn(cx, cz).indexOf(o);
    if (!b || i < 0) return null;
    for (let k = 0; k + 7 <= b.length; k += 7) {
      if (b[k] === i && Math.abs((b[k + 1]! + b[k + 4]!) / 2 - o.x) < 0.01 && Math.abs((b[k + 3]! + b[k + 6]!) / 2 - o.z) < 0.01) {
        return Array.from(b.subarray(k + 1, k + 7));
      }
    }
    return null;
  }

  removeSelected(): void {
    if (this.selected === null) return;
    this.undo.begin('delete object');
    this.app.map?.removeObject(this.selected);
    this.undo.end();
    this.select(null);
  }

  turn(deg: number): void {
    const o = this.object();
    if (!o) return;
    this.undo.begin('turn object');
    this.app.map?.updateObject(o.id, { yaw: (o.yaw + (deg * Math.PI) / 180) % (Math.PI * 2) });
    this.undo.end();
    this.changed();
  }

  resize(f: number): void {
    const o = this.object();
    if (!o) return;
    this.undo.begin('resize object');
    this.app.map?.updateObject(o.id, { scale: Math.min(20, Math.max(0.05, o.scale * f)) });
    this.undo.end();
    this.changed();
  }

  private highlight(): void {
    const o = this.active ? this.object() : null;
    if (!o || !this.app.world) {
      if (this.draw.has('outlines')) this.draw.set('outlines', null);
      if (this.selected !== null && !o) this.selected = null; // undone away
      this.app.viewer.requestRender();
      return;
    }
    const g = this.app.world.info.ground, l = new Lines(), b = this.box(o);
    if (b) l.box(b[0]!, b[1]!, b[2]!, b[3]!, b[4]!, b[5]!, COLORS.marker);
    l.circle(o.x, g + 0.08, o.z, this.footprint(o), COLORS.marker, 32);
    this.draw.set('outlines', l);
    this.app.viewer.requestRender();
  }
}
