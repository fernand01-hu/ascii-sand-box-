// The product core: one viewer, one engine worker, and the logic that turns
// engine results into what's on screen. No debug or test code lives here.

import { Color, Vector3 } from 'three';
import { EngineClient, SupersededError } from '../engine/client';
import type { CardSettings, EngineResult, GalleryCategory, ScenePreset } from '../engine/protocol';
import { createGlyphAtlas, glyphAspect, type GlyphAtlas } from '../render/atlas';
import { CALM, DEFAULT_LIGHTING, SURFACE_MATERIAL, type Environment, type Lighting, type MaterialDef } from '../render/cards';
import { BACKGROUND } from '../render/viewer';
import { Player } from './player';
import { GridGround, type Ground } from './physics';
import { WorldStreamer } from './world';
import type { WalkData } from '../engine/protocol';

/** Lighting of the scenery `dusk` preset (light.py): stronger sky, no hemisphere falloff. */
export const SCENERY_LIGHTING: Omit<Lighting, 'sunDir'> = {
  sunColor: new Vector3(1.3, 0.92, 0.58),
  skyColor: new Vector3(0.46, 0.52, 0.8),
  glintColor: new Vector3(1.0, 0.86, 0.62),
  exposure: 3.0,
  skyGain: 0.95,
  ambient: 0.05,
  hemi: 0,
};

/** Lighting of the scenery `day` preset. */
export const SCENERY_DAY: Omit<Lighting, 'sunDir'> = {
  sunColor: new Vector3(1.15, 1.08, 0.95),
  skyColor: new Vector3(0.55, 0.68, 0.95),
  glintColor: new Vector3(1.0, 0.98, 0.92),
  exposure: 2.2,
  skyGain: 0.95,
  ambient: 0.05,
  hemi: 0,
};

const DUSK_BACKGROUND = BACKGROUND;
const DAY_BACKGROUND = new Color().setRGB(34 / 255, 44 / 255, 58 / 255, 'srgb');

/** Weather each scene starts with (wind, rain, blown leaves: 0..1). */
export const SCENE_WEATHER: Record<ScenePreset, { wind: number; rain: number; leaves: number }> = {
  meadow: { wind: 0.35, rain: 0, leaves: 0.5 },
  forest: { wind: 0.25, rain: 0, leaves: 0.7 },
  lake: { wind: 0.2, rain: 0, leaves: 0.3 },
  valley: { wind: 0.4, rain: 0, leaves: 0.4 },
  alpine: { wind: 0.6, rain: 0, leaves: 0.2 },
};

/** Engine material table (`floats` per material) -> shader material defs. */
export function materialsFromTable(t: Float32Array, floats = 12): MaterialDef[] {
  const out: MaterialDef[] = [];
  for (let i = 0; i + floats <= t.length; i += floats) {
    out.push({
      spec: t[i]!, shininess: t[i + 1]!, trans: t[i + 2]!, wrap: t[i + 3]!,
      billboard: (t[i + 4]! | 0) as 0 | 1 | 2, twist: t[i + 5]!, alphaLit: t[i + 6]!, haze: t[i + 7]!,
      flex: t[i + 8] ?? 0, flow: t[i + 9] ?? 0, fog: t[i + 10] ?? 0,
    });
  }
  return out;
}
import { Viewer } from '../render/viewer';

export const DEFAULT_CHARSET = ':-=+*xoO#%&8@BMW'; // light to dense, same as the engine's

export function defaultSettings(): CardSettings {
  return {
    seed: 7,
    glyphSize: 0.045,
    sizeFactor: 1.6,
    charset: DEFAULT_CHARSET,
    glyphRule: 'cells',
    patternScale: 0.22,
    glyphAspect: glyphAspect(),
    color: [0.78, 0.62, 0.45],
    colorJitter: 0.12,
    twist: 0.25,
    tilt: 0.15,
    alphaMin: 0.8,
    alphaMax: 1.0,
  };
}

export type Status = 'loading' | 'ready' | 'error';

export interface AppState {
  status: Status;
  model: string;
  triangles: number;
  dropped: number;
  cards: number;
  /** On-screen height of a glyph at the model's centre distance, in CSS px. */
  glyphPx: number;
  timings: EngineResult['timings'] | null;
  error: string | null;
  /** Requests the worker skipped because a newer one replaced them. */
  skipped: number;
  /** Current weather (wind, rain, blown leaves: 0..1). */
  weather: { wind: number; rain: number; leaves: number };
  /** Walking through the scene as a player (first person). */
  playing: boolean;
}

