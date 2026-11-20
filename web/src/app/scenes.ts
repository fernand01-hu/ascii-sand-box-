// Saving and loading scenes.
//
//   * Named scenes live in the browser (localStorage); Ctrl+S saves the
//     current one. A scene can also be downloaded as a .scene.json file and
//     loaded back (file picker, or drop the file on the page).
//   * Loading replaces the map as one undoable change (Ctrl+Z brings back
//     what was there), switches the canvas seed and time of day if needed,
//     and restores the weather and camera.
//   * Autosave: every 30 s when something changed, and when the page closes,
//     into a separate slot; reloading the page brings the work back.
//   * Export: the view as a PNG, or as plain ASCII text (the frontmost glyph
//     per text cell).
// The file format itself is app/scenefile.ts.

import { Vector3 } from 'three';
import type { App } from './app';
import { download } from './download';
import type { MapData } from './map';
import { buildScene, paramsByName, paramsFromNames, parseScene, remapGrounds, SceneError, type SceneContent, type SceneFile } from './scenefile';
import type { Settings } from './settings';
import type { Undo } from './undo';

const INDEX_KEY = 'ascii-sandbox.scenes';
const slotKey = (name: string) => `ascii-sandbox.scene:${name}`;
/** The slot autosave writes; listed apart from named scenes. */
export const AUTOSAVE = '(autosave)';
const AUTOSAVE_MS = 30_000;

export interface SavedScene {
  name: string;
  saved: string;
  bytes: number;
}

export class SceneStore {
  /** Name Ctrl+S saves under (the last scene saved or loaded). */
  current = 'untitled';
  autosave = true;
  private dirty = false;
  private watched: MapData | null = null;
  private messages = new Set<(text: string, kind: 'ok' | 'err') => void>();
  private picker: HTMLInputElement;

