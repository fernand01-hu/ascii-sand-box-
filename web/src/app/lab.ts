// The look lab (Phase 3: lighting, weather, water). The screen splits into
// panes that all show the same camera; each pane picks one variant of the
// lighting, the weather look and the water, so they can be compared live,
// side by side, while the camera moves and the weather runs. Time of day is
// shared by every pane (it shows which lighting holds up when the sun moves).
//
// Layouts: 1 (one pane), wipe (the same view split by a draggable divider:
// before / after), 2 (side by side, each the whole view), 4 (2 x 2).
// Terminal: `lab`, menu: Look lab, settings remembered in this browser.

import { Color, Vector3, Vector4 } from 'three';
import type { Lighting } from '../render/cards';
import { SunShadow } from '../render/sunshadow';
import type { ViewPane } from '../render/viewer';
import type { App } from './app';
import { ShoreMap } from './shoremap';
import { addRootKeys } from '../ui/widgets';
import type { MapData } from './map';

export interface Variant {
  id: string;
  name: string;
  help: string;
}

interface LightVariant extends Variant {
  /** Sun from the shadow map; shading 0 colour, 1 glyph ramp, 2 retro 16, 3 amber. */
  shadows: boolean;
  shade: number;
}

interface WeatherVariant extends Variant {
  gusts?: boolean;
  clouds?: boolean;
  wet?: boolean;
  mist?: boolean;
  storm?: boolean;
}

interface WaterVariant extends Variant {
  waves?: boolean;
  shore?: boolean;
  glints?: boolean;
  rings?: boolean;
}

export const LIGHTS: LightVariant[] = [
  { id: 'baked', name: 'A  baked (now)', help: 'shadows baked into each chunk from its own objects; the sun can\'t move', shadows: false, shade: 0 },
  { id: 'shadows', name: 'B  sun shadows', help: 'live shadow map: shadows cross chunk borders, hills cast them, they follow the sun and edits', shadows: true, shade: 0 },
  { id: 'glyphs', name: 'C  glyph shading', help: 'darkness drawn by the glyphs themselves, @ % # * + = - : . from lit to dark', shadows: false, shade: 1 },
  { id: 'shadows-glyphs', name: 'D  shadows + glyphs', help: 'B and C together', shadows: true, shade: 1 },
  { id: 'retro', name: 'E  retro 16 colours', help: 'colours snapped to a 16-colour text-mode palette, slight dither', shadows: true, shade: 2 },
  { id: 'amber', name: 'F  amber terminal', help: 'one phosphor colour, brightness only (with sun shadows)', shadows: true, shade: 3 },
];

export const WEATHERS: WeatherVariant[] = [
  { id: 'now', name: 'A  now', help: 'today\'s rain streaks, sway and leaves' },
  { id: 'gusts', name: 'B  gust waves', help: 'patches of strong wind roll across the grass, bending and brightening it', gusts: true },
  { id: 'clouds', name: 'C  cloud shadows', help: 'big soft shadows drifting over the land with the wind', clouds: true },
  { id: 'wet', name: 'D  wet rain', help: 'rain darkens the ground with a sheen; drops splash on it (. o O)', wet: true },
  { id: 'mist', name: 'E  mist', help: 'fog banks hugging the low ground, drifting', mist: true },
  { id: 'storm', name: 'F  storm', help: 'dark sky, lightning flashes, gusts and wet ground', storm: true, gusts: true, wet: true },
  { id: 'all', name: 'G  everything', help: 'B to E together', gusts: true, clouds: true, wet: true, mist: true },
];

export const WATERS: WaterVariant[] = [
  { id: 'now', name: 'A  now', help: 'today\'s leaning water glyphs and shimmer' },
  { id: 'waves', name: 'B  glyph waves', help: 'waves travel across the water drawn by the glyphs: _ . - ~ ^ to the crest', waves: true },
  { id: 'shore', name: 'C  shore + foam', help: 'light shallow water at the edge, dark deep water, foam lapping the shore', shore: true },
  { id: 'glints', name: 'D  glints + sky', help: 'the sky reflected at grazing angles, sun glitter sparkling on the water', glints: true },
  { id: 'rings', name: 'E  rain rings', help: 'raindrops open rings on the water (. o O); turn the rain on', rings: true },
  { id: 'all', name: 'F  everything', help: 'B to E together', waves: true, shore: true, glints: true, rings: true },
];

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
  hour: number | null;
}

const KEY = 'ascii-sandbox.lab';

