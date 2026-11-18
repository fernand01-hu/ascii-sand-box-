// The product core: one viewer, one engine worker, and the logic that turns
// engine results into what's on screen. No debug or test code lives here.

import { EngineClient, SupersededError } from '../engine/client';
import type { CardSettings, EngineResult } from '../engine/protocol';
import { createGlyphAtlas, glyphAspect, type GlyphAtlas } from '../render/atlas';
import { DEFAULT_LIGHTING, SURFACE_MATERIAL } from '../render/cards';
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
  };
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

  loadBytes(bytes: ArrayBuffer, name: string): Promise<void> {
    return this.run(name, () => this.engine.load(bytes, this.settings), (res) => {
      if (!res.mesh) throw new Error('engine returned no mesh');
      const v = this.viewer;
      v.cards.setAtlas(this.atlasFor(res.charset));
      v.cards.setMaterials([SURFACE_MATERIAL]);
      v.cards.setLighting(DEFAULT_LIGHTING);
      v.setMesh(res.mesh.positions, res.mesh.normals);
      v.setCards(res.cards, res.stride);
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
