// The look lab: the screen splits into panes that all show the same camera,
// each with its own lighting, weather and water, to compare them live while
// the camera moves and the weather runs. Phase 3 used it to pick the look
// (see look.ts); now it compares that look ("standard") with the one before
// it ("classic"), and will serve Phase 5 the same way. Time of day and the
// other settings are shared by every pane.
//
// Layouts: 1 (one pane), wipe (the same view split by a draggable divider:
// before / after), 2 (side by side, each the whole view), 4 (2 x 2).
// Terminal: `lab`, menu: Look lab, settings remembered in this browser.

import type { ViewPane } from '../render/viewer';
import { addRootKeys } from '../ui/widgets';
import type { App } from './app';
import type { Features, Look } from './look';

export interface Variant {
  id: string;
  name: string;
  help: string;
}

interface Option<T> extends Variant {
  f: T;
}

/** Lighting, weather and water to compare: what Phase 3 picked ("standard") against the look before it ("classic"). */
export const LIGHTS: Option<Pick2<'shadows'>>[] = [
  { id: 'standard', name: 'sun shadows', help: 'live sun shadows: they cross chunk borders, fall from hills, follow the sun and edits', f: { shadows: true } },
  { id: 'classic', name: 'baked (before)', help: 'shadows baked into each chunk from its own objects', f: { shadows: false } },
];
export const WEATHERS: Option<Pick2<'gusts' | 'clouds' | 'wet' | 'storm' | 'treeLeaves'>>[] = [
  { id: 'standard', name: 'standard', help: 'gust waves, faint cloud shadows, wet rain, leaves from the trees', f: { gusts: true, clouds: true, wet: true, storm: false, treeLeaves: true } },
  { id: 'storm', name: 'storm', help: 'standard plus a dark sky and lightning', f: { gusts: true, clouds: true, wet: true, storm: true, treeLeaves: true } },
  { id: 'classic', name: 'classic (before)', help: 'rain streaks, sway and leaves as before Phase 3', f: { gusts: false, clouds: false, wet: false, storm: false, treeLeaves: false } },
];
export const WATERS: Option<Pick2<'waves' | 'shore' | 'glints' | 'rings'>>[] = [
  { id: 'standard', name: 'flowing', help: 'waves follow the current (rivers downhill, still lakes), foam at the shore, sky and sun on the water, rain rings', f: { waves: true, shore: true, glints: true, rings: true } },
  { id: 'classic', name: 'classic (before)', help: 'leaning water glyphs that shimmer', f: { waves: false, shore: false, glints: false, rings: false } },
];
type Pick2<K extends keyof Features> = Pick3<Features, K>;
type Pick3<T, K extends keyof T> = { [P in K]: T[P] };

export type LabLayout = '1' | 'wipe' | '2' | '4';
export const LAYOUTS: LabLayout[] = ['1', 'wipe', '2', '4'];

export interface PaneLook {
  light: string;
  weather: string;
  water: string;
}

interface Saved {
  layout: LabLayout;
  panes: PaneLook[];
  wipe: number;
}

const KEY = 'ascii-sandbox.lab2';

export class Lab {
  enabled = false;
  layout: LabLayout = 'wipe';
  panes: PaneLook[] = [
    { light: 'classic', weather: 'classic', water: 'classic' },
    { light: 'standard', weather: 'standard', water: 'standard' },
    { light: 'standard', weather: 'storm', water: 'standard' },
    { light: 'classic', weather: 'standard', water: 'standard' },
  ];
  /** Wipe divider position (0-1 across the screen). */
  wipe = 0.5;
  private labels: HTMLDivElement[] = [];
  private divider: HTMLDivElement;
  private listeners = new Set<() => void>();
  /** Share of the screen width the panes may use from the left (the options sidebar takes the rest). */
  room: () => number = () => 1;