export class App {
  readonly viewer: Viewer;
  readonly engine = new EngineClient();
  readonly settings = defaultSettings();
  readonly state: AppState = {
    status: 'loading',
    model: '',
    triangles: 0,
    dropped: 0,
    cards: 0,
    glyphPx: 0,
    timings: null,
    error: null,
    skipped: 0,
    weather: { wind: 0, rain: 0, leaves: 0 },
    playing: false,
  };
  /** The player while in play mode. */
  player: Player | null = null;
  /** The infinite world while one is shown. */
  world: WorldStreamer | null = null;
  private walk: WalkData | null = null;
  private env: Environment = { ...CALM };
  private atlas: GlyphAtlas;
  // Only the most recent request may update the scene.
  private latest = 0;

  constructor(container: HTMLElement) {
    this.atlas = createGlyphAtlas(DEFAULT_CHARSET);
    this.viewer = new Viewer(container, this.atlas);
  }

  /** The glyph atlas for an engine-normalized charset (rebuilt only when it changes). */
  atlasFor(charset: string): GlyphAtlas {
    if (this.atlas.chars.join('') !== charset) {
      this.atlas.dispose();
      this.atlas = createGlyphAtlas(charset);
      this.atlas.texture.anisotropy = this.viewer.renderer.capabilities.getMaxAnisotropy();
    }
    return this.atlas;
  }

  /**
   * Run an engine request and, if it is still the latest when it finishes,
   * hand the result to `show`. Errors land in `state`; superseded requests
   * are counted and otherwise ignored.
   */
  async run(name: string, task: () => Promise<EngineResult>, show: (res: EngineResult) => void): Promise<void> {
    const token = ++this.latest;
    Object.assign(this.state, { status: 'loading', model: name, error: null });
    try {
      const res = await task();
      if (token !== this.latest) return;
      show(res);
      Object.assign(this.state, { status: 'ready', cards: res.count, timings: res.timings });
    } catch (err) {
      if (err instanceof SupersededError) {
        this.state.skipped++;
        return;
      }
      if (token !== this.latest) return;
      this.state.status = 'error';
      this.state.error = err instanceof Error ? err.message : String(err);
      console.warn(`[ascii] could not load ${name}: ${this.state.error}`);
    }
  }

  /**
   * Change the weather: any of wind, rain, leaves (0..1). Wind sways grass,
   * leaves, needles and reeds; rain falls round the camera and dims the sun;
   * leaves blow across the scene (they need some wind).
   */
  setEnvironment(w: Partial<{ wind: number; rain: number; leaves: number }>): void {
    const clamp = (v: number | undefined, d: number) => Math.min(1, Math.max(0, v ?? d));
    this.env.wind = clamp(w.wind, this.env.wind);
    this.env.rain = clamp(w.rain, this.env.rain);
    this.env.leaves = clamp(w.leaves, this.env.leaves);
    this.state.weather = { wind: this.env.wind, rain: this.env.rain, leaves: this.env.leaves };
    this.viewer.cards.setEnvironment(this.env);
    this.viewer.requestRender();
  }

  /**
   * Walk through the current landscape in first person: WASD / arrows,
   * Shift to run, Space to jump, mouse to look (click to capture it).
   * Gravity keeps you on the ground; trunks, rocks, steep slopes and the
   * lake stop you.
   */
  play(): boolean {
    if (this.player) return false;
    const ground: Ground | null = this.world ?? (this.walk ? new GridGround(this.walk) : null);
    if (!ground) return false;
    const v = this.viewer;
    const cam = v.camera;
    const t = v.controls.target;
    const yaw = Math.atan2(-(t.x - cam.position.x), -(t.z - cam.position.z));
    this.player = new Player(ground, { x: cam.position.x, z: cam.position.z, yaw }, v.renderer.domElement);
    v.controls.enabled = false;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
    this.player.placeCamera(cam);
    this.state.playing = true;
    this.updateFrameHook();
    v.requestRender();
    return true;
  }

  /** One per-frame callback: the player moves, the world streams round the camera. */
  private updateFrameHook(): void {
    const v = this.viewer;
    v.onFrame = this.player || this.world
      ? (dt) => {
          this.player?.update(dt, v.camera);
          this.world?.update(v.camera.position);
        }
      : null;
  }

