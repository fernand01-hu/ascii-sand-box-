// Developer tools: only loaded in dev and test builds (see main.ts), so none
// of this ships to the website.
//
//   (the terminal, debug overlays and F1-F4 are in every build: see main.ts)
//   keys 1-4      switch between the bundled test models
//   key 5         testbed: the procedural pine
//   keys 6-9      scenery galleries: rocks, plants, bushes, trees
//   C             back to the blank canvas (orbit / pan to travel)
//   W             wind: calm / breeze / storm
//   R             rain on / off
//   B             blowing leaves on / off
//   drop a file   load any .stl from your computer
//   window.__ascii  live engine state + hooks for the e2e test

import { GALLERY_CATEGORIES, type GalleryCategory } from '../engine/protocol';
import { showPine } from '../testbed/pine';
import type { App, AppState } from './app';
import { registerCommand } from './commands';
import type { Terminal } from '../ui/terminal';
import { panelOpen } from '../ui/widgets';
import type { MapData, NewObject, PlacedObject } from './map';
import { TEST_MODELS } from './models';

export interface DebugHandle extends AppState {
  loadBytes(bytes: ArrayBuffer, name: string): Promise<void>;
  loadModel(index: number): Promise<void>;
  loadPine(seed?: number): Promise<void>;
  loadGallery(category: GalleryCategory, seed?: number): Promise<void>;
  setEnvironment(w: Partial<{ wind: number; rain: number; leaves: number }>): void;
  /** Freeze the animation clock (seconds), or null to let it run. */
  freezeTime(t: number | null): void;
  loadCanvas(seed?: number, day?: boolean): Promise<void>;
  /**
   * Canvas stats: chunks loaded / in flight / built so far, rebuilds caused
   * by edits, chunks still waiting for one, chunks holding edits, objects.
   */
  worldStats(): { loaded: number; pending: number; built: number; editBuilds: number; viewBuilds: number; dirty: number; edited: number; objects: number } | null;
  /** Paint ground ("canvas", "grass", "sand", "water", "rock") until the brush exists. */
  paintRect(x0: number, z0: number, x1: number, z1: number, kind: string): string[];
  paintCircle(x: number, z: number, r: number, kind: string): string[];
  /** Place an object ("tree:oak", "rock:boulder", ...) until the brush exists. */
  addObject(o: NewObject): PlacedObject;
  removeObject(id: number): boolean;
  setViewRadius(chunks: number): void;
  stopPlaying(): void;
  /** Run a debug terminal command; resolves with the lines it printed. */
  run(line: string): Promise<string[]>;
  /** Apply a share link's hash (what opening the link would do). */
  applyLink(hash: string): Promise<boolean>;
  /** The editor's (snapped) ground point under the mouse. */
  cursorPoint(): { x: number; z: number } | null;
  /** The ground point under a screen position (CSS px). */
  groundAt(x: number, y: number): { x: number; z: number } | null;
  /** The app itself, for poking at it from the console (dev builds only). */
  app: App;
  /** Fraction of pixels that differ from the background. */
  coverage(): number;
  /** Glyphs per 16 px screen cell: mean, 95th percentile, max. */
  stacking(): { cells: number; mean: number; p95: number; max: number };
  thumbnail(): number[];
}

declare global {
  interface Window {
    __ascii: DebugHandle;
  }
}

export function installDevtools(app: App, terminal: Terminal): void {
  registerCommand({
    name: 'pine', group: 'scenes', usage: 'pine', help: 'the testbed pine (dev builds only)',
    async run(a, _x, io) {
      await showPine(a);
      io.print('testbed pine');
    },
  });
  const map = (): MapData => {
    if (!app.map) throw new Error('show the canvas first');
    return app.map;
  };
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
    setEnvironment: (w: Partial<{ wind: number; rain: number; leaves: number }>) => app.setEnvironment(w),
    freezeTime: (t: number | null) => app.viewer.freezeTime(t),
    loadCanvas: (seed?: number, day?: boolean) => app.showCanvas(seed, day),
    worldStats: () => (app.world
      ? {
        loaded: app.world.loadedCount, pending: app.world.pending, built: app.world.built, editBuilds: app.world.editBuilds, viewBuilds: app.world.viewBuilds,
        dirty: app.world.dirtyCount, edited: app.world.map.editedChunks, objects: app.world.map.objectCount,
      }
      : null),
    paintRect: (x0: number, z0: number, x1: number, z1: number, kind: string) => map().paintRect(x0, z0, x1, z1, kind),
    paintCircle: (x: number, z: number, r: number, kind: string) => map().paintCircle(x, z, r, kind),
    addObject: (o: NewObject) => map().addObject(o),
    removeObject: (id: number) => map().removeObject(id),
    setViewRadius: (n: number) => app.setViewRadius(n),
    stopPlaying: () => app.stopPlaying(),
    coverage: () => app.viewer.coverage(),
    stacking: () => app.viewer.stacking(),
    thumbnail: () => app.viewer.thumbnail(),
    run: (line: string) => terminal.run(line),
    applyLink: (hash: string) => terminal.ctx.settings.applyLink(hash, terminal.ctx.debug),
    cursorPoint: () => terminal.ctx.editor.point(),
    groundAt: (x: number, y: number) => terminal.ctx.cursor.groundAt(x, y),
  }) as DebugHandle;
  // Not enumerable, so JSON snapshots of the state skip it (it links back to the state).
  Object.defineProperty(window.__ascii, 'app', { value: app, enumerable: false });
  Object.defineProperty(window.__ascii, 'lab', { value: terminal.ctx.lab, enumerable: false });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Keys meant for a panel (menu, settings, terminal) or a text field are not hotkeys.
    if (panelOpen() || terminal.isOpen || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === '5') return void showPine(app);
    const k = e.key.toLowerCase();
    if (k === 'c') return void app.showCanvas();
    const w = app.state.weather;
    if (k === 'w') return app.setEnvironment({ wind: w.wind < 0.2 ? 0.35 : w.wind < 0.6 ? 0.85 : 0 });
    if (k === 'r') return app.setEnvironment({ rain: w.rain > 0 ? 0 : 1 });
    if (k === 'b') return app.setEnvironment({ leaves: w.leaves > 0 ? 0 : 0.8 });
    const g = GALLERY_CATEGORIES[Number(e.key) - 6];
    if (g) return void app.showGallery(g);
    const i = Number(e.key) - 1;
    if (Number.isInteger(i) && i >= 0 && i < TEST_MODELS.length) void loadModel(i);
  });

  // Drop an .stl to load it (scene files are handled by the scene store).
  window.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files[0];
    if (!file || !/\.stl$/i.test(file.name)) return;
    e.preventDefault();
    void file.arrayBuffer().then((b) => app.loadBytes(b, file.name));
  });
}
