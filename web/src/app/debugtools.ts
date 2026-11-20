// The visual debug tools: turns the debug options (debug.ts) into what is
// on screen. Info box (F2), chunk borders (F4) and labels, object labels and
// outlines, tile grid, culling boxes, axes, hidden solids wireframe, light /
// glyph-size views, stacking heat map, glyph inspector, perf overlay (F3),
// rebuild log. Everything only runs while switched on. Ships in every build.

import { COLORS, DebugDraw, Lines } from '../render/debugdraw';
import { HeatMap, Labels, OverlayBox, type Label } from '../ui/overlays';
import { PerfOverlay } from '../ui/perf';
import { addGlobalKeys } from '../ui/widgets';
import type { App } from './app';
import type { Cursor } from './cursor';
import type { DebugState } from './debug';
import type { Editor } from './editor';
import { statValue } from './stats';
import type { WorldStreamer } from './world';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const MODES = ['fixed', 'billboard (V)', 'billboard (U)', 'solid', 'emissive', 'rain', 'leaf', 'ground (leans)', 'water (leans)'];

const f1 = (n: number) => n.toFixed(1);
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : `${Math.round(n)}`);

export class DebugTools {
  readonly info = new OverlayBox('debug', 'tui-infobox');
  readonly inspector = new OverlayBox('glyph', 'tui-inspect');
  readonly perf: PerfOverlay;
  private draw: DebugDraw;
  private labels = new Labels();
  private heat = new HeatMap();
  private world: WorldStreamer | null = null;
  private unsubscribeBuilds: (() => void) | null = null;
  private raf = 0;
  private lastPick = 0;

  /** Set once the editor exists (it shows the snapped cursor point). */
  editor: Editor | null = null;

  constructor(private app: App, readonly debug: DebugState, readonly cursor: Cursor) {
    this.draw = new DebugDraw(app.viewer.overlay);
    this.perf = new PerfOverlay(app, document.body);
    debug.onChange(() => this.apply());
    addGlobalKeys((e) => {
      if (e.key === 'F2') return debug.toggle('info'), true;
      if (e.key === 'F3') return debug.toggle('perf'), true;
      if (e.key === 'F4') return debug.toggle('chunks'), true;
      return false;
    });
    app.viewer.renderer.domElement.addEventListener('pointermove', () => this.inspect());
    app.viewer.renderer.domElement.addEventListener('pointerleave', () => this.inspector.show(false));
    window.setInterval(() => this.tick(), 250);
    window.setInterval(() => this.heatTick(), 500);
    this.apply();
  }

  private on(id: string): boolean {
    return this.debug.get(id);
  }

  /** Apply the switches that change something at once. */
  private apply(): void {
    const v = this.app.viewer;
    v.cards.setDebugView(this.on('light') ? 'light' : this.on('size') ? 'size' : 'normal');
    this.perf.toggle(this.on('perf'));
    this.info.show(this.on('info') || this.debug.watches.length > 0);
    this.heat.show(this.on('heat'));
    if (!this.on('inspector')) this.inspector.show(false);
    if (!this.on('chunkLabels') && !this.on('objects')) this.labels.clear();
    if ((this.on('chunkLabels') || this.on('objects')) && !this.raf) this.raf = requestAnimationFrame(this.frame);
    this.tick();
    v.requestRender();
  }

  /** 4 times a second: lines, info box, rebuild log subscription. */
  private tick(): void {
    const a = this.app;
    if (a.world !== this.world) {
      this.unsubscribeBuilds?.();
      this.world = a.world;
      this.unsubscribeBuilds = this.world?.onBuilt((key, reason, ms, cards) => {
        if (this.on('rebuilds')) console.info(`[chunk] ${key} built (${reason}) in ${ms.toFixed(0)} ms, ${fmt(cards)} cards`);
      }) ?? null;
    }
    if (this.info.shown) this.info.setLines(this.infoLines());
    this.updateLines();
  }