  constructor(private app: App, readonly look: Look) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
      if (s) {
        if (LAYOUTS.includes(s.layout)) this.layout = s.layout;
        if (Array.isArray(s.panes)) s.panes.slice(0, 4).forEach((p, i) => (this.panes[i] = { ...this.panes[i]!, ...p }));
        if (typeof s.wipe === 'number') this.wipe = Math.min(0.95, Math.max(0.05, s.wipe));
      }
    } catch {
      // nothing saved, or storage blocked
    }
    this.divider = document.createElement('div');
    this.divider.className = 'tui-lab-divider';
    this.divider.hidden = true;
    this.divider.title = 'drag to move the divider';
    this.divider.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.divider.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        const room = Math.min(1, Math.max(0.3, this.room()));
        this.wipe = Math.min(0.95, Math.max(0.05, m.clientX / (window.innerWidth * room)));
        this.changed();
      };
      const up = () => {
        this.divider.removeEventListener('pointermove', move);
        this.divider.removeEventListener('pointerup', up);
      };
      this.divider.addEventListener('pointermove', move);
      this.divider.addEventListener('pointerup', up);
    });
    document.body.append(this.divider);
    addRootKeys((e) => {
      if (e.key.toLowerCase() !== 'l' || e.ctrlKey || e.metaKey || e.altKey || !this.app.world) return false;
      this.setEnabled(!this.enabled);
      return true;
    });
    app.onSceneChange(() => {
      if (this.enabled && !app.world) this.enabled = false;
      this.refresh();
    });
    look.onChange(() => {
      for (const f of this.listeners) f();
    });
  }

  onChange(f: () => void): void {
    this.listeners.add(f);
  }

  /** Turn the lab on or off (only on the canvas). */
  setEnabled(on: boolean): void {
    if (on && !this.app.world) throw new Error('the look lab works on the canvas (run: canvas)');
    this.enabled = on;
    this.changed();
  }

  setLayout(l: LabLayout): void {
    this.layout = l;
    this.changed();
  }

  /** Set one pane's lighting, weather or water (by id). */
  setPane(i: number, what: keyof PaneLook, id: string): void {
    const list: Variant[] = what === 'light' ? LIGHTS : what === 'weather' ? WEATHERS : WATERS;
    if (!list.some((v) => v.id === id)) throw new Error(`no ${what} variant "${id}" (${list.map((v) => v.id).join(', ')})`);
    const p = this.panes[i];
    if (!p) throw new Error('pane 1-4');
    p[what] = id;
    this.changed();
  }

  /** Panes the current layout shows. */
  get paneCount(): number {
    return this.layout === '1' ? 1 : this.layout === '4' ? 4 : 2;
  }

  private changed(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ layout: this.layout, panes: this.panes, wipe: this.wipe } satisfies Saved));
    } catch {
      // storage blocked
    }
    this.refresh();
    for (const f of this.listeners) f();
  }

  /** The space for the panes changed (sidebar shown, hidden or moved; window resized). */
  relayout(): void {
    if (this.enabled) this.refresh();
  }

  /** The features a pane shows. */
  featuresOf(i: number): Features {
    const p = this.panes[i]!;
    const pick = <T>(list: Option<T>[], id: string) => (list.find((v) => v.id === id) ?? list[0]!).f;
    return { ...this.look.features, ...pick(LIGHTS, p.light), ...pick(WEATHERS, p.weather), ...pick(WATERS, p.water) };
  }

  private refresh(): void {
    const v = this.app.viewer;
    const on = this.enabled && !!this.app.world;
    for (const l of this.labels) l.remove();
    this.labels = [];
    this.divider.hidden = !(on && this.layout === 'wipe');
    if (!on) {
      v.panes = null;
      this.look.panes = null;
      v.requestRender();
      return;
    }
    const n = this.paneCount;
    const rects: [number, number, number, number][] =
      this.layout === '1' ? [[0, 0, 1, 1]]
        : this.layout === 'wipe' ? [[0, 0, this.wipe, 1], [this.wipe, 0, 1 - this.wipe, 1]]
          : this.layout === '2' ? [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]
            : [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
    const panes: ViewPane[] = [];
    const features: Features[] = [];
    const room = Math.min(1, Math.max(0.3, this.room()));
    for (let i = 0; i < n; i++) {
      const [rx, y, rw, h] = rects[i]!;
      const x = rx * room, w = rw * room;
      const f = this.featuresOf(i);
      features.push(f);
      panes.push({ x, y, w, h, view: this.layout === 'wipe' ? [0, 0, room, 1] : undefined, apply: () => this.look.apply(f) });
      const label = document.createElement('div');
      label.className = 'tui tui-lab-label';
      const look = this.panes[i]!;
      const name = (list: Variant[], id: string) => list.find((q) => q.id === id)?.name ?? id;
      label.innerHTML = `<b>${i + 1}</b> light ${name(LIGHTS, look.light)} · weather ${name(WEATHERS, look.weather)} · water ${name(WATERS, look.water)}`;
      Object.assign(label.style, { left: `calc(${x * 100}% + 8px)`, top: `calc(${y * 100}% + ${y === 0 ? 34 : 6}px)`, maxWidth: `calc(${w * 100}% - 16px)` });
      document.body.append(label);
      this.labels.push(label);
    }
    if (this.layout === 'wipe') this.divider.style.left = `${this.wipe * room * 100}%`;
    this.look.panes = features;
    v.panes = panes;
    v.animate = true;
    v.requestRender();
  }

  /** Lines of a terminal listing. */
  describe(): string[] {
    const out = [`look lab ${this.enabled ? 'on' : 'off'} · layout ${this.layout}`];
    this.panes.slice(0, this.paneCount).forEach((p, i) => out.push(`  pane ${i + 1}: light ${p.light} · weather ${p.weather} · water ${p.water}`));
    return out;
  }
}