/** Light at an hour of the day: sun (or moon) colour, sky, haze, background, sky-dome tint. */
const DAY_KEYS: [number, number[], number[], number[], number[], number[]][] = [
  // hour, sun, sky, haze, background, sky tint
  [0, [0.16, 0.2, 0.36], [0.1, 0.12, 0.26], [0.07, 0.08, 0.14], [0.02, 0.025, 0.05], [0.22, 0.26, 0.45]],
  [5.2, [0.2, 0.2, 0.38], [0.14, 0.15, 0.3], [0.12, 0.11, 0.18], [0.04, 0.04, 0.07], [0.35, 0.33, 0.5]],
  [6.3, [1.0, 0.5, 0.38], [0.36, 0.34, 0.58], [0.3, 0.24, 0.32], [0.11, 0.08, 0.13], [0.85, 0.68, 0.78]],
  [8, [1.25, 0.98, 0.74], [0.45, 0.55, 0.82], [0.2, 0.23, 0.31], [0.1, 0.11, 0.15], [1.05, 1.02, 1.08]],
  [13, [1.35, 1.26, 1.1], [0.5, 0.6, 0.88], [0.24, 0.3, 0.4], [0.11, 0.14, 0.19], [1.25, 1.32, 1.45]],
  [17.5, [1.32, 1.02, 0.7], [0.48, 0.55, 0.82], [0.24, 0.23, 0.33], [0.1, 0.1, 0.15], [1.08, 1.04, 1.06]],
  [19, [1.3, 0.92, 0.58], [0.46, 0.52, 0.8], [0.29, 0.28, 0.41], [0.09, 0.09, 0.13], [1, 1, 1]],
  [20.5, [0.75, 0.32, 0.36], [0.25, 0.25, 0.5], [0.18, 0.16, 0.28], [0.05, 0.05, 0.09], [0.55, 0.45, 0.65]],
  [22, [0.16, 0.2, 0.36], [0.1, 0.12, 0.26], [0.07, 0.08, 0.14], [0.02, 0.025, 0.05], [0.22, 0.26, 0.45]],
  [24, [0.16, 0.2, 0.36], [0.1, 0.12, 0.26], [0.07, 0.08, 0.14], [0.02, 0.025, 0.05], [0.22, 0.26, 0.45]],
];

function dayKey(hour: number): { sun: Vector3; sky: Vector3; haze: Vector3; bg: Vector3; tint: Vector3 } {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < DAY_KEYS.length - 2 && DAY_KEYS[i + 1]![0] <= h) i++;
  const a = DAY_KEYS[i]!, b = DAY_KEYS[i + 1]!;
  const t = (h - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const mix = (k: 1 | 2 | 3 | 4 | 5) => new Vector3(...(a[k] as [number, number, number])).lerp(new Vector3(...(b[k] as [number, number, number])), t);
  return { sun: mix(1), sky: mix(2), haze: mix(3), bg: mix(4), tint: mix(5) };
}

/** Sun direction at an hour: rises in the east (+x) at 6, highest (60 degrees) at 13, sets in the west at 20; the moon at night. */
export function sunAt(hour: number): Vector3 {
  const h = ((hour % 24) + 24) % 24;
  const day = h >= 6 && h <= 20;
  const t = day ? (h - 6) / 14 : ((h + 4) % 24) / 10; // 0..1 across the sky
  const az = Math.PI * t;
  const el = Math.max(0.06, Math.sin(Math.PI * t)) * (day ? 1.05 : 0.8);
  return new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), -0.35 - Math.sin(az) * Math.cos(el) * 0.6).normalize();
}

export class Lab {
  enabled = false;
  layout: LabLayout = '2';
  panes: PaneLook[] = [
    { light: 'baked', weather: 'now', water: 'now' },
    { light: 'shadows', weather: 'gusts', water: 'all' },
    { light: 'glyphs', weather: 'clouds', water: 'waves' },
    { light: 'shadows-glyphs', weather: 'wet', water: 'shore' },
  ];
  /** Wipe divider position (0-1 across the screen). */
  wipe = 0.5;
  /** Shared time of day (hours), or null for the scene's own light. */
  hour: number | null = null;
  private sun: SunShadow | null = null;
  private shore = new ShoreMap();
  private base: { light: Lighting; haze: Vector3; bg: Color } | null = null;
  private labels: HTMLDivElement[] = [];
  private divider: HTMLDivElement;
  private listeners = new Set<() => void>();
  private flash = 0;
  /** Share of the screen width the panes may use from the left (the options sidebar takes the rest). */
  room: () => number = () => 1;
  private watched: MapData | null = null;
  private nextBolt = 0;