  /** Back to orbiting, around a point in front of where the player stood. */
  stopPlaying(): void {
    const p = this.player;
    if (!p) return;
    const v = this.viewer;
    p.dispose();
    this.player = null;
    this.updateFrameHook();
    const cam = v.camera;
    const dir = cam.getWorldDirection(cam.position.clone());
    v.controls.target.copy(cam.position).addScaledVector(dir, 20);
    v.controls.enabled = true;
    cam.near = 0.2;
    cam.updateProjectionMatrix();
    v.controls.update();
    this.state.playing = false;
    v.requestRender();
  }

  /** Calm weather, no fog, default background. */
  resetEnvironment(animate: boolean, background = DUSK_BACKGROUND): void {
    this.env = { ...CALM };
    this.viewer.animate = animate;
    this.viewer.setBackground(background);
    this.setEnvironment({});
  }

  loadBytes(bytes: ArrayBuffer, name: string): Promise<void> {
    return this.run(name, () => this.engine.load(bytes, this.settings), (res) => {
      this.leaveScene();
      if (!res.mesh) throw new Error('engine returned no mesh');
      this.resetEnvironment(false);
      const v = this.viewer;
      v.cards.setAtlas(this.atlasFor(res.charset));
      v.cards.setMaterials([SURFACE_MATERIAL]);
      v.cards.setLighting(DEFAULT_LIGHTING);
      v.setMesh(res.mesh.positions, res.mesh.normals);
      v.setCards(res.cards, res.stride, res.chunks);
      Object.assign(this.state, {
        triangles: res.mesh.triangles,
        dropped: res.mesh.dropped,
        glyphPx: v.pixelsPerUnit() * this.settings.glyphSize,
      });
      console.info(
        `[ascii] ${name}: ${res.mesh.triangles} triangles (${res.mesh.dropped} dropped), ${res.count} cards, ` +
          `load ${res.timings.loadMs.toFixed(1)} ms, cards ${res.timings.generateMs.toFixed(1)} ms`,
      );
    });
  }

  /** A gallery sheet of procedural scenery assets (rocks, plants, bushes, trees). */
  showGallery(category: GalleryCategory, seed = 1): Promise<void> {
    const name = `gallery-${category}`;
    return this.run(name, () => this.engine.gallery(category, seed, glyphAspect()), (res) => {
      if (!res.camera || !res.materials || !res.sunDir || !res.mesh) throw new Error('gallery result is incomplete');
      this.leaveScene();
      this.resetEnvironment(false);
      const v = this.viewer;
      v.cards.setAtlas(this.atlasFor(res.charset));
      v.cards.setMaterials(materialsFromTable(res.materials, res.materialFloats));
      v.cards.setLighting({ ...SCENERY_LIGHTING, sunDir: new Vector3(...res.sunDir) });
      v.setCards(res.cards, res.stride, res.chunks);
      v.setFreeScene(new Vector3(...res.camera.target), new Vector3(...res.camera.eye), {
        fov: res.camera.fov,
        body: res.mesh.positions.length ? { positions: res.mesh.positions, normals: res.mesh.normals } : undefined,
      });
      Object.assign(this.state, { triangles: res.mesh.triangles, dropped: 0, glyphPx: 0 });
      console.info(`[ascii] ${name} seed ${seed}: ${res.count} cards, ${res.mesh.triangles} solid triangles, ${res.timings.generateMs.toFixed(0)} ms`);
    });
  }