/**
 * The test scene: one view with everything the looks need. A lake with a
 * sand shore and reeds, a stream, a meadow, a forested hill across two chunk
 * borders (cross-border shadows), rocks, a lone oak by the water for close
 * shadows. Built from terminal commands so it is easy to read and change.
 */
export const LAB_SCENE: string[] = [
  'clearmap yes',
  'fill grass -70 -90 70 30',
  'paint sand -16 -18 15',
  'paint water -16 -18 11',
  'fill sand -5 -21 50 -14',
  'fill water -5 -19.5 50 -15.5',
  'fill rock -14 -58 -4 -50',
  'height raise; height size 14; height strength 3',
  'repeat 3 height stroke -4 -46 4 -42',
  'height size 9; height strength 2',
  'repeat 2 height stroke 10 -60 14 -56',
  'height smooth; height strength 1; height size 16; height stroke -6 -50 12 -40',
  'height off; height raise; height size 6; height strength 0.5',
  'scatter trees 26 0 -45 15',
  'scatter bushes 14 0 -45 17',
  'scatter rocks 8 -10 -54 6',
  'scatter rocks 6 -16 -18 15',
  'scatter plants 40 -16 -18 14',
  'scatter plants 30 0 -6 18',
  'scatter bushes 8 -38 -40 10',
  'scatter trees 10 -40 -46 12',
  'place tree:oak 10 -27 1.3 7',
  'place rock:boulder 18 -10 1.6 3',
  'lab view wide',
];

/** Camera spots in the test scene. */
export const LAB_VIEWS: Record<string, string> = {
  wide: 'cam 30 9 -14 -12 1 -30',
  lake: 'cam -3 3.5 -6 -18 0 -20',
  hill: 'cam 24 7 -30 0 4 -46',
  oak: 'cam 19 2.5 -20 10 2 -28',
  stream: 'cam 40 2.5 -12 10 0 -18',
  // the landscape (lab landscape)
  landscape: 'cam 12 20 2 -14 10 -110',
  valley: 'cam -46 14 -12 8 14 -120',
  lakeside: 'cam -3 4 -36 -28 0 -50',
  river: 'cam 18 8 -60 2 2 -100',
  peaks: 'cam 6 26 -80 -20 30 -150',
};

/**
 * The lab landscape: a whole valley to judge the looks in. A ridge of
 * mountains with rocky peaks and conifer slopes at the back, a river
 * winding down from them into a lake with a sand shore, reeds and an island,
 * then on out of the lake; wooded hills on both sides, a meadow with
 * flowers, bushes and a few lone trees in front. About 230 x 220 m, built
 * from terminal commands (`lab landscape`), then saved as "lab-landscape"
 * so `load lab-landscape` brings it back quickly.
 */
