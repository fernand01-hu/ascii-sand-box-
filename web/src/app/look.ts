// The look engine (Phase 3, steps 13-15): how the canvas is lit and how its
// weather and water behave, every frame. Picked in the look lab:
//   lighting  live sun shadows (a shadow map from the sun: shadows cross
//             chunk borders, fall from hills, follow the sun and edits),
//             and a time of day (the sun's path, its colour, the sky);
//   weather   gust waves through the grass, faint fast cloud shadows,
//             wet ground and splashes in the rain, a storm with lightning;
//   water     waves that follow the current (rivers downhill along their
//             bed, still lakes rippling in the wind), shallow / deep
//             colour, foam where waves break, sky reflection and sun
//             glitter, rain rings.
// Each feature is a setting (`set`, the settings panel, `style ...`), all on
// by default; `style classic` turns them all off (the look before Phase 3).
// The look lab draws panes with other features through `apply`.

import { Color, Vector3, Vector4 } from 'three';
import { glyphAspect } from '../render/atlas';
import { CARD_STRIDE, type Lighting } from '../render/cards';
import { DebugDraw, Lines } from '../render/debugdraw';
import { SunShadow } from '../render/sunshadow';
import type { App } from './app';
import type { MapData } from './map';
import type { Settings } from './settings';
import { MAX_SPEED, ShoreMap } from './shoremap';
import { TreeMap } from './treemap';

/** What a view shows; the look lab gives each pane its own. */
export interface Features {
  /** Sun from the live shadow map (else the shadows baked into each chunk). */
  shadows: boolean;
  gusts: boolean;
  clouds: boolean;
  wet: boolean;
  storm: boolean;
  waves: boolean;
  shore: boolean;
  glints: boolean;
  rings: boolean;
  /** Blown leaves only near trees (else everywhere round the camera). */
  treeLeaves: boolean;
}

export const STANDARD: Features = {
  shadows: true, gusts: true, clouds: true, wet: true, storm: false,
  waves: true, shore: true, glints: true, rings: true, treeLeaves: true,
};
export const CLASSIC: Features = {
  shadows: false, gusts: false, clouds: false, wet: false, storm: false,
  waves: false, shore: false, glints: false, rings: false, treeLeaves: false,
};

/** The on / off features that are settings, with their help. */
const SWITCHES: [keyof Features, string][] = [
  ['shadows', 'live sun shadows (off: shadows baked into each chunk)'],
  ['gusts', 'gust waves rolling through the grass'],
  ['clouds', 'faint cloud shadows drifting with the wind'],
  ['wet', 'rain wets the ground: darker, a sheen, splashes'],
  ['storm', 'storm: dark sky and lightning'],
  ['waves', 'water waves that follow the current'],
  ['shore', 'shallow / deep water colour, foam where waves break'],
  ['glints', 'sky reflected on the water, sun glitter'],
  ['rings', 'rain rings on the water'],
  ['treeLeaves', 'blown leaves come from the trees'],
];

