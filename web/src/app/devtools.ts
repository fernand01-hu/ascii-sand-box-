// Developer tools: only loaded in dev and test builds (see main.ts), so none
// of this ships to the website.
//
//   keys 1-4      switch between the bundled test models
//   key 5         testbed: the procedural pine
//   keys 6-9      scenery galleries: rocks, plants, bushes, trees
//   M F L V A     landscapes: meadow, forest, lake, valley, alpine
//   W             wind: calm / breeze / storm
//   R             rain on / off
//   B             blowing leaves on / off
//   P             play: walk the landscape (WASD, Shift, Space, mouse); P again to stop
//   drop a file   load any .stl from your computer
//   window.__ascii  live engine state + hooks for the e2e test

import { GALLERY_CATEGORIES, type GalleryCategory, type ScenePreset } from '../engine/protocol';
import { showPine } from '../testbed/pine';
import type { App, AppState } from './app';

export const TEST_MODELS = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];

export interface DebugHandle extends AppState {
  loadBytes(bytes: ArrayBuffer, name: string): Promise<void>;
  loadModel(index: number): Promise<void>;
  loadPine(seed?: number): Promise<void>;
  loadGallery(category: GalleryCategory, seed?: number): Promise<void>;
  loadScene(preset: ScenePreset, seed?: number): Promise<void>;
  setEnvironment(w: Partial<{ wind: number; rain: number; leaves: number }>): void;
  /** Freeze the animation clock (seconds), or null to let it run. */
  freezeTime(t: number | null): void;
  play(): boolean;
  stopPlaying(): void;
  /**
   * Test hook: run the player physics for `seconds` with fixed input, in
   * fixed steps; returns the lowest clearance over the ground seen, whether
   * the player ever stood in water, and the final state.
   */
  playSteps(input: { forward?: number; right?: number; run?: boolean; jump?: boolean; yaw?: number }, seconds: number):
    { minClearance: number; inWater: boolean; x: number; y: number; z: number; moved: number } | null;
  /** The app itself, for poking at it from the console (dev builds only). */
  app: App;
  /** Fraction of pixels that differ from the background. */
  coverage(): number;
  thumbnail(): number[];
}

declare global {
  interface Window {
    __ascii: DebugHandle;
  }
}

export function installDevtools(app: App): void {
  const loadModel = (i: number) => {
    const name = TEST_MODELS[i];
    return name ? app.loadUrl(`${import.meta.env.BASE_URL}models/${name}`, name) : Promise.resolve();
  };

  // The state object itself, so the e2e test always sees live values.
  window.__ascii = Object.assign(app.state, {
    loadBytes: (b: ArrayBuffer, name: string) => app.loadBytes(b, name),
    loadModel,
    loadPine: (seed?: number) => showPine(app, seed),
    loadGallery: (c: GalleryCategory, seed?: number) => app.showGallery(c, seed),
    loadScene: (p: ScenePreset, seed?: number) => app.showScene(p, seed),
    setEnvironment: (w: Partial<{ wind: number; rain: number; leaves: number }>) => app.setEnvironment(w),
    freezeTime: (t: number | null) => app.viewer.freezeTime(t),
    play: () => app.play(),
    stopPlaying: () => app.stopPlaying(),
    playSteps: (input: Parameters<DebugHandle['playSteps']>[0], seconds: number) => {
      const p = app.player;
      if (!p) return null;
      const s = p.state;
      if (input.yaw !== undefined) s.yaw = input.yaw;
      const inp = { forward: input.forward ?? 0, right: input.right ?? 0, run: input.run ?? false, jump: input.jump ?? false };
      const x0 = s.x, z0 = s.z;
      let minClearance = Infinity;
      let inWater = false;
      const steps = Math.round(seconds * 120);
      for (let i = 0; i < steps; i++) {
        p.physics.step(s, inp, 1 / 120);
        minClearance = Math.min(minClearance, s.y - p.physics.height(s.x, s.z));
        inWater ||= p.physics.isWater(s.x, s.z);
      }
      p.placeCamera(app.viewer.camera);
      app.viewer.requestRender();
      return { minClearance, inWater, x: s.x, y: s.y, z: s.z, moved: Math.hypot(s.x - x0, s.z - z0) };
    },
    coverage: () => app.viewer.coverage(),
    thumbnail: () => app.viewer.thumbnail(),
  }) as DebugHandle;
  // Not enumerable, so JSON snapshots of the state skip it (it links back to the state).
  Object.defineProperty(window.__ascii, 'app', { value: app, enumerable: false });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key.toLowerCase() === 'p') return void (app.state.playing ? app.stopPlaying() : app.play());
    if (app.state.playing) return; // WASD etc. belong to the player
    if (e.key === '5') return void showPine(app);
    const scenes: Record<string, ScenePreset> = { m: 'meadow', f: 'forest', l: 'lake', v: 'valley', a: 'alpine' };
    const k = e.key.toLowerCase();
    if (scenes[k]) return void app.showScene(scenes[k]);
    const w = app.state.weather;
    if (k === 'w') return app.setEnvironment({ wind: w.wind < 0.2 ? 0.35 : w.wind < 0.6 ? 0.85 : 0 });
    if (k === 'r') return app.setEnvironment({ rain: w.rain > 0 ? 0 : 1 });
    if (k === 'b') return app.setEnvironment({ leaves: w.leaves > 0 ? 0 : 0.8 });
    const g = GALLERY_CATEGORIES[Number(e.key) - 6];
    if (g) return void app.showGallery(g);
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < TEST_MODELS.length) void loadModel(i);
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) void file.arrayBuffer().then((b) => app.loadBytes(b, file.name));
  });
}
