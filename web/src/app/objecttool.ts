// The object brush (O): put trees, bushes, rocks and plants on the canvas.
//
//   spray (1)   left drag sprays objects over the brush area, evenly spaced
//               (no clumps; neighbours in other chunks keep their room too)
//   single (2)  each click places exactly one object at the (snapped) point
//   erase (3)   left drag removes the objects under the brush
//   [ / ]       brush size
// The kind is one kind ("tree:oak") or a mix of a family ("tree:*"). Each
// object gets a random seed, rotation and size (+- variation). One stroke
// (or click) is one undoable action. Maths in app/spray.ts.

import { COLORS, DebugDraw, Lines } from '../render/debugdraw';
import { addRootKeys } from '../ui/widgets';
import type { App } from './app';
import { BRUSH_SIZES } from './brush';
import type { Editor } from './editor';
import type { ParamInfo } from './map';
import type { Preset } from './presets';
import type { Settings } from './settings';
import { pickKind, spacingFor, sprayDab, type SprayShape } from './spray';
import type { ToolSwitch } from './tools';
import type { Undo } from './undo';

export type ObjectMode = 'spray' | 'single' | 'erase';
export const OBJECT_MODES: ObjectMode[] = ['spray', 'single', 'erase'];
/** Family mixes offered before the single kinds. */
export const KIND_MIXES = ['tree:*', 'bush:*', 'rock:*', 'plant:*'];

