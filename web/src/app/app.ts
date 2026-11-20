// The product core: one viewer, one engine worker, and the logic that turns
// engine results into what's on screen. No debug or test code lives here.

import { Color, Vector3 } from 'three';
import { EngineClient, SupersededError } from '../engine/client';
import type { CardSettings, EngineResult, GalleryCategory } from '../engine/protocol';
import { createGlyphAtlas, glyphAspect, type GlyphAtlas } from '../render/atlas';
import { CALM, DEFAULT_LIGHTING, SURFACE_MATERIAL, type Environment, type Lighting, type MaterialDef } from '../render/cards';
import { BACKGROUND } from '../render/viewer';
import { Player } from './player';
import { MapData, OBJECT_FLOATS } from './map';
import { WorldStreamer } from './world';

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
  /** The canvas world while it is shown. */
  world: WorldStreamer | null = null;
  /**
   * Everything painted and placed on the canvas. Created with the first
   * canvas and kept for the whole session, so edits survive a trip to a
   * gallery or a model and back.
   */
  map: MapData | null = null;
  /** How many chunks round the camera are shown (see `setViewRadius`). */
  viewRadius = 9;
  /** Seed and time of day of the last canvas shown. */
  canvasOptions = { seed: 1, day: false };
  /** The canvas's weather: kept when you leave the canvas and come back. */
  canvasWeather = { wind: 0.3, rain: 0, leaves: 0.5 };
  private env: Environment = { ...CALM };
  private atlas: GlyphAtlas;
  // Only the most recent request may update the scene.
  private latest = 0;
  private sceneListeners = new Set<(name: string) => void>();

  /** Called after a new scene is on screen (canvas, gallery, model) with its name. */
  onSceneChange(f: (name: string) => void): () => void {
    this.sceneListeners.add(f);
    return () => this.sceneListeners.delete(f);
  }

  constructor(container: HTMLElement) {
    this.atlas = createGlyphAtlas(DEFAULT_CHARSET);
    this.viewer = new Viewer(container, this.atlas);
  }

  /** The characters glyph indices refer to right now (glyph inspector). */
  get charset(): readonly string[] {
    return this.atlas.chars;
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
      for (const f of this.sceneListeners) f(name);
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
    if (this.world) this.canvasWeather = { ...this.state.weather };
    this.viewer.cards.setEnvironment(this.env);
    this.viewer.requestRender();
  }

  /**
   * Walk the canvas in first person: WASD / arrows, Shift to run, Space to
   * jump, mouse to look (click to capture it). On hold until play mode
   * (TODO.md, Phase 4): nothing calls it from the UI for now.
   */
  play(): boolean {
    if (this.player) return false;
    const ground = this.world;
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

  /** Stop playing and forget the canvas world (a new scene replaces it). */
  leaveScene(): void {
    this.stopPlaying();
    this.world?.dispose();
    this.world = null;
    this.viewer.clearBodies();
    this.updateFrameHook();
  }

  /**
   * The blank canvas: an endless flat map of '#' rows streamed in chunks
   * round the camera, under the sky and the weather. Detail follows you.
   */
  showCanvas(seed = 1, day = false): Promise<void> {
    this.canvasOptions = { seed, day };
    return this.run('canvas', () => this.engine.worldInit(seed, day, glyphAspect()), (res) => {
      if (!res.world || !res.materials || !res.sunDir || !res.env) throw new Error('world result is incomplete');
      this.leaveScene();
      this.resetEnvironment(true, day ? DAY_BACKGROUND : DUSK_BACKGROUND);
      const haze: [number, number, number] = day ? [176 / 255, 194 / 255, 214 / 255] : [74 / 255, 72 / 255, 104 / 255];
      // Haze thick enough that the edge of the loaded area melts away.
      Object.assign(this.env, { windDir: res.env.windDir, leafBox: res.env.leafBox, rainBox: res.env.rainBox, fogDist: this.hazeDistance(), fog: 1, hazeColor: haze });
      const v = this.viewer;
      v.cards.setAtlas(this.atlasFor(res.charset));
      v.cards.setMaterials(materialsFromTable(res.materials, res.materialFloats));
      v.cards.setLighting({ ...(day ? SCENERY_DAY : SCENERY_LIGHTING), sunDir: new Vector3(...res.sunDir) });
      v.setCards(res.cards, res.stride, res.chunks); // sky, rain, leaves
      const [sx, sy, sz] = res.world.spawn;
      v.setFreeScene(new Vector3(sx, sy + 1, sz - 30), new Vector3(sx, sy + 7, sz), { fov: 50, far: 3000 });
      v.controls.maxDistance = 400;
      const w = res.world;
      if (w.objectFloats !== OBJECT_FLOATS) console.error(`[ascii] engine and web disagree on object records (${w.objectFloats} vs ${OBJECT_FLOATS} floats)`);
      const objectParams = Object.fromEntries(w.objectKinds.map((k, i) => [k, w.objectParams[i] ?? []]));
      this.map ??= new MapData({ chunkSize: w.chunkSize, tile: w.tile, tiles: w.tiles, groundKinds: w.groundKinds, objectKinds: w.objectKinds, objectParams });
      this.world = new WorldStreamer(this.engine, v, res.world, this.map, (e) => console.warn(`[ascii] canvas chunk failed: ${e instanceof Error ? e.message : String(e)}`));
      this.world.radius = this.viewRadius;
      this.world.update(v.camera.position, true);
      this.updateFrameHook();
      this.setEnvironment({ ...this.canvasWeather });
      Object.assign(this.state, { triangles: 0, dropped: 0, glyphPx: 0 });
      console.info(`[ascii] canvas seed ${seed}: streaming chunks of ${res.world.chunkSize} m round (${sx.toFixed(0)}, ${sz.toFixed(0)})`);
    });
  }

  /**
   * View distance in chunks (1-16). Beyond it the canvas fades into the
   * haze; fewer chunks draw fewer characters (cheaper without a GPU).
   */
  setViewRadius(chunks: number): void {
    this.viewRadius = Math.min(16, Math.max(1, Math.round(chunks)));
    if (this.world) {
      this.env.fogDist = this.hazeDistance();
      this.setEnvironment({});
      this.world.radius = this.viewRadius;
      this.world.update(this.viewer.camera.position, true);
    }
  }

  /** Haze thick enough that the edge of the shown chunks melts away (140 m at 9 chunks). */
  private hazeDistance(): number {
    return (140 / 9) * this.viewRadius;
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
