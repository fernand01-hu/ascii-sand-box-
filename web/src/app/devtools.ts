// Developer tools: only loaded in dev and test builds (see main.ts), so none
// of this ships to the website.
//
//   keys 1-4      switch between the bundled test models
//   key 5         testbed: the procedural pine
//   keys 6-9      scenery galleries: rocks, plants, bushes, trees
//   drop a file   load any .stl from your computer
//   window.__ascii  live engine state + hooks for the e2e test

import { GALLERY_CATEGORIES, type GalleryCategory } from '../engine/protocol';
import { showPine } from '../testbed/pine';
import type { App, AppState } from './app';

export const TEST_MODELS = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];

export interface DebugHandle extends AppState {
  loadBytes(bytes: ArrayBuffer, name: string): Promise<void>;
  loadModel(index: number): Promise<void>;
  loadPine(seed?: number): Promise<void>;
  loadGallery(category: GalleryCategory, seed?: number): Promise<void>;
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
    coverage: () => app.viewer.coverage(),
    thumbnail: () => app.viewer.thumbnail(),
  });

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '5') return void showPine(app);
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
