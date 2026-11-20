// Editing the canvas: the camera mode, the ground grid and snapping.
//
//   T      top-down view: the camera looks straight down, north (-z) up.
//          Left or right drag pans, the wheel raises / lowers the camera,
//          arrow keys pan. It is a perspective camera pointing down rather
//          than an orthographic one, because glyph sizes are chosen by
//          distance from the eye. T again goes back to orbiting, where you
//          were.
//   G      grid on the ground; its spacing follows your height (or the snap
//          size), chunk borders drawn brighter.
//   snap   off / 0.5 / 1 / 2 / 4 / 8 m: the point under the mouse snaps to
//          that grid, and a marker shows it. Brushes (step 7) use `point()`.
//
// Also settable from the menu (Settings -> editing), the terminal (camera,
// grid, snap, or `set`), and remembered between visits.

import { MOUSE, Vector3 } from 'three';
import { COLORS, DebugDraw, Lines } from '../render/debugdraw';
import { addRootKeys } from '../ui/widgets';
import type { App } from './app';
import type { Cursor } from './cursor';
import type { Settings } from './settings';

export type CameraMode = 'orbit' | 'top';
/** Snap sizes in metres (0 = off). */
export const SNAP_STEPS = [0, 0.5, 1, 2, 4, 8];

/** Round (x, z) to the nearest multiple of `step` (0 = unchanged). */
export function snapTo(x: number, z: number, step: number): { x: number; z: number } {
  if (step <= 0) return { x, z };
  return { x: Math.round(x / step) * step, z: Math.round(z / step) * step };
}

interface Saved {
  offset: Vector3;
  targetY: number;
  minPolar: number;
  maxPolar: number;
  minDistance: number;
  maxDistance: number;
  rotate: boolean;
  buttons: { LEFT: MOUSE | null; MIDDLE: MOUSE | null; RIGHT: MOUSE | null };
  screenSpace: boolean;
}

export class Editor {
  mode: CameraMode = 'orbit';
  grid = false;
  /** Snap size in metres, 0 = off. */
  snap = 0;
  private saved: Saved | null = null;
  private draw: DebugDraw;
  private listeners = new Set<() => void>();
  private gridQueued = false;
  private lastGridKey = '';
  /** While true the left mouse button paints; the camera uses the other buttons. */
  private leftPaints = false;

  constructor(private app: App, private cursor: Cursor, settings: Settings) {
    this.draw = new DebugDraw(app.viewer.overlay);
    const v = app.viewer;
    v.controls.addEventListener('change', () => this.queueGrid());
    v.renderer.domElement.addEventListener('pointermove', () => this.updateMarker());
    app.onSceneChange((name) => {
      if (this.mode !== 'top') return;
      // A new scene resets the camera: keep the top view on the canvas, drop it elsewhere.
      if (name === 'canvas') this.enterTop(false);
      else {
        // The new scene placed its own camera: give back rotation and the
        // normal mouse buttons, but keep its distances and position.
        this.restoreControls(false);
        this.mode = 'orbit';
        this.saved = null;
        this.changed();
      }
    });
    addRootKeys((e) => {
      const k = e.key.toLowerCase();
      if (k === 't') return this.toggleMode(), true;
      if (k === 'g') return this.setGrid(!this.grid), true;
      if (this.mode === 'top' && e.key.startsWith('Arrow')) {
        const step = (v.camera.position.y - (app.world?.info.ground ?? 0)) * 0.08 * (e.shiftKey ? 4 : 1);
        const d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
        if (!d) return false;
        this.pan(d[0]! * step, d[1]! * step);
        return true;
      }
      return false;
    });
    settings.add(
      {
        name: 'camera', help: 'top (top-down editing view) or orbit', persist: true,
        get: () => this.mode,
        set: (val) => {
          if (val !== 'top' && val !== 'orbit') throw new Error('camera: top or orbit');
          this.setMode(val);
        },
      },
      {
        name: 'grid', help: 'ground grid on / off', persist: true,
        get: () => (this.grid ? 'on' : 'off'),
        set: (val) => {
          if (val !== 'on' && val !== 'off') throw new Error('grid: on or off');
          this.setGrid(val === 'on');
        },
      },
      {
        name: 'snap', help: `snap the cursor to a grid: off or ${SNAP_STEPS.slice(1).join(' / ')} m`, persist: true,
        get: () => (this.snap ? String(this.snap) : 'off'),
        set: (val) => {
          const n = val === 'off' ? 0 : Number(val);
          if (!SNAP_STEPS.includes(n)) throw new Error(`snap: off or ${SNAP_STEPS.slice(1).join(', ')}`);
          this.setSnap(n);
        },
      },
    );
  }

