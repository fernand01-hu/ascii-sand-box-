// The object brush's live preview: one object with the brush's parameters,
// drawn by a small viewer of its own (drag to turn it round). Rebuilt a
// moment after the parameters stop changing.

import type { App } from '../app/app';
import { materialsFromTable, SCENERY_LIGHTING } from '../app/app';
import { createGlyphAtlas, glyphAspect } from '../render/atlas';
import { Viewer } from '../render/viewer';
import { Vector3 } from 'three';

export class ObjectPreview {
  readonly el: HTMLDivElement;
  readonly info: HTMLDivElement;
  private viewer: Viewer | null = null;
  private timer = 0;
  private token = 0;
  /** Cards in the preview now (for tests and the caption). */
  cards = 0;

  constructor(private app: App) {
    this.el = document.createElement('div');
    this.el.className = 'tui-preview';
    this.info = document.createElement('div');
    this.info.className = 'tui-dim tui-preview-info';
    this.info.textContent = 'preview';
  }

  /** Show `kind` with these parameters (debounced). */
  show(kind: string, params: number[] | undefined, seed: number): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.build(kind, params, seed), 250);
  }

  private async build(kind: string, params: number[] | undefined, seed: number): Promise<void> {
    const code = this.app.map?.info.objectKinds.indexOf(kind) ?? -1;
    if (code < 0 || !this.el.isConnected || this.el.clientHeight === 0) return;
    const token = ++this.token;
    this.info.textContent = `${kind} · building...`;
    try {
      const res = await this.app.engine.objectPreview(code, seed, params ?? [], glyphAspect(), this.el.clientHeight);
      if (token !== this.token || !res.camera || !res.materials || !res.sunDir || !res.mesh) return;
      const v = (this.viewer ??= new Viewer(this.el, createGlyphAtlas(res.charset)));
      v.cards.setMaterials(materialsFromTable(res.materials, res.materialFloats));
      v.cards.setLighting({ ...SCENERY_LIGHTING, sunDir: new Vector3(...res.sunDir) });
      v.setCards(res.cards, res.stride, res.chunks);
      v.setFreeScene(new Vector3(...res.camera.target), new Vector3(...res.camera.eye), {
        fov: res.camera.fov,
        body: res.mesh.positions.length ? { positions: res.mesh.positions, normals: res.mesh.normals } : undefined,
      });
      this.cards = res.count;
      this.info.textContent = `${kind} · seed ${seed} · ${res.count} glyphs`;
    } catch (e) {
      if (token === this.token) this.info.textContent = `preview failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