  constructor(private app: App) {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Saved | null;
      if (s) {
        if (LAYOUTS.includes(s.layout)) this.layout = s.layout;
        if (Array.isArray(s.panes)) s.panes.slice(0, 4).forEach((p, i) => (this.panes[i] = { ...this.panes[i]!, ...p }));
        if (typeof s.wipe === 'number') this.wipe = Math.min(0.95, Math.max(0.05, s.wipe));
        if (s.hour === null || typeof s.hour === 'number') this.hour = s.hour;
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
      const m = app.map;
      if (m && m !== this.watched) {
        this.watched = m;
        m.onEdit((e) => {
          if (e.tiles?.length) this.shore.invalidate();
        });
      }
      this.base = null; // a new scene brings its own light
      this.shore.invalidate();
      if (this.enabled) this.refresh();
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

  /** Set one pane's lighting, weather or water variant (by id). */
  setPane(i: number, what: keyof PaneLook, id: string): void {
    const list: Variant[] = what === 'light' ? LIGHTS : what === 'weather' ? WEATHERS : WATERS;
    if (!list.some((v) => v.id === id)) throw new Error(`no ${what} variant "${id}" (${list.map((v) => v.id).join(', ')})`);
    const p = this.panes[i];
    if (!p) throw new Error('pane 1-4');
    p[what] = id;
    this.changed();
  }

  setHour(h: number | null): void {
    this.hour = h === null ? null : ((h % 24) + 24) % 24;
    this.changed();
  }

  /** Panes the current layout shows. */
  get paneCount(): number {
    return this.layout === '1' ? 1 : this.layout === '4' ? 4 : 2;
  }

  private changed(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify({ layout: this.layout, panes: this.panes, wipe: this.wipe, hour: this.hour } satisfies Saved));
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

  /** The map and paint changed (rebuild the shore map). */
  paintChanged(): void {
    this.shore.invalidate();
  }

  private refresh(): void {
    const v = this.app.viewer;
    const on = this.enabled && !!this.app.world;
    for (const l of this.labels) l.remove();
    this.labels = [];
    this.divider.hidden = !(on && this.layout === 'wipe');
    if (!on) {
      v.panes = null;
      v.beforeDraw = null;
      this.restore();
      v.requestRender();
      return;
    }
    if (!this.base) this.capture();
    const n = this.paneCount;
    const rects: [number, number, number, number][] =
      this.layout === '1' ? [[0, 0, 1, 1]]
        : this.layout === 'wipe' ? [[0, 0, this.wipe, 1], [this.wipe, 0, 1 - this.wipe, 1]]
          : this.layout === '2' ? [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]
            : [[0, 0, 0.5, 0.5], [0.5, 0, 0.5, 0.5], [0, 0.5, 0.5, 0.5], [0.5, 0.5, 0.5, 0.5]];
    const panes: ViewPane[] = [];
    const room = Math.min(1, Math.max(0.3, this.room()));
    for (let i = 0; i < n; i++) {
      const [rx, y, rw, h] = rects[i]!;
      const x = rx * room, w = rw * room;
      panes.push({ x, y, w, h, view: this.layout === 'wipe' ? [0, 0, room, 1] : undefined, apply: () => this.applyPane(i) });
      const label = document.createElement('div');
      label.className = 'tui tui-lab-label';
      const look = this.panes[i]!;
      const name = (list: Variant[], id: string) => list.find((q) => q.id === id)?.name.replace(/\s+/g, ' ') ?? id;
      label.innerHTML = `<b>${i + 1}</b> light ${name(LIGHTS, look.light)} · weather ${name(WEATHERS, look.weather)} · water ${name(WATERS, look.water)}`;
      Object.assign(label.style, { left: `calc(${x * 100}% + 8px)`, top: `calc(${y * 100}% + ${y === 0 ? 34 : 6}px)`, maxWidth: `calc(${w * 100}% - 16px)` });
      document.body.append(label);
      this.labels.push(label);
    }
    if (this.layout === 'wipe') this.divider.style.left = `${this.wipe * room * 100}%`;
    v.panes = panes;
    v.beforeDraw = () => this.beforeDraw();
    v.animate = true;
    v.requestRender();
  }

  /** Remember the scene's own light, to come back to it. */
  private capture(): void {
    const u = this.app.viewer.cards.material.uniforms;
    const t = u.uTone!.value as Vector4;
    this.base = {
      light: {
        sunDir: (u.uSunDir!.value as Vector3).clone(),
        sunColor: (u.uSunColor!.value as Vector3).clone(),
        skyColor: (u.uSkyColor!.value as Vector3).clone(),
        glintColor: (u.uGlintColor!.value as Vector3).clone(),
        exposure: t.x, skyGain: t.y, ambient: t.z, hemi: t.w,
      },
      haze: (u.uHazeColor!.value as Vector3).clone(),
      bg: this.app.viewer.renderer.getClearColor(new Color()),
    };
  }

  private restore(): void {
    const c = this.app.viewer.cards;
    c.setFx(new Vector4(0, 0, 0, 0), new Vector4(0, 0, 0, 0), new Vector4(0, 0, 0, 0)); // (Vector4() has w = 1)
    c.setSkyTint(new Vector3(1, 1, 1), 0);
    c.setShadowMap(null);
    c.setShore(null);
    if (this.base) {
      c.setLighting(this.base.light);
      (c.material.uniforms.uHazeColor!.value as Vector3).copy(this.base.haze);
      this.app.viewer.setBackground(this.base.bg);
    }
  }

  /** The lighting every pane starts from: the scene's, or the time of day's. */
  private lightNow(): { light: Lighting; haze: Vector3; bg: Color; tint: Vector3 } {
    const b = this.base!;
    if (this.hour === null) return { light: b.light, haze: b.haze, bg: b.bg, tint: new Vector3(1, 1, 1) };
    const k = dayKey(this.hour);
    return {
      light: { ...b.light, sunDir: sunAt(this.hour), sunColor: k.sun, skyColor: k.sky, glintColor: k.sun.clone().multiplyScalar(0.8) },
      haze: k.haze,
      bg: new Color(k.bg.x, k.bg.y, k.bg.z),
      tint: k.tint,
    };
  }

  private uses(f: (p: PaneLook) => boolean): boolean {
    return this.panes.slice(0, this.paneCount).some(f);
  }

  private beforeDraw(): void {
    const app = this.app, v = app.viewer;
    if (!this.base) this.capture();
    const now = this.lightNow();
    // Lightning, for panes with the storm look.
    const t = v.clock;
    if (this.uses((p) => !!WEATHERS.find((w) => w.id === p.weather)?.storm)) {
      if (t > this.nextBolt + 30 || t < this.nextBolt - 30) this.nextBolt = t + 3;
      if (t >= this.nextBolt) {
        this.flash = 1;
        this.nextBolt = t + 4 + Math.random() * 8;
      }
      this.flash = Math.max(0, this.flash - 0.12);
    } else this.flash = 0;
    v.setBackground(now.bg);
    (v.cards.material.uniforms.uHazeColor!.value as Vector3).copy(now.haze);
    // Sun shadow map, once a frame, when a pane shows it.
    if (this.uses((p) => !!LIGHTS.find((l) => l.id === p.light)?.shadows)) {
      this.sun ??= new SunShadow(v.cards);
      v.cards.setLighting(now.light);
      this.sun.render(v.renderer, v.scene, v.camera, v.cards, now.light.sunDir, [v.overlay]);
    }
    // Shore map, when a pane shows the shore.
    if (app.map && this.uses((p) => !!WATERS.find((w) => w.id === p.water)?.shore)) {
      this.shore.update(app.map, v.camera.position.x, v.camera.position.z);
      v.cards.setShore(this.shore.texture, this.shore.box);
    }
  }

  private applyPane(i: number): void {
    const v = this.app.viewer, c = v.cards;
    const look = this.panes[i]!;
    const L = LIGHTS.find((x) => x.id === look.light) ?? LIGHTS[0]!;
    const W = WEATHERS.find((x) => x.id === look.weather) ?? WEATHERS[0]!;
    const R = WATERS.find((x) => x.id === look.water) ?? WATERS[0]!;
    const now = this.lightNow();
    const light = { ...now.light };
    const tint = now.tint.clone();
    if (W.storm) {
      light.sunColor = light.sunColor.clone().multiplyScalar(0.35);
      light.skyColor = light.skyColor.clone().multiplyScalar(0.7);
      tint.multiplyScalar(0.45);
    }
    c.setLighting(light);
    c.setSkyTint(tint, W.storm ? this.flash : 0);
    const ground = this.app.world?.info.ground ?? 0;
    c.setFx(
      new Vector4(L.shadows ? 1 : 0, L.shade, W.clouds ? 1 : 0, W.gusts ? 1 : 0),
      new Vector4(W.wet ? 1 : 0, W.mist ? 1 : 0, W.storm ? 1 : 0, ground),
      new Vector4(R.waves ? 1 : 0, R.shore ? 1 : 0, R.glints ? 1 : 0, R.rings ? 1 : 0),
    );
  }

  /** Lines of a terminal listing. */
  describe(): string[] {
    const out = [`look lab ${this.enabled ? 'on' : 'off'} · layout ${this.layout} · time ${this.hour === null ? 'scene light' : `${this.hour.toFixed(1)} h`}`];
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
};