  /**
   * A whole landscape: terrain with a lake, a stream and trails, scattered
   * trees / bushes / plants / rocks, sky, and animated weather.
   */
  showScene(preset: ScenePreset, seed = 1): Promise<void> {
    const name = `scene-${preset}`;
    return this.run(name, () => this.engine.scene(preset, seed, glyphAspect()), (res) => {
      if (!res.camera || !res.materials || !res.sunDir || !res.mesh || !res.env) throw new Error('scene result is incomplete');
      this.leaveScene();
      this.walk = res.walk ?? null;
      const day = res.env.day;
      this.resetEnvironment(true, day ? DAY_BACKGROUND : DUSK_BACKGROUND);
      const haze: [number, number, number] = day ? [176 / 255, 194 / 255, 214 / 255] : [74 / 255, 72 / 255, 104 / 255];
      Object.assign(this.env, {
        windDir: res.env.windDir, leafBox: res.env.leafBox, rainBox: res.env.rainBox,
        fogDist: 420, fog: 1, hazeColor: haze,
      });
      const v = this.viewer;
      v.cards.setAtlas(this.atlasFor(res.charset));
      v.cards.setMaterials(materialsFromTable(res.materials, res.materialFloats));
      v.cards.setLighting({ ...(day ? SCENERY_DAY : SCENERY_LIGHTING), sunDir: new Vector3(...res.sunDir) });
      v.setCards(res.cards, res.stride, res.chunks);
      v.setFreeScene(new Vector3(...res.camera.target), new Vector3(...res.camera.eye), {
        fov: res.camera.fov,
        far: 3000,
        body: { positions: res.mesh.positions, normals: res.mesh.normals },
      });
      this.setEnvironment(SCENE_WEATHER[preset]);
      Object.assign(this.state, { triangles: res.mesh.triangles, dropped: 0, glyphPx: 0 });
      console.info(`[ascii] ${name} seed ${seed}: ${res.count} cards, ${res.mesh.triangles} body triangles, ${res.timings.generateMs.toFixed(0)} ms`);
    });
  }

  /** Stop playing and forget the walkable world (a new scene replaces it). */
  leaveScene(): void {
    this.stopPlaying();
    this.walk = null;
    this.world?.dispose();
    this.world = null;
    this.viewer.clearBodies();
    this.updateFrameHook();
  }

  /**
   * An endless landscape streamed in chunks round the camera (or the player:
   * press P to walk). Terrain, lakes, streams, trails, biomes and plants go
   * on forever; detail follows you.
   */
  showWorld(seed = 1, day = false): Promise<void> {
    return this.run('world', () => this.engine.worldInit(seed, day, glyphAspect()), (res) => {
      if (!res.world || !res.materials || !res.sunDir || !res.env) throw new Error('world result is incomplete');
      this.leaveScene();
      this.resetEnvironment(true, day ? DAY_BACKGROUND : DUSK_BACKGROUND);
      const haze: [number, number, number] = day ? [176 / 255, 194 / 255, 214 / 255] : [74 / 255, 72 / 255, 104 / 255];
      // Haze thick enough that the edge of the loaded area melts away.
      Object.assign(this.env, { windDir: res.env.windDir, leafBox: res.env.leafBox, rainBox: res.env.rainBox, fogDist: 140, fog: 1, hazeColor: haze });
      const v = this.viewer;
      v.cards.setAtlas(this.atlasFor(res.charset));
      v.cards.setMaterials(materialsFromTable(res.materials, res.materialFloats));
      v.cards.setLighting({ ...(day ? SCENERY_DAY : SCENERY_LIGHTING), sunDir: new Vector3(...res.sunDir) });
      v.setCards(res.cards, res.stride, res.chunks); // sky, rain, leaves
      const [sx, sy, sz] = res.world.spawn;
      v.setFreeScene(new Vector3(sx, sy + 1, sz - 30), new Vector3(sx, sy + 7, sz), { fov: 50, far: 3000 });
      v.controls.maxDistance = 400;
      this.world = new WorldStreamer(this.engine, v, res.world, (e) => console.warn(`[ascii] world chunk failed: ${e instanceof Error ? e.message : String(e)}`));
      this.world.update(v.camera.position, true);
      this.updateFrameHook();
      this.setEnvironment({ wind: 0.3, rain: 0, leaves: 0.5 });
      Object.assign(this.state, { triangles: 0, dropped: 0, glyphPx: 0 });
      console.info(`[ascii] world seed ${seed}: streaming chunks of ${res.world.chunkSize} m round (${sx.toFixed(0)}, ${sz.toFixed(0)})`);
    });
  }

  async loadUrl(url: string, name = url.split('/').pop() ?? url): Promise<void> {
    let bytes: ArrayBuffer;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = await res.arrayBuffer();
    } catch (err) {
      ++this.latest; // a failed fetch still replaces whatever was loading
      Object.assign(this.state, {
        status: 'error',
        model: name,
        error: `could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`,
      });
      console.warn(`[ascii] ${this.state.error}`);
      return;
    }
    return this.loadBytes(bytes, name);
  }
}