  /** Called whenever the mode, grid or snap changes. */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
    this.queueGrid();
    this.updateMarker();
  }

  /** The ground point under the mouse, snapped if snapping is on (null off the ground). */
  point(): { x: number; z: number } | null {
    const g = this.cursor.ground();
    return g ? snapTo(g.x, g.z, this.snap) : null;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    if (mode === 'top') {
      if (!this.app.world) throw new Error('the top view is for the canvas');
      this.enterTop(true);
    } else this.leaveTop();
  }

  toggleMode(): void {
    if (!this.app.world && this.mode === 'orbit') return; // no top view on galleries and models
    this.setMode(this.mode === 'top' ? 'orbit' : 'top');
  }

  setGrid(on: boolean): void {
    this.grid = on;
    this.changed();
  }

  setSnap(step: number): void {
    this.snap = step;
    this.changed();
  }

  /** Give the left mouse button to a tool (true) or back to the camera (false). */
  setPainting(on: boolean): void {
    this.leftPaints = on;
    this.applyButtons();
  }

  get painting(): boolean {
    return this.leftPaints;
  }

  /**
   * Mouse buttons for the current camera mode and tool. Top view: drag
   * pans. Orbit: left rotates. While a tool paints, left is the tool's and
   * the camera moves with the others (orbit: middle rotates; right pans).
   */
  private applyButtons(): void {
    const c = this.app.viewer.controls, p = this.leftPaints;
    c.mouseButtons = this.mode === 'top'
      ? { LEFT: p ? null : MOUSE.PAN, MIDDLE: p ? MOUSE.PAN : MOUSE.DOLLY, RIGHT: MOUSE.PAN }
      : { LEFT: p ? null : MOUSE.ROTATE, MIDDLE: p ? MOUSE.ROTATE : MOUSE.DOLLY, RIGHT: MOUSE.PAN };
  }

  /** Move camera and target together over the ground. */
  pan(dx: number, dz: number): void {
    const v = this.app.viewer;
    v.camera.position.x += dx;
    v.camera.position.z += dz;
    v.controls.target.x += dx;
    v.controls.target.z += dz;
    v.controls.update();
    v.requestRender();
  }

  /** Look straight down at the orbit target; `save` remembers the orbit setup to come back to. */
  private enterTop(save: boolean): void {
    const v = this.app.viewer, c = v.controls, g = this.app.world?.info.ground ?? 0;
    v.stopMotion();
    if (save || !this.saved) {
      this.saved = {
        offset: v.camera.position.clone().sub(c.target),
        targetY: c.target.y,
        minPolar: c.minPolarAngle, maxPolar: c.maxPolarAngle,
        minDistance: c.minDistance, maxDistance: c.maxDistance,
        rotate: c.enableRotate,
        buttons: { ...c.mouseButtons } as Saved['buttons'],
        screenSpace: c.screenSpacePanning,
      };
    }
    const h = Math.min(250, Math.max(15, v.camera.position.distanceTo(c.target)));
    c.target.y = g;
    v.camera.position.set(c.target.x, g + h, c.target.z + 0.001); // north (-z) up on screen
    c.minPolarAngle = 0;
    c.maxPolarAngle = 0;
    c.enableRotate = false;
    c.screenSpacePanning = true;
    c.minDistance = 5;
    c.maxDistance = 400;
    this.mode = 'top';
    this.applyButtons();
    c.update();
    this.app.world?.update(v.camera.position, true);
    v.requestRender();
    this.changed();
  }

  /** Undo what the top view changed on the controls (and, with `distances`, their zoom limits). */
  private restoreControls(distances: boolean): void {
    const c = this.app.viewer.controls, s = this.saved;
    c.minPolarAngle = s?.minPolar ?? 0;
    c.maxPolarAngle = s?.maxPolar ?? Math.PI * 0.495;
    c.enableRotate = s?.rotate ?? true;
    c.mouseButtons = s?.buttons ?? { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    c.screenSpacePanning = s?.screenSpace ?? true;
    this.mode = 'orbit';
    if (this.leftPaints) this.applyButtons();
    if (distances && s) {
      c.minDistance = s.minDistance;
      c.maxDistance = s.maxDistance;
    }
  }

  /** Back to orbiting from where the view now is. */
  private leaveTop(): void {
    const v = this.app.viewer, c = v.controls, s = this.saved;
    v.stopMotion();
    this.restoreControls(true);
    if (s) {
      c.target.y = s.targetY;
      v.camera.position.copy(c.target).add(s.offset);
    } else {
      v.camera.position.copy(c.target).add(new Vector3(0, 6, 30));
    }
    this.saved = null;
    c.update();
    this.mode = 'orbit';
    this.app.world?.update(v.camera.position, true);
    v.requestRender();
    this.changed();
  }

  private queueGrid(): void {
    if (this.gridQueued) return;
    this.gridQueued = true;
    requestAnimationFrame(() => {
      this.gridQueued = false;
      this.updateGrid();
    });
  }

  /** Grid round the view: spacing doubles until lines are at least ~14 px apart. */
  private updateGrid(): void {
    const v = this.app.viewer, w = this.app.world;
    if (!this.grid || !w) {
      if (this.draw.has('grid')) this.draw.set('grid', null);
      this.lastGridKey = '';
      return;
    }
    const g = w.info.ground, S = w.info.chunkSize, t = v.controls.target;
    const dist = Math.max(2, v.camera.position.distanceTo(t));
    const pxPerM = (v.renderer.domElement.clientHeight / 2) / Math.tan((v.camera.fov * Math.PI) / 360) / dist;
    let step = this.snap || 0.5;
    while (step * pxPerM < 14 && step < S) step *= 2;
    const half = Math.min(400, this.mode === 'top' ? dist * 1.2 + step * 4 : dist * 2.5 + 20);
    const x0 = Math.floor((t.x - half) / step) * step, x1 = Math.ceil((t.x + half) / step) * step;
    const z0 = Math.floor((t.z - half) / step) * step, z1 = Math.ceil((t.z + half) / step) * step;
    const key = `${x0},${z0},${x1},${z1},${step}`;
    if (key === this.lastGridKey) return;
    this.lastGridKey = key;
    const l = new Lines(), y = g + 0.03;
    const major = (n: number) => Math.abs(n / S - Math.round(n / S)) < 1e-6;
    for (let x = x0; x <= x1 + 1e-6; x += step) l.seg(x, y, z0, x, y, z1, major(x) ? COLORS.gridMajor : COLORS.grid);
    for (let z = z0; z <= z1 + 1e-6; z += step) l.seg(x0, y, z, x1, y, z, major(z) ? COLORS.gridMajor : COLORS.grid);
    this.draw.set('grid', l);
    v.requestRender();
  }

  /** A cross on the (snapped) ground point under the mouse, while editing. */
  private updateMarker(): void {
    const editing = this.mode === 'top' || this.grid || this.snap > 0;
    const p = editing ? this.point() : null;
    if (!p || !this.app.world) {
      if (this.draw.has('marker')) {
        this.draw.set('marker', null);
        this.app.viewer.requestRender();
      }
      return;
    }
    const y = this.app.world.info.ground + 0.08, r = Math.max(0.25, this.snap / 2 || 0.25);
    const l = new Lines();
    l.seg(p.x - r, y, p.z, p.x + r, y, p.z, COLORS.marker);
    l.seg(p.x, y, p.z - r, p.x, y, p.z + r, COLORS.marker);
    if (this.snap > 0) l.box(p.x - this.snap / 2, y, p.z - this.snap / 2, p.x + this.snap / 2, y, p.z + this.snap / 2, COLORS.marker);
    this.draw.set('marker', l);
    this.app.viewer.requestRender();
  }
}