export function landscapeLines(): string[] {
  const L: string[] = ['clearmap yes', 'fill grass -120 -180 120 50'];
  // The river's course: from the mountains (z -118) down to the lake, then out toward the front left.
  const river: [number, number][] = [];
  for (let z = -118; z <= -62; z += 4) river.push([8 + 10 * Math.sin((z + 118) / 14) - (z + 118) * 0.35, z]);
  for (let t = 0; t <= 1.0001; t += 0.03) river.push([-38 - 30 * t + 6 * Math.sin(t * 7), -30 + 70 * t]); // points under 3 m apart: no gaps
  const lake = { x: -25, z: -45, r: 18 };
  const f = (v: number) => v.toFixed(1);

  // Mountains: a ridge, two peaks, smoothed.
  // Wide and not too steep: steep faces get few ground glyphs and read as holes.
  L.push('height raise; height size 44; height strength 2.2');
  for (const [x0, z0, x1, z1] of [[-115, -150, -60, -140], [-60, -140, -10, -156], [-10, -156, 40, -138], [40, -138, 115, -152]]) {
    L.push(`repeat 3 height stroke ${x0} ${z0} ${x1} ${z1}`);
  }
  L.push('height size 30; height strength 2.2', 'repeat 2 height stroke -50 -150 -42 -146', 'repeat 2 height stroke 26 -142 34 -138');
  // Hills on both sides, and a knoll in the meadow.
  L.push('height size 20; height strength 3', 'repeat 2 height stroke -88 -72 -64 -55', 'repeat 2 height stroke 64 -62 92 -44');
  L.push('height size 14; height strength 2', 'repeat 2 height stroke 48 -8 60 2');
  L.push('height smooth; height strength 1; height size 30', 'repeat 2 height stroke -110 -146 110 -146', 'height stroke -88 -64 92 -52');
  // The lake basin, an island, and the river's bed.
  L.push('height lower; height size 22; height strength 1.2', 'repeat 2 height stroke -30 -45 -20 -45');
  L.push('height raise; height size 4; height strength 0.6', 'height stroke -21 -49 -19 -48');
  // The land falls away at the front left, so the river leaves the lake and runs off downhill.
  L.push('height lower; height size 34; height strength 2', 'repeat 2 height stroke -72 34 -64 42');
  L.push('height lower; height size 7; height strength 0.6');
  for (let i = 0; i + 1 < river.length; i += 3) {
    const a = river[i]!, b = river[Math.min(i + 3, river.length - 1)]!;
    L.push(`height stroke ${f(a[0])} ${f(a[1])} ${f(b[0])} ${f(b[1])}`);
  }
  L.push('height off; height raise; height size 6; height strength 0.5');

  // Paint: rocky peaks and ridge, sand banks, then the water.
  L.push('paint rock -46 -148 18', 'paint rock 30 -140 15');
  for (let x = -100; x <= 100; x += 25) L.push(`paint rock ${x} ${x < -10 ? -147 : -145} 9`);
  L.push(`paint sand ${lake.x} ${lake.z} ${lake.r + 5}`);
  for (const [x, z] of river) L.push(`paint sand ${f(x)} ${f(z)} 4.5`);
  L.push(`paint water ${lake.x} ${lake.z} ${lake.r}`);
  for (const [x, z] of river) L.push(`paint water ${f(x)} ${f(z)} 2.4`);
  L.push('paint sand -20 -48.5 3.5', 'paint grass -20 -48.5 2');

  // Plants and objects.
  L.push(
    'scatter tree:spruce 34 -75 -118 26', 'scatter tree:pine 34 62 -120 26', 'scatter tree:pine 14 -10 -114 18',
    'scatter rock:outcrop 10 -46 -148 14', 'scatter rock:angular 10 30 -140 12', 'scatter rock:slab 8 -80 -140 20',
    'scatter tree:oak 18 -76 -63 18', 'scatter tree:birch 14 -60 -78 14', 'scatter bushes 22 -76 -63 22',
    'scatter tree:maple 14 78 -53 16', 'scatter tree:birch 10 58 -40 12', 'scatter bushes 16 78 -53 20',
    'scatter plant:reeds 46 -25 -45 23', 'scatter plant:fern 20 -55 -55 12',
    'scatter rock:pebbles 12 0 -88 14', 'scatter rock:boulder 6 -6 -70 10',
    'scatter plant:wildflowers 50 12 -12 30', 'scatter plant:grass_tuft 60 -8 4 40', 'scatter bushes 18 26 -30 24',
    'place tree:oak 22 -20 1.4 11', 'place tree:oak -52 -8 1.2 5', 'place tree:dead 36 -76 1 2', 'place tree:birch -20 -48.5 0.8 9',
    'place rock:boulder 12 -4 1.8 4',
  );
  L.push('save lab-landscape', 'lab time 16.5', 'lab view landscape');
  return L;
}