  constructor(private app: App, private undo: Undo, settings: Settings) {
    const watch = () => {
      if (!app.map || this.watched === app.map) return;
      this.watched = app.map;
      app.map.onEdit(() => (this.dirty = true));
    };
    app.onSceneChange(watch);
    watch();

    // A hidden file input for "load a scene file".
    this.picker = document.createElement('input');
    this.picker.type = 'file';
    this.picker.accept = '.json,application/json';
    this.picker.hidden = true;
    this.picker.addEventListener('change', () => {
      const f = this.picker.files?.[0];
      this.picker.value = '';
      if (f) void this.loadFile(f);
    });
    document.body.appendChild(this.picker);

    // Drop a scene file anywhere on the page.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      const f = e.dataTransfer?.files[0];
      if (!f || !/\.json$/i.test(f.name)) return; // .stl files are the dev tools' business
      e.preventDefault();
      void this.loadFile(f);
    });

    // Ctrl+S: save the current scene (not the browser's "save page").
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.report(() => this.save(), (r) => `saved "${r.name}" (${kb(r.bytes)})`);
    }, true);

    window.setInterval(() => this.autosaveNow(false), AUTOSAVE_MS);
    window.addEventListener('pagehide', () => this.autosaveNow(false));

    settings.add({
      name: 'autosave', help: 'save the work every 30 s and on closing, restored on reload (on / off)', persist: true,
      get: () => (this.autosave ? 'on' : 'off'),
      set: (v) => {
        if (v !== 'on' && v !== 'off') throw new Error('autosave: on or off');
        this.autosave = v === 'on';
      },
    });
  }

  /** Called with a short message after a save, load or failure (status bar). */
  onMessage(f: (text: string, kind: 'ok' | 'err') => void): () => void {
    this.messages.add(f);
    return () => this.messages.delete(f);
  }

  private say(text: string, kind: 'ok' | 'err' = 'ok'): void {
    for (const f of this.messages) f(text, kind);
  }

  private report<T>(f: () => T, ok: (r: T) => string): void {
    try {
      this.say(ok(f()));
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), 'err');
    }
  }

  /** The scene as it is now, as a file. */
  snapshot(name = this.current): SceneFile {
    const a = this.app, m = a.map;
    if (!m || !a.world) throw new SceneError('show the canvas first');
    const d = m.exportData();
    const v = a.viewer;
    return buildScene(name, {
      canvas: { ...a.canvasOptions },
      weather: { ...a.canvasWeather },
      camera: { position: v.camera.position.toArray() as [number, number, number], target: v.controls.target.toArray() as [number, number, number] },
      chunkSize: m.info.chunkSize, tiles: m.info.tiles, grounds: m.info.groundKinds,
      chunks: d.chunks,
      objects: d.objects.map(({ params, ...o }) => {
        const named = paramsByName(params, m.info.objectParams?.[o.kind] ?? []);
        return named ? { ...o, params: named } : o;
      }),
    });
  }

  /** Save under `name` in the browser; it becomes the current scene. */
  save(name = this.current): SavedScene {
    const n = checkName(name);
    const json = JSON.stringify(this.snapshot(n));
    this.write(n, json);
    this.current = n;
    this.dirty = false;
    return { name: n, saved: new Date().toISOString(), bytes: json.length };
  }

  private write(name: string, json: string): void {
    try {
      localStorage.setItem(slotKey(name), json);
      const index = this.list(true).filter((s) => s.name !== name);
      index.push({ name, saved: new Date().toISOString(), bytes: json.length });
      localStorage.setItem(INDEX_KEY, JSON.stringify(index));
    } catch {
      throw new SceneError('the browser storage is full or blocked: download the scene instead');
    }
  }

  /** Saved scenes, newest first (autosave included when `all`). */
  list(all = false): SavedScene[] {
    let index: SavedScene[] = [];
    try {
      index = JSON.parse(localStorage.getItem(INDEX_KEY) ?? '[]') as SavedScene[];
    } catch {
      index = [];
    }
    index = index.filter((s) => s && typeof s.name === 'string');
    if (!all) index = index.filter((s) => s.name !== AUTOSAVE);
    return index.sort((p, q) => q.saved.localeCompare(p.saved));
  }

  delete(name: string): boolean {
    const had = this.list(true).some((s) => s.name === name);
    try {
      localStorage.removeItem(slotKey(name));
      localStorage.setItem(INDEX_KEY, JSON.stringify(this.list(true).filter((s) => s.name !== name)));
    } catch {
      // storage blocked: nothing to delete
    }
    return had;
  }

  /** Load a scene saved in the browser. */
  async load(name: string): Promise<void> {
    const json = (() => {
      try {
        return localStorage.getItem(slotKey(name));
      } catch {
        return null;
      }
    })();
    if (json === null) throw new SceneError(`no scene called "${name}"`);
    await this.loadJson(json, name === AUTOSAVE ? this.current : name);
  }

  /** Load a scene file the user picked or dropped. */
  async loadFile(f: File): Promise<void> {
    try {
      await this.loadJson(await f.text(), f.name.replace(/(\.scene)?\.json$/i, ''));
      this.say(`loaded "${this.current}" from ${f.name} (Ctrl+Z undoes)`);
    } catch (e) {
      this.say(`could not load ${f.name}: ${e instanceof Error ? e.message : String(e)}`, 'err');
    }
  }

  /** Open the file picker (must follow a user action, e.g. a key or click). */
  pickFile(): void {
    this.picker.click();
  }

  /** Read a scene from JSON text and show it. */
  async loadJson(json: string, name: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      throw new SceneError('the file is not valid JSON');
    }
    const c = parseScene(raw);
    await this.apply(c, name, `load ${name}`);
  }

  /** Show a scene: canvas seed / day, map (one undoable change), weather, camera. */
  async apply(c: SceneContent, name: string, label: string, undoable = true): Promise<void> {
    const a = this.app;
    if (!a.world || a.canvasOptions.seed !== c.canvas.seed || a.canvasOptions.day !== c.canvas.day) await a.showCanvas(c.canvas.seed, c.canvas.day);
    const m = a.map;
    if (!m) throw new SceneError('the canvas did not start');
    if (c.tiles !== m.info.tiles || c.chunkSize !== m.info.chunkSize) throw new SceneError(`the scene uses ${c.chunkSize} m chunks of ${c.tiles} tiles; this version uses ${m.info.chunkSize} m / ${m.info.tiles}`);
    const unknown = [...new Set(c.objects.map((o) => o.kind).filter((k) => !m.info.objectKinds.includes(k)))];
    if (unknown.length) throw new SceneError(`the scene uses objects this version doesn't have: ${unknown.join(', ')}`);
    const chunks = remapGrounds(c.chunks, c.grounds, m.info.groundKinds);
    if (undoable) this.undo.begin(label);
    const objects = c.objects.map(({ params, ...o }) => {
      const vals = paramsFromNames(params, m.info.objectParams?.[o.kind] ?? []);
      return vals ? { ...o, params: vals } : o;
    });
    try {
      m.replaceWith(chunks, objects);
    } finally {
      if (undoable) this.undo.end();
    }
    if (!undoable) this.undo.history?.clear();
    a.setEnvironment(c.weather);
    if (c.camera) {
      const v = a.viewer;
      v.stopMotion();
      v.camera.position.copy(new Vector3(...c.camera.position));
      v.controls.target.copy(new Vector3(...c.camera.target));
      v.controls.update();
      v.requestRender();
    }
    this.current = name;
    this.dirty = false;
  }

  /** Clear the map for a new scene (undoable). */
  newScene(): void {
    if (!this.app.map) throw new SceneError('show the canvas first');
    this.undo.begin('new scene');
    try {
      this.app.map.clear();
    } finally {
      this.undo.end();
    }
    this.current = 'untitled';
  }

  /** Download a scene as a .scene.json file (the current map, or a saved one). */
  download(name?: string): string {
    let json: string;
    let n = name ?? this.current;
    if (name && name !== this.current) {
      const stored = localStorage.getItem(slotKey(name));
      if (stored === null) throw new SceneError(`no scene called "${name}"`);
      json = stored;
    } else {
      n = checkName(n);
      json = JSON.stringify(this.snapshot(n), null, 1);
    }
    const file = `${n.replace(/[^\w-]+/g, '_')}.scene.json`;
    download(file, new Blob([json], { type: 'application/json' }));
    return file;
  }

  /** Autosave now if something changed (or always with `force`). Returns whether it saved. */
  autosaveNow(force = true): boolean {
    if ((!this.autosave && !force) || (!this.dirty && !force) || !this.app.map || !this.app.world) return false;
    try {
      this.write(AUTOSAVE, JSON.stringify(this.snapshot(this.current)));
      this.dirty = false;
      return true;
    } catch {
      return false;
    }
  }

  /** Bring back the autosaved work (at start-up); not undoable. Returns whether there was any. */
  async restoreAutosave(): Promise<boolean> {
    if (!this.autosave) return false;
    let json: string | null = null;
    try {
      json = localStorage.getItem(slotKey(AUTOSAVE));
    } catch {
      return false;
    }
    if (!json) return false;
    try {
      const raw = JSON.parse(json) as { name?: string };
      await this.apply(parseScene(raw), typeof raw.name === 'string' ? raw.name : 'untitled', 'autosave', false);
      return true;
    } catch (e) {
      console.warn(`[ascii] the autosave could not be restored: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** The view as a PNG file. */
  exportPng(): string {
    const file = `${this.current.replace(/[^\w-]+/g, '_')}.png`;
    download(file, this.app.viewer.snapshot());
    return file;
  }

  /** The view as plain ASCII text, `cols` characters wide. */
  viewText(cols = 120): string {
    const v = this.app.viewer, el = v.renderer.domElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    const rows = Math.max(1, Math.round(cols * (h / w) * 0.5)); // text cells are about twice as tall as wide
    const slots = v.cards.textGrid(v.camera, w, h, cols, rows);
    const chars = this.app.charset;
    const lines: string[] = [];
    for (let r = 0; r < rows; r++) {
      let line = '';
      for (let c = 0; c < cols; c++) {
        const s = slots[r * cols + c]!;
        line += s < 0 ? ' ' : (chars[s % 1024] ?? ' ');
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  /** The view as a .txt file. */
  exportText(cols = 120): string {
    const file = `${this.current.replace(/[^\w-]+/g, '_')}.txt`;
    download(file, new Blob([this.viewText(cols) + '\n'], { type: 'text/plain' }));
    return file;
  }
}

function checkName(name: string): string {
  const n = name.trim();
  if (!/^[\w][\w .-]{0,39}$/.test(n)) throw new SceneError('a scene name is 1-40 letters, digits, spaces, dots, dashes or underscores');
  return n;
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