/** Light at an hour of the day: sun (or moon) colour, sky, haze, background, sky-dome tint. */
const DAY_KEYS: [number, number[], number[], number[], number[], number[]][] = [
  // hour, sun, sky, haze, background (screen colours), sky tint
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

/** Sun direction at an hour: rises in the east (+x) at 6, highest at 13, sets in the west at 20; the moon at night. */
export function sunAt(hour: number): Vector3 {
  const h = ((hour % 24) + 24) % 24;
  const day = h >= 6 && h <= 20;
  const t = day ? (h - 6) / 14 : ((h + 4) % 24) / 10;
  const az = Math.PI * t;
  const el = Math.max(0.06, Math.sin(Math.PI * t)) * (day ? 1.05 : 0.8);
  return new Vector3(Math.cos(az) * Math.cos(el), Math.sin(el), -0.35 - Math.sin(az) * Math.cos(el) * 0.6).normalize();
}

/** Card set of the lightning bolt. */
const BOLT = 'look-bolt';

export class Look {
  /** The features of the normal view (settings). */
  readonly features: Features = { ...STANDARD };
  /** Time of day (hours), or null for the scene's own light. */
  hour: number | null = null;
  /** Panes with their own features (the look lab), else null: one view with `features`. */
  panes: Features[] | null = null;
  /** Debug arrows for the water's current. */
  arrows = false;
  /** Side of the sun shadow map in texels (quality presets). */
  shadowSize = 2048;
  private sun: SunShadow | null = null;
  private sunKey = '';
  readonly shore = new ShoreMap();
  private trees = new TreeMap();
  private base: { light: Lighting; haze: Vector3; bg: Color } | null = null;
  private watched: MapData | null = null;
  private arrowDraw: DebugDraw | null = null;
  private arrowRev = -1;
  private flash = 0;
  private dark = 0;
  private nextStrike = 0;
  private strike: { t: number; near: boolean; pulses: number[]; bolt: boolean } | null = null;
  private active = false;
  private listeners = new Set<() => void>();

  constructor(private app: App, settings: Settings) {
    settings.add(
      ...SWITCHES.map(([k, help]) => ({
        name: k === 'treeLeaves' ? 'treeleaves' : k, help, persist: true,
        get: () => (this.features[k] ? 'on' : 'off'),
        set: (v: string) => {
          if (v !== 'on' && v !== 'off') throw new Error(`${k}: on or off`);
          this.set({ [k]: v === 'on' });
        },
      })),
      {
        name: 'daytime', help: 'time of day in hours (0-24), or "scene" for the scene\'s own light', persist: true,
        get: () => (this.hour === null ? 'scene' : String(this.hour)),
        set: (v: string) => {
          if (v === 'scene') return this.setHour(null);
          const h = Number(v);
          if (!Number.isFinite(h) || h < 0 || h > 24) throw new Error('daytime: 0-24 or scene');
          this.setHour(h);
        },
      },
    );
    app.onSceneChange(() => {
      const m = app.map;
      if (m && m !== this.watched) {
        this.watched = m;
        m.onEdit((e) => {
          if (e.tiles?.length || e.heights?.length) this.shore.invalidate();
          if (e.added?.length || e.removed?.length) this.trees.invalidate();
        });
      }
      this.shore.invalidate();
      this.trees.invalidate();
      this.base = null; // a new scene brings its own light
      this.sunKey = '';
      this.refresh();
    });
  }

  onChange(f: () => void): void {
    this.listeners.add(f);
  }

  set(f: Partial<Features>): void {
    Object.assign(this.features, f);
    this.changed();
  }

  setHour(h: number | null): void {
    this.hour = h === null ? null : ((h % 24) + 24) % 24;
    this.changed();
  }

  private changed(): void {
    this.sunKey = '';
    this.refresh();
    for (const f of this.listeners) f();
  }

  /** Hook the look into the viewer while the canvas is up; put the scene's own light back otherwise. */
  refresh(): void {
    const v = this.app.viewer;
    const on = !!this.app.world;
    if (on) {
      if (!this.active) {
        this.capture();
        this.active = true;
      }
      v.beforeDraw = () => this.beforeDraw();
      v.requestRender();
      return;
    }
    if (this.active) {
      this.restore();
      this.active = false;
    }
    if (v.beforeDraw) v.beforeDraw = null;
    this.arrowDraw?.set('tiles', null);
    this.arrowRev = -1;
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
    c.setTrees(null);
    if (this.strike?.bolt) c.removeSet(BOLT);
    this.strike = null;
    if (this.base) {
      c.setLighting(this.base.light);
      (c.material.uniforms.uHazeColor!.value as Vector3).copy(this.base.haze);
      this.app.viewer.setBackground(this.base.bg);
    }
  }

  /** The lighting the views start from: the scene's, or the time of day's. */
  private lightNow(): { light: Lighting; haze: Vector3; bg: Color; tint: Vector3 } {
    if (!this.base) this.capture();
    const b = this.base!;
    if (this.hour === null) return { light: b.light, haze: b.haze, bg: b.bg, tint: new Vector3(1, 1, 1) };
    const k = dayKey(this.hour);
    return {
      light: { ...b.light, sunDir: sunAt(this.hour), sunColor: k.sun, skyColor: k.sky, glintColor: k.sun.clone().multiplyScalar(0.8) },
      haze: k.haze,
      bg: new Color().setRGB(k.bg.x, k.bg.y, k.bg.z, 'srgb'), // the keys are screen colours, not linear
      tint: k.tint,
    };
  }

  private views(): Features[] {
    return this.panes ?? [this.features];
  }

  private uses(f: (x: Features) => boolean): boolean {
    return this.views().some(f);
  }

  /** Once a frame, before the views are drawn. */
  private beforeDraw(): void {
    const app = this.app, v = app.viewer;
    const now = this.lightNow();
    this.lightning(v.clock);
    v.setBackground(now.bg);
    (v.cards.material.uniforms.uHazeColor!.value as Vector3).copy(now.haze);
    // Sun shadow map: redrawn only when the camera, the sun or the cards changed.
    if (this.uses((x) => x.shadows)) {
      if (this.sun && this.sun.size !== this.shadowSize) {
        this.sun.dispose();
        this.sun = null;
      }
      this.sun ??= new SunShadow(v.cards, this.shadowSize);
      const p = v.camera.position, d = v.camera.getWorldDirection(new Vector3());
      const key = [Math.round(p.x / 2), Math.round(p.z / 2), Math.round(d.x * 8), Math.round(d.z * 8), now.light.sunDir.toArray().map((x) => x.toFixed(3)).join(), v.cards.revision].join('|');
      v.cards.setLighting(now.light);
      if (key !== this.sunKey) {
        this.sunKey = key;
        this.sun.render(v.renderer, v.scene, v.camera, v.cards, now.light.sunDir, [v.overlay]);
      } else this.sun.bind(v.cards);
    }
    // Water map (shore, current) when a view shows the water's look, or the arrows are on.
    if (app.map && (this.arrows || this.uses((x) => x.waves || x.shore))) {
      this.shore.update(app.map, v.camera.position.x, v.camera.position.z);
      v.cards.setShore(this.shore.texture, this.shore.box);
      if (this.arrows && this.arrowRev !== this.shore.revision) this.drawArrows();
    }
    if (app.map && this.uses((x) => x.treeLeaves)) {
      this.trees.update(app.map, v.camera.position.x, v.camera.position.z);
      v.cards.setTrees(this.trees.texture, this.trees.box);
    }
    if (!this.panes) this.apply(this.features);
  }

  /** Set the uniforms for a view with these features (once per pane in the look lab). */
  apply(f: Features): void {
    const c = this.app.viewer.cards;
    const now = this.lightNow();
    const light = { ...now.light };
    const tint = now.tint.clone();
    if (f.storm) {
      // A storm: dark, and darker still just after a strike.
      const k = 1 - 0.45 * this.dark;
      light.sunColor = light.sunColor.clone().multiplyScalar(0.35 * k);
      light.skyColor = light.skyColor.clone().multiplyScalar(0.7 * k);
      tint.multiplyScalar(0.45 * k);
    }
    c.setLighting(light);
    c.setSkyTint(tint, f.storm ? this.flash : 0);
    c.setSetVisible(BOLT, f.storm && this.flash > 0.25);
    const ground = this.app.world?.info.ground ?? 0;
    c.setFx(
      new Vector4(f.shadows ? 1 : 0, 0, f.clouds ? 1 : 0, f.gusts ? 1 : 0),
      new Vector4(f.wet ? 1 : 0, 0, f.storm ? 1 : 0, ground),
      new Vector4(f.waves ? 1 : 0, f.shore ? 1 : 0, f.glints ? 1 : 0, f.rings ? 1 : 0),
    );
    c.setTreeLeaves(f.treeLeaves);
  }

  /**
   * Lightning in views with the storm. Strikes every 4-13 s; each strobes
   * 2-3 times within a quarter second, then glows out, then the storm seems
   * darker for a moment. One in three is close: blinding, with a jagged bolt
   * of glyphs across the sky; the rest are far, dim flashes.
   */
  private lightning(t: number): void {
    const v = this.app.viewer;
    if (!this.uses((x) => x.storm)) {
      this.flash = this.dark = 0;
      if (this.strike?.bolt) v.cards.removeSet(BOLT);
      this.strike = null;
      return;
    }
    if (Math.abs(t - this.nextStrike) > 60) this.nextStrike = t + 2; // the clock jumped
    if (t >= this.nextStrike) {
      const near = Math.random() < 0.35;
      const pulses = [0, 0.07 + Math.random() * 0.06];
      if (Math.random() < 0.6) pulses.push(0.18 + Math.random() * 0.1);
      this.startStrike(t, near, pulses);
      this.nextStrike = t + 4 + Math.random() * 9;
    }
    const s = this.strike;
    const dt = s ? t - s.t : Infinity;
    let f = 0;
    if (s && dt >= 0 && dt < 2) {
      for (const p of s.pulses) if (dt >= p) f = Math.max(f, Math.exp(-(dt - p) / 0.045));
      f = Math.max(f, 0.3 * Math.exp(-dt / 0.35));
      f *= s.near ? 1.7 : 0.5;
    }
    this.flash = f;
    this.dark = s && dt > 0.3 && dt < 2 ? Math.sin(Math.min(1, (dt - 0.3) / 1.5) * Math.PI) * (s.near ? 1 : 0.5) : 0;
    if (s?.bolt && dt > 0.5) {
      v.cards.removeSet(BOLT);
      s.bolt = false;
    }
  }

  private startStrike(t: number, near: boolean, pulses: number[]): void {
    const v = this.app.viewer;
    if (this.strike?.bolt) v.cards.removeSet(BOLT);
    this.strike = { t, near, pulses, bolt: near };
    if (near) v.cards.addSet(BOLT, this.boltCards(), CARD_STRIDE);
  }

  /** Strike now: `near` gives the blinding kind with a bolt. */
  strikeNow(near = true): void {
    const t = this.app.viewer.clock;
    this.startStrike(t, near, [0, 0.09, 0.22]);
    this.nextStrike = t + 6;
  }

  /** A jagged bolt of / \\ | glyphs from the clouds to the ground, ahead of the camera, with a fork or two. */
  private boltCards(): Float32Array {
    const cam = this.app.viewer.camera, chars = this.app.charset;
    const slot = (c: string) => Math.max(0, chars.indexOf(c)) + 1024 * (0 + 64 * 4); // material 0, mode 4: emissive, follows the camera
    const fwd = cam.getWorldDirection(new Vector3()).setY(0).normalize();
    const dir = fwd.clone().applyAxisAngle(new Vector3(0, 1, 0), (Math.random() - 0.5) * 0.7);
    const dist = 170 + Math.random() * 110;
    const ground = (this.app.world?.info.ground ?? 0) - cam.position.y;
    const right = new Vector3().crossVectors(dir, new Vector3(0, 1, 0)).normalize();
    const size = dist * 0.05, aspect = glyphAspect();
    const out: number[] = [];
    const push = (p: Vector3, ch: string, bright: number, scale = 1, depth = 0) => {
      const s = size * scale, U = right.clone().multiplyScalar(s * aspect);
      const q = p.clone().addScaledVector(dir, depth); // the halo sits just behind the bolt
      out.push(q.x, q.y, q.z, U.x, U.y, U.z, 0, s, 0, 3.2 * bright, 3.3 * bright, 4 * bright, Math.min(1, bright), slot(ch), 1, 1);
    };
    const path = (start: Vector3, steps: number, bright: number, fork: boolean) => {
      let p = start.clone();
      for (let i = 0; i < steps && p.y > ground; i++) {
        const side = (Math.random() - 0.5) * size * 2.4;
        const next = p.clone().addScaledVector(right, side).add(new Vector3(0, -size * (0.9 + 0.6 * Math.random()), 0));
        const ch = Math.abs(side) < size * 0.35 ? '|' : side > 0 ? '/' : '\\';
        // Each glyph twice, side by side: a thicker stroke than the font's.
        for (let k = 0; k < 3; k++) {
          const q = p.clone().lerp(next, (k + 0.5) / 3);
          push(q, ch, bright);
          push(q.clone().addScaledVector(right, size * 0.12), ch, bright);
        }
        // A faint glow round it.
        push(p.clone().lerp(next, 0.5), '*', bright * 0.22, 2.2, 3);
        if (fork && i > 2 && Math.random() < 0.18) path(next, 3 + Math.floor(Math.random() * 4), bright * 0.6, false);
        p = next;
      }
    };
    path(dir.clone().multiplyScalar(dist).setY(dist * 0.4), 60, 1, true);
    return new Float32Array(out);
  }

  /** Show or hide arrows for the water's current (debug). */
  setArrows(on: boolean): void {
    this.arrows = on;
    this.arrowRev = -1;
    if (!on) this.arrowDraw?.set('tiles', null);
    this.app.viewer.requestRender();
    for (const f of this.listeners) f();
  }

  private drawArrows(): void {
    const sm = this.shore, map = this.app.map, w = this.app.world;
    if (!map || !w) return;
    this.arrowRev = sm.revision;
    this.arrowDraw ??= new DebugDraw(this.app.viewer.overlay);
    const l = new Lines(), N = sm.size, g = w.info.ground, x0 = sm.box.x, z0 = sm.box.y;
    for (let j = 1; j < N; j += 2) {
      for (let i = 1; i < N; i += 2) {
        const k = j * N + i;
        if (!sm.water[k]) continue;
        const x = x0 + i + 0.5, z = z0 + j + 0.5, y = g + map.heightAt(x, z) + 0.35;
        const fx = sm.flow[k * 2]!, fz = sm.flow[k * 2 + 1]!, s = Math.hypot(fx, fz);
        if (s < 0.08) {
          l.seg(x - 0.1, y, z, x + 0.1, y, z, [0.35, 0.5, 0.9]); // still water: a dot
          continue;
        }
        const t = Math.min(1, s / MAX_SPEED), c: [number, number, number] = [0.4 + 0.6 * t, 0.9 - 0.4 * t, 0.3];
        const len = 0.6 + 1.0 * t, dx = (fx / s) * len, dz = (fz / s) * len;
        const ex = x + dx, ez = z + dz;
        l.seg(x, y, z, ex, y, ez, c);
        l.seg(ex, y, ez, ex - dx * 0.4 - dz * 0.3, y, ez - dz * 0.4 + dx * 0.3, c);
        l.seg(ex, y, ez, ex - dx * 0.4 + dz * 0.3, y, ez - dz * 0.4 - dx * 0.3, c);
      }
    }
    this.arrowDraw.set('tiles', l);
  }

  /** Lines of a terminal listing. */
  describe(): string[] {
    const f = this.features;
    return [
      `time of day ${this.hour === null ? 'scene light' : `${this.hour.toFixed(2)} h`}`,
      `lighting   shadows ${f.shadows ? 'on' : 'off'}`,
      `weather    gusts ${f.gusts ? 'on' : 'off'} · clouds ${f.clouds ? 'on' : 'off'} · wet ${f.wet ? 'on' : 'off'} · storm ${f.storm ? 'on' : 'off'} · leaves from trees ${f.treeLeaves ? 'on' : 'off'}`,
      `water      waves ${f.waves ? 'on' : 'off'} · shore ${f.shore ? 'on' : 'off'} · glints ${f.glints ? 'on' : 'off'} · rings ${f.rings ? 'on' : 'off'}`,
    ];
  }
}

/** For the look lab's panes: shared by the lab and its panel. */
export { SWITCHES };
