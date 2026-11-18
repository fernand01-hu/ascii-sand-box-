// Entry point: wires the engine worker to the viewer. No UI yet: drag with the
// mouse to orbit, wheel to zoom, right-drag to pan.
//
// Developer shortcuts (temporary, for checking the engine):
//   keys 1-4      switch between the bundled test models
//   drop a file   load any .stl from your computer

import { EngineClient } from './engine/client';
import type { CardSettings, EngineResult } from './engine/protocol';
import { createGlyphAtlas } from './render/atlas';
import { Viewer } from './render/viewer';

const MODELS = ['torus-knot.stl', 'sphere.stl', 'ziggurat.stl', 'pine.stl'];
const CHARSET = '@#%&8$*+=xoXOBMW';

type Status = 'loading' | 'ready' | 'error';

/** Engine state, exposed on `window.__ascii` for debugging and the e2e test. */
interface DebugState {
  status: Status;
  model: string;
  triangles: number;
  dropped: number;
  cards: number;
  timings: EngineResult['timings'] | null;
  error: string | null;
  loadBytes(bytes: ArrayBuffer, name: string): Promise<void>;
  loadModel(index: number): Promise<void>;
  coverage(): number;
}

declare global {
  interface Window {
    __ascii: DebugState;
  }
}

const container = document.getElementById('app');
if (!container) throw new Error('#app element is missing');

const atlas = createGlyphAtlas(CHARSET);
const viewer = new Viewer(container, atlas);
const engine = new EngineClient();

const settings: CardSettings = {
  seed: 7,
  count: 24_000,
  sizeFactor: 1.6,
  glyphCount: atlas.chars.length,
  glyphAspect: atlas.aspect,
  color: [0.78, 0.62, 0.45],
  colorJitter: 0.12,
  twist: 0.25,
  tilt: 0.15,
  alphaMin: 0.8,
  alphaMax: 1.0,
};

// Only the most recent request may update the scene; slower, older ones are dropped.
let latest = 0;

const state: DebugState = {
  status: 'loading',
  model: '',
  triangles: 0,
  dropped: 0,
  cards: 0,
  timings: null,
  error: null,
  loadBytes,
  loadModel,
  coverage: () => viewer.coverage(),
};
window.__ascii = state;

async function loadBytes(bytes: ArrayBuffer, name: string): Promise<void> {
  const token = ++latest;
  state.status = 'loading';
  state.model = name;
  state.error = null;
  try {
    const res = await engine.load(bytes, settings);
    if (token !== latest) return;
    if (!res.mesh) throw new Error('engine returned no mesh');
    viewer.setMesh(res.mesh.positions, res.mesh.normals);
    viewer.setCards(res.cards, res.stride);
    Object.assign(state, {
      status: 'ready',
      triangles: res.mesh.triangles,
      dropped: res.mesh.dropped,
      cards: res.count,
      timings: res.timings,
    });
    console.info(
      `[ascii] ${name}: ${res.mesh.triangles} triangles (${res.mesh.dropped} dropped), ` +
        `${res.count} cards, load ${res.timings.loadMs.toFixed(1)} ms, cards ${res.timings.generateMs.toFixed(1)} ms`,
    );
  } catch (err) {
    if (token !== latest) return;
    state.status = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    console.warn(`[ascii] could not load ${name}: ${state.error}`);
  }
}

async function loadModel(index: number): Promise<void> {
  const name = MODELS[index];
  if (!name) return;
  const url = `${import.meta.env.BASE_URL}models/${name}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadBytes(await res.arrayBuffer(), name);
  } catch (err) {
    state.status = 'error';
    state.error = `could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[ascii] ${state.error}`);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const i = Number(e.key) - 1;
  if (Number.isInteger(i) && i >= 0 && i < MODELS.length) void loadModel(i);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (file) void file.arrayBuffer().then((b) => loadBytes(b, file.name));
});

void loadModel(0);