  infoLines(): (string | [string, string])[] {
    const a = this.app, v = a.viewer, c = v.camera.position, t = v.controls.target;
    const S = a.world?.info.chunkSize ?? 32, tile = a.world?.info.tile ?? 0.5;
    const dir = v.camera.getWorldDirection(c.clone());
    const yaw = ((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360;
    const pitch = (Math.asin(Math.max(-1, Math.min(1, dir.y))) * 180) / Math.PI;
    const lines: (string | [string, string])[] = [];
    if (this.on('info')) {
      const w = a.state.weather;
      lines.push(
        `pos     ${f1(c.x)}, ${f1(c.y)}, ${f1(c.z)}`,
        `chunk   ${Math.floor(c.x / S)},${Math.floor(c.z / S)}   tile ${Math.floor(c.x / tile)},${Math.floor(c.z / tile)}`,
        `facing  ${COMPASS[Math.round(yaw / 45) % 8]!.padEnd(2)} ${yaw.toFixed(0).padStart(3)}°   pitch ${pitch.toFixed(0)}°`,
        `target  ${f1(t.x)}, ${f1(t.y)}, ${f1(t.z)}`,
        `clock   ${f1(v.clock)} s  x${v.clockRate}${v.clockFrozen ? ' (frozen)' : ''} · ${a.canvasOptions.day ? 'day' : 'dusk'}`,
        `weather wind ${w.wind.toFixed(2)}  rain ${w.rain.toFixed(2)}  leaves ${w.leaves.toFixed(2)}`,
        `canvas  seed ${a.canvasOptions.seed} · view ${a.viewRadius}${a.world?.frozen ? ' · streaming frozen' : ''}`,
        `editor  camera ${this.editor?.mode ?? 'orbit'} · grid ${this.editor?.grid ? 'on' : 'off'} · snap ${this.editor?.snap ? `${this.editor.snap} m` : 'off'}`,
        `map     ${a.map?.editedChunks ?? 0} chunks edited · ${a.map?.objectCount ?? 0} objects`,
      );
    }
    if (this.on('cursor')) {
      const g = this.cursor.ground();
      if (g && a.map) {
        lines.push(`cursor  ${f1(g.x)}, ${f1(g.z)}  chunk ${Math.floor(g.x / S)},${Math.floor(g.z / S)}  tile ${Math.floor(g.x / tile)},${Math.floor(g.z / tile)} · ${a.map.groundAt(g.x, g.z)} · ${a.map.heightAt(g.x, g.z).toFixed(1)} m`);
        const p = this.editor?.snap ? this.editor.point() : null;
        if (p) lines.push(`snapped ${f1(p.x)}, ${f1(p.z)}  (${this.editor!.snap} m)`);
      } else lines.push(['cursor  (point at the ground)', 'tui-dim']);
    }
    for (const w of this.debug.watches) lines.push(`${w.padEnd(7)} ${statValue(a, this.cursor, w) ?? '?'}`);
    return lines;
  }

  /** Rebuild the line layers that are on (cheap: a few thousand segments at most). */
  private updateLines(): void {
    const a = this.app, w = a.world, cam = a.viewer.camera.position;
    const S = w?.info.chunkSize ?? 32, g = w?.info.ground ?? 0;
    // Chunk borders, coloured by state.
    // Lines lie on the ground: draped over hills (one piece per metre), straight when flat.
    const map = a.map, hilly = !!map?.hasHeights;
    const yAt = (x: number, z: number) => g + (map ? map.heightAt(x, z) : 0);
    if (this.on('chunks') && w) {
      const l = new Lines(), step = hilly ? 1 : Infinity;
      for (const c of w.chunks()) {
        const col = c.state === 'building' ? COLORS.building : c.state === 'dirty' ? COLORS.dirty : c.edited ? COLORS.edited : COLORS.loaded;
        const x0 = c.cx * S, z0 = c.cz * S;
        l.drape(x0, z0, x0 + S, z0, col, yAt, 0.04, step);
        l.drape(x0 + S, z0, x0 + S, z0 + S, col, yAt, 0.04, step);
        l.drape(x0 + S, z0 + S, x0, z0 + S, col, yAt, 0.04, step);
        l.drape(x0, z0 + S, x0, z0, col, yAt, 0.04, step);
      }
      this.draw.set('chunks', l);
    } else if (this.draw.has('chunks')) this.draw.set('chunks', null);
    // Culling boxes of nearby render chunks.
    if (this.on('culling')) {
      const l = new Lines();
      for (const b of a.viewer.cards.boxes()) {
        if (Math.hypot((b.lo.x + b.hi.x) / 2 - cam.x, (b.lo.z + b.hi.z) / 2 - cam.z) > 160) continue;
        l.box(b.lo.x, b.lo.y, b.lo.z, b.hi.x, Math.max(b.hi.y, b.lo.y + 0.2), b.hi.z, COLORS.culling);
      }
      this.draw.set('culling', l);
    } else if (this.draw.has('culling')) this.draw.set('culling', null);
    // Object outlines: footprint circle and box.
    if (this.on('outlines') && w) {
      const l = new Lines();
      let n = 0;
      for (const c of w.chunks()) {
        const b = c.loaded?.data.bounds;
        if (!b || Math.hypot((c.cx + 0.5) * S - cam.x, (c.cz + 0.5) * S - cam.z) > 6 * S) continue;
        for (let i = 0; i + 7 <= b.length && n < 600; i += 7, n++) {
          const [, lx, ly, lz, hx, hy, hz] = b.subarray(i, i + 7) as unknown as number[];
          l.box(lx!, ly!, lz!, hx!, hy!, hz!, COLORS.outline);
          l.circleOn((lx! + hx!) / 2, (lz! + hz!) / 2, (hx! - lx!) / 2, COLORS.outline, yAt, 0.05, 24);
        }
      }
      this.draw.set('outlines', l);
    } else if (this.draw.has('outlines')) this.draw.set('outlines', null);
    // Paint tile grid round the cursor.
    const gp = this.on('tiles') ? this.cursor.ground() : null;
    if (gp && w) {
      const t = w.info.tile, l = new Lines(), n = 8;
      const cx = Math.floor(gp.x / t) * t, cz = Math.floor(gp.z / t) * t, step = hilly ? t : Infinity;
      for (let k = -n; k <= n + 1; k++) {
        l.drape(cx - n * t, cz + k * t, cx + (n + 1) * t, cz + k * t, COLORS.tiles, yAt, 0.06, step);
        l.drape(cx + k * t, cz - n * t, cx + k * t, cz + (n + 1) * t, COLORS.tiles, yAt, 0.06, step);
      }
      l.squareOn(cx + t / 2, cz + t / 2, t / 2, COLORS.building, yAt, 0.1, step); // the tile under the cursor
      this.draw.set('tiles', l);
    } else if (this.draw.has('tiles')) this.draw.set('tiles', null);
    // Origin and axes.
    if (this.on('axes')) {
      if (!this.draw.has('axes')) {
        const l = new Lines();
        l.seg(0, g + 0.05, 0, 10, g + 0.05, 0, COLORS.x);
        l.seg(0, g, 0, 0, g + 5, 0, COLORS.y);
        l.seg(0, g + 0.05, 0, 0, g + 0.05, 10, COLORS.z);
        for (let k = 1; k <= 10; k++) {
          l.seg(k, g, -0.2, k, g, 0.2, COLORS.x);
          l.seg(-0.2, g, k, 0.2, g, k, COLORS.z);
        }
        this.draw.set('axes', l);
      }
    } else if (this.draw.has('axes')) this.draw.set('axes', null);
    this.draw.setBodies(this.on('bodies') ? a.viewer.bodyMeshes : null);
    a.viewer.requestRender();
  }

  /** Every frame while labels are on: re-place them for the camera. */
  private frame = (): void => {
    this.raf = 0;
    if (!this.on('chunkLabels') && !this.on('objects')) return;
    const a = this.app, w = a.world, v = a.viewer, cam = v.camera.position, el = v.renderer.domElement;
    const S = w?.info.chunkSize ?? 32, g = w?.info.ground ?? 0;
    const labels: Label[] = [];
    if (w && this.on('chunkLabels')) {
      const ccx = Math.floor(cam.x / S), ccz = Math.floor(cam.z / S);
      for (const c of w.chunks()) {
        if (Math.abs(c.cx - ccx) > 4 || Math.abs(c.cz - ccz) > 4) continue;
        const state = c.state === 'loaded' ? (c.edited ? 'edited' : '') : c.state;
        labels.push({ x: (c.cx + 0.5) * S, y: g + 0.3, z: (c.cz + 0.5) * S, text: `${c.cx},${c.cz}${state ? ` ${state}` : ''}`, cls: `tui-tag-${c.state}` });
      }
    }
    if (w && a.map && this.on('objects')) {
      const objs: (Label & { d: number })[] = [];
      for (const c of w.chunks()) {
        const b = c.loaded?.data.bounds;
        if (!b) continue;
        const list = a.map.objectsIn(c.cx, c.cz);
        for (let i = 0; i + 7 <= b.length; i += 7) {
          const o = list[b[i]!];
          if (!o) continue;
          const x = (b[i + 1]! + b[i + 4]!) / 2, z = (b[i + 3]! + b[i + 6]!) / 2;
          objs.push({ x, y: b[i + 5]! + 0.3, z, text: `#${o.id} ${o.kind}`, cls: 'tui-tag-object', d: Math.hypot(x - cam.x, z - cam.z) });
        }
      }
      objs.sort((p, q) => p.d - q.d);
      labels.push(...objs.slice(0, 50));
    }
    this.labels.update(labels, v.camera, el.clientWidth, el.clientHeight);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Twice a second while the heat map is on. */
  private heatTick(): void {
    if (!this.on('heat')) return;
    const v = this.app.viewer, el = v.renderer.domElement;
    this.heat.draw(v.cards.stackGrid(v.camera, el.clientWidth, el.clientHeight, 16), 16);
  }

  /** The glyph under the mouse, described in a tooltip. */
  private inspect(): void {
    if (!this.on('inspector') || !this.cursor.screen) return;
    const now = performance.now();
    if (now - this.lastPick < 80) return;
    this.lastPick = now;
    const lines = this.describeAt(this.cursor.screen.x, this.cursor.screen.y);
    this.inspector.show(lines !== null);
    if (!lines) return;
    this.inspector.setLines(lines);
    this.inspector.placeNear(this.cursor.screen.x, this.cursor.screen.y);
  }

  /** What the inspector says about the glyph at screen (x, y), or null. */
  describeAt(x: number, y: number): string[] | null {
    const a = this.app, v = a.viewer, el = v.renderer.domElement;
    const hit = v.cards.pick(v.camera, el.clientWidth, el.clientHeight, x, y, 12);
    if (!hit) return null;
    const c = hit.card;
    const slot = Math.round(c[13]!), high = Math.floor(slot / 1024);
    const ch = a.charset[slot % 1024] ?? '?';
    const mat = a.world?.info.materialNames[high % 64] ?? `material ${high % 64}`;
    const mode = MODES[Math.floor(high / 64)] ?? `mode ${Math.floor(high / 64)}`;
    const u = Math.hypot(c[3]!, c[4]!, c[5]!), vv = Math.hypot(c[6]!, c[7]!, c[8]!);
    let owner = '';
    const m = /^w(-?\d+),(-?\d+)$/.exec(hit.set);
    if (m && a.world && a.map) {
      const cx = Number(m[1]), cz = Number(m[2]);
      const b = a.world.chunk(cx, cz)?.data.bounds;
      const list = a.map.objectsIn(cx, cz);
      if (b) {
        for (let i = 0; i + 7 <= b.length; i += 7) {
          if (c[0]! >= b[i + 1]! && c[0]! <= b[i + 4]! && c[1]! >= b[i + 2]! - 0.1 && c[1]! <= b[i + 5]! + 0.1 && c[2]! >= b[i + 3]! && c[2]! <= b[i + 6]!) {
            const o = list[b[i]!];
            if (o) owner = `   object #${o.id} ${o.kind}`;
            if (o && c[1]! > 0.05) break;
          }
        }
      }
    }
    return [
      `'${ch}'  ${mat} · ${mode}`,
      `set ${hit.set}${owner}`,
      `at (${c[0]!.toFixed(2)}, ${c[1]!.toFixed(2)}, ${c[2]!.toFixed(2)})  size ${u.toFixed(2)} x ${vv.toFixed(2)} m`,
      `colour ${c[9]!.toFixed(2)} ${c[10]!.toFixed(2)} ${c[11]!.toFixed(2)}  alpha ${c[12]!.toFixed(2)}`,
      `light  sun ${c[14]!.toFixed(2)}  sky ${c[15]!.toFixed(2)}`,
    ];
  }
}