export class ObjectTool {
  active = false;
  mode: ObjectMode = 'spray';
  kind = 'tree:*';
  radius = 6;
  shape: SprayShape = 'circle';
  /** Objects per 100 m^2 a dab aims for. */
  density = 3;
  /** Multiplies each family's spacing. */
  spacing = 1;
  /** Random size spread: scale in 1 +- variation. */
  variation = 0.2;
  /** Generator parameter values per kind or mix ("tree:*"), by parameter name. */
  values: Record<string, Record<string, number>> = {};
  private stroke: { last: { x: number; z: number } } | null = null;
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
      if (k === 'o') return this.setActive(!this.active), true;
      if (!this.active) return false;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= OBJECT_MODES.length) return this.setMode(OBJECT_MODES[n - 1]!), true;
      if (e.key === '[' || e.key === ']') return this.stepSize(e.key === ']' ? 1 : -1), true;
      return false;
    });
    const num = (v: string, what: string, lo: number, hi: number) => {
      const x = Number(v);
      if (v === '' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${what}: a number from ${lo} to ${hi}`);
      return x;
    };
    settings.add(
      { name: 'objkind', help: 'what the object brush places: a kind or a mix (tree:* ...)', persist: true, get: () => this.kind, set: (v) => this.setKind(v) },
      {
        name: 'objmode', help: 'object brush: spray, single or erase', persist: true, get: () => this.mode,
        set: (v) => {
          if (!OBJECT_MODES.includes(v as ObjectMode)) throw new Error('objmode: spray, single or erase');
          this.setMode(v as ObjectMode);
        },
      },
      { name: 'objsize', help: 'object brush radius (m)', persist: true, get: () => String(this.radius), set: (v) => this.set({ radius: num(v, 'objsize', 0.5, 64) }) },
      { name: 'objdensity', help: 'objects per 100 m^2 per dab', persist: true, get: () => String(this.density), set: (v) => this.set({ density: num(v, 'objdensity', 0.1, 200) }) },
      { name: 'objspacing', help: 'spacing factor (1 = each family\'s room)', persist: true, get: () => String(this.spacing), set: (v) => this.set({ spacing: num(v, 'objspacing', 0.2, 5) }) },
      { name: 'objvariation', help: 'random size spread (0-0.8)', persist: true, get: () => String(this.variation), set: (v) => this.set({ variation: num(v, 'objvariation', 0, 0.8) }) },
      {
        name: 'objparams', help: 'generator parameters per kind (JSON; use the panel or `param`)', persist: true,
        get: () => JSON.stringify(this.values),
        set: (v) => {
          const x = JSON.parse(v) as unknown;
          if (!x || typeof x !== 'object') throw new Error('objparams: a JSON object');
          this.values = x as Record<string, Record<string, number>>;
          this.changed();
        },
      },
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

  /**
   * The parameters the brush offers for a kind, or for a mix the ones its
   * family's kinds share by name (each family kind uses what it has).
   */
  paramDescs(kind = this.kind): ParamInfo[] {
    const all = this.app.map?.info.objectParams ?? {};
    if (!kind.endsWith(':*')) return all[kind] ?? [];
    const fam = kind.split(':')[0];
    const seen = new Map<string, ParamInfo>();
    for (const [k, list] of Object.entries(all)) if (k.split(':')[0] === fam) for (const d of list) if (!seen.has(d.name)) seen.set(d.name, d);
    return [...seen.values()];
  }

  /** The brush's value for a parameter (its default if not set). */
  param(name: string): number {
    const d = this.paramDescs().find((x) => x.name === name);
    return this.values[this.kind]?.[name] ?? d?.default ?? NaN;
  }

  setParam(name: string, v: number): void {
    const d = this.paramDescs().find((x) => x.name === name);
    if (!d) throw new Error(`${this.kind} has no parameter "${name}" (see: param)`);
    if (!Number.isFinite(v)) throw new Error(`${name}: a number`);
    const clamped = Math.min(d.max, Math.max(d.min, v));
    (this.values[this.kind] ??= {})[name] = clamped;
    this.changed();
  }

  resetParams(): void {
    delete this.values[this.kind];
    this.changed();
  }

  /** The brush's parameter values that differ from the defaults, by name (for presets). */
  changedParams(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const d of this.paramDescs()) {
      const v = this.values[this.kind]?.[d.name];
      if (v !== undefined && Math.abs(v - d.default) > 1e-6) out[d.name] = v;
    }
    return out;
  }

  applyPreset(p: Preset): void {
    this.setKind(p.kind);
    this.values[p.kind] = { ...p.values };
    this.changed();
  }

  /** Parameter values for an object of kind `k` placed now (undefined = all defaults). */
  paramsFor(k: string): number[] | undefined {
    const descs = this.app.map?.info.objectParams?.[k] ?? [];
    const set = this.values[this.kind] ?? {};
    const vals = descs.map((d) => (Number.isFinite(set[d.name]) ? Math.min(d.max, Math.max(d.min, set[d.name]!)) : d.default));
    return vals.some((v, i) => Math.abs(v - descs[i]!.default) > 1e-6) ? vals : undefined;
  }

  /** The kinds the picker offers: the mixes, then every single kind. */
  kinds(): string[] {
    return [...KIND_MIXES, ...(this.app.map?.info.objectKinds ?? [])];
  }

  setActive(on: boolean): void {
    if (on && !this.app.world) return;
    if (on === this.active) return;
    this.end();
    if (on) this.tools.claim('objects', () => this.setActive(false));
    else this.tools.release('objects');
    this.active = on;
    this.editor.setPainting(on);
    this.changed();
  }

  setMode(m: ObjectMode): void {
    this.mode = m;
    this.changed();
  }

  setKind(k: string): void {
    if (!this.kinds().includes(k) && !(KIND_MIXES.includes(k))) throw new Error(`objkind: a kind (see kinds) or ${KIND_MIXES.join(', ')}`);
    this.kind = k;
    this.changed();
  }

  set(o: Partial<Pick<ObjectTool, 'radius' | 'density' | 'spacing' | 'variation' | 'shape'>>): void {
    Object.assign(this, o);
    this.changed();
  }

  stepSize(dir: 1 | -1): void {
    const sizes = BRUSH_SIZES.filter((s) => s >= 0.5).concat([48, 64]);
    const i = sizes.findIndex((s) => s >= this.radius - 1e-9);
    this.set({ radius: sizes[Math.min(sizes.length - 1, Math.max(0, (i < 0 ? sizes.length - 1 : i) + dir))]! });
  }

  /** Start a stroke at p: one dab (spray / erase) or one object (single). */
  begin(p: { x: number; z: number }): void {
    this.end();
    const label = this.mode === 'erase' ? 'erase objects' : this.mode === 'single' ? `place ${this.kind}` : `spray ${this.kind}`;
    this.undo.begin(label);
    if (this.mode === 'single') {
      this.placeOne(p);
      this.undo.end();
      return;
    }
    this.stroke = { last: p };
    this.dab(p);
  }

  continueTo(p: { x: number; z: number }): void {
    const s = this.stroke;
    if (!s) return;
    const step = Math.max(0.5, this.radius * 0.5);
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

  /** A whole stroke from a to b (terminal, tests); returns objects added (or removed when erasing). */
  strokeLine(a: { x: number; z: number }, b: { x: number; z: number }): number {
    const before = this.app.map?.objectCount ?? 0;
    this.begin(a);
    if (this.mode !== 'single') this.continueTo(b);
    this.end();
    return Math.abs((this.app.map?.objectCount ?? 0) - before);
  }

  private placeOne(p: { x: number; z: number }): void {
    const map = this.app.map;
    if (!map) return;
    const kind = pickKind(this.kind, map.info.objectKinds, Math.random);
    map.addObject({ kind, x: p.x, z: p.z, yaw: Math.random() * Math.PI * 2, scale: this.randomScale(), seed: (Math.random() * 0xffff) | 0, params: this.paramsFor(kind) });
  }

  private randomScale(): number {
    return Math.max(0.05, 1 + (Math.random() * 2 - 1) * this.variation);
  }

  private dab(p: { x: number; z: number }): void {
    const map = this.app.map;
    if (!map) return;
    if (this.mode === 'erase') {
      for (const o of map.objectsNear(p.x, p.z, this.radius)) {
        if (this.shape === 'square' && (Math.abs(o.x - p.x) > this.radius || Math.abs(o.z - p.z) > this.radius)) continue;
        map.removeObject(o.id);
      }
      return;
    }
    const own = spacingFor(this.kind, this.spacing);
    const near = map.objectsNear(p.x, p.z, this.radius + 4 * Math.max(1, this.spacing)).map((o) => ({ x: o.x, z: o.z, spacing: spacingFor(o.kind, this.spacing) }));
    for (const q of sprayDab(p.x, p.z, { radius: this.radius, shape: this.shape, density: this.density, spacing: own }, near, Math.random)) {
      const kind = pickKind(this.kind, map.info.objectKinds, Math.random);
      map.addObject({ kind, x: q.x, z: q.z, yaw: Math.random() * Math.PI * 2, scale: this.randomScale(), seed: (Math.random() * 0xffff) | 0, params: this.paramsFor(kind) });
    }
  }

  /** The brush outline under the mouse (a cross for single placement). */
  private outline(p: { x: number; z: number } | null): void {
    if (!p || !this.active || !this.app.world) {
      if (this.draw.has('tiles')) {
        this.draw.set('tiles', null);
        this.app.viewer.requestRender();
      }
      return;
    }
    const map = this.app.map, g = this.app.world.info.ground, l = new Lines();
    const yAt = (x: number, z: number) => g + (map ? map.heightAt(x, z) : 0), piece = map?.hasHeights ? 0.5 : Infinity;
    const col = this.mode === 'erase' ? COLORS.dirty : COLORS.edited;
    if (this.mode === 'single') {
      l.drape(p.x - 0.6, p.z, p.x + 0.6, p.z, col, yAt, 0.1, piece);
      l.drape(p.x, p.z - 0.6, p.x, p.z + 0.6, col, yAt, 0.1, piece);
      l.circleOn(p.x, p.z, spacingFor(this.kind, this.spacing) / 2, col, yAt, 0.1, 24);
    } else if (this.shape === 'square') l.squareOn(p.x, p.z, this.radius, col, yAt, 0.1, piece);
    else l.circleOn(p.x, p.z, this.radius, col, yAt, 0.1, 48);
    this.draw.set('tiles', l);
    this.app.viewer.requestRender();
  }
}
