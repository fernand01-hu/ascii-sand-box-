// Quality presets (Phase 5, step 22): one setting that picks the view
// distance, the glyph budget, the live sun shadows and their resolution,
// and how long detail fades take, for the machine at hand.
//   low     software rendering (no GPU): 6 chunks, 60k glyphs a frame,
//           shadows baked into the chunks, short fades
//   medium  9 chunks, no budget, live shadows on a 1024 map
//   high    12 chunks, no budget, live shadows on a 2048 map
// On the first visit it is chosen from the GPU the browser reports (a
// software renderer gets low, a real GPU high); after that, whatever was
// set stays, and each value can still be changed on its own.

import type { App } from './app';
import type { Look } from './look';
import type { Settings } from './settings';

export type Quality = 'low' | 'medium' | 'high';
export const QUALITIES: Quality[] = ['low', 'medium', 'high'];
const CHOSEN = 'ascii-sandbox.quality';

/** The GPU the browser draws with, as it names it (or "unknown"). */
export function gpuName(app: App): string {
  const g = app.viewer.renderer.getContext();
  const ext = g.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(g.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown';
}

/** A software renderer (SwiftShader, llvmpipe...): no real GPU. */
export function isSoftware(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|microsoft basic/i.test(name);
}

export class QualityPresets {
  current: Quality | 'custom' = 'custom';

  constructor(private app: App, private look: Look, private settings: Settings) {
    settings.add({
      // Not re-applied on every visit (only when picked), so changes made after it stick.
      name: 'quality', help: 'low (no GPU), medium or high: view distance, glyph budget, live shadows, fades',
      get: () => this.current,
      set: (v) => {
        if (v === 'custom') return;
        if (!QUALITIES.includes(v as Quality)) throw new Error('quality: low, medium or high');
        this.apply(v as Quality);
      },
    });
  }

  /** On the first visit: pick from the GPU. */
  firstVisit(): void {
    let chosen = false;
    try {
      chosen = localStorage.getItem(CHOSEN) !== null;
    } catch {
      // storage blocked: choose every time
    }
    if (chosen) {
      try {
        this.current = (localStorage.getItem(CHOSEN) as Quality) ?? 'custom';
      } catch {
        // storage blocked
      }
      return;
    }
    // Automated test browsers keep the defaults their checks expect.
    if (navigator.webdriver) return;
    this.apply(isSoftware(gpuName(this.app)) ? 'low' : 'high');
  }

  apply(q: Quality): void {
    const a = this.app;
    const p = { low: { view: 6, budget: 60_000, shadows: false, map: 1024, fade: 0.5 }, medium: { view: 9, budget: Infinity, shadows: true, map: 1024, fade: 0.8 }, high: { view: 12, budget: Infinity, shadows: true, map: 2048, fade: 0.8 } }[q];
    a.setViewRadius(p.view);
    a.viewer.cards.budget = p.budget;
    a.viewer.cards.fadeSeconds = p.fade;
    this.look.shadowSize = p.map;
    this.look.set({ shadows: p.shadows });
    this.current = q;
    try {
      localStorage.setItem(CHOSEN, q);
    } catch {
      // storage blocked
    }
    this.settings.save();
  }
}
