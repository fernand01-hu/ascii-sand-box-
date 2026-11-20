// Terminal commands: plain functions on the app, so the terminal UI, the
// e2e test and the browser console all run exactly the same thing. Grouped
// for `help`. Dev-only commands (the testbed pine) are added with
// `registerCommand` from devtools.ts, so they never reach production.

import { GALLERY_CATEGORIES, type GalleryCategory } from '../engine/protocol';
import type { App } from './app';
import type { Cursor } from './cursor';
import type { DebugState } from './debug';
import { DEBUG_OPTIONS } from './debug';
import type { DebugTools } from './debugtools';
import { SNAP_STEPS, type Editor } from './editor';
import type { BrushTool } from './brushtool';
import type { Undo } from './undo';
import { AUTOSAVE, type SceneStore } from './scenes';
import { KIND_MIXES, OBJECT_MODES, type ObjectMode, type ObjectTool } from './objecttool';
import type { SelectTool } from './selecttool';
import type { PresetStore } from './presets';
import type { HeightTool } from './heighttool';
import { HEIGHT_MODES, type HeightMode } from './heightbrush';
import { statLines, statNames, statValue } from './stats';
import { TEST_MODELS } from './models';
import { parseCards, type Settings } from './settings';
import { glyphAspect } from '../render/atlas';
import { download } from './download';

export type LineKind = 'out' | 'info' | 'err';

export interface CommandIO {
  print(text: string, kind?: LineKind | 'dim'): void;
  clear(): void;
}

/** What commands can reach besides the app. */
export interface CommandContext {
  debug: DebugState;
  settings: Settings;
  cursor: Cursor;
  tools: DebugTools;
  editor: Editor;
  brush: BrushTool;
  undo: Undo;
  scenes: SceneStore;
  objects: ObjectTool;
  select: SelectTool;
  presets: PresetStore;
  height: HeightTool;
  term: {
    aliases: Map<string, string>;
    binds: Map<string, string>;
    /** Lines the previous command printed. */
    lastOutput: string[];
    logText(): string;
    /** Run a command line (aliases, `;`, `!!` included). */
    exec(line: string): Promise<void>;
    /** Remember aliases and binds. */
    save(): void;
  };
}

type Group = 'info' | 'camera' | 'world' | 'map' | 'file' | 'debug' | 'terminal' | 'scenes';
const GROUPS: Group[] = ['info', 'camera', 'world', 'map', 'file', 'debug', 'terminal', 'scenes'];

export interface Command {
  name: string;
  group: Group;
  usage: string;
  help: string;
  run(app: App, args: string[], io: CommandIO, ctx: CommandContext): void | Promise<void>;
}

/** A user mistake: printed in red, without a stack trace. */
export class CommandError extends Error {}

function num(s: string | undefined, what: string, lo = -Infinity, hi = Infinity): number {
  const v = Number(s);
  if (s === undefined || s === '' || !Number.isFinite(v)) throw new CommandError(`${what}: expected a number, got ${s === undefined ? 'nothing' : JSON.stringify(s)}`);
  if (v < lo || v > hi) throw new CommandError(`${what}: must be between ${lo} and ${hi}`);
  return v;
}

/** 0..1, or on / off. */
function amount(s: string | undefined, what: string, onValue = 1): number {
  if (s === 'on') return onValue;
  if (s === 'off') return 0;
  return num(s, what, 0, 1);
}

function needWorld(app: App) {
  if (!app.map || !app.world) throw new CommandError('show the canvas first (command: canvas)');
  return { map: app.map, world: app.world };
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : `${Math.round(n)}`);
const f1 = (n: number) => n.toFixed(1);


async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Wait until every chunk in range is built (streaming driven directly, so slow drawing can't stall it). */
async function settle(app: App, timeoutMs = 120_000): Promise<void> {
  const w = app.world;
  if (!w) return;
  const t0 = performance.now();
  for (let quiet = 0; quiet < 3 && performance.now() - t0 < timeoutMs;) {
    w.update(app.viewer.camera.position, true);
    quiet = w.pending === 0 && w.dirtyCount === 0 ? quiet + 1 : 0;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run f; turn its errors into user-facing command errors. */
function wrap<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw new CommandError(e instanceof Error ? e.message : String(e));
  }
}

const KIND_GROUPS: Record<string, string> = { trees: 'tree:', bushes: 'bush:', plants: 'plant:', rocks: 'rock:', any: '' };

const COMMANDS: Command[] = [
  // ---- info
  {
    name: 'help', group: 'info', usage: 'help [command|group]', help: 'list commands by group, or explain one',
    run(_app, [name], io) {
      if (name && !GROUPS.includes(name as Group)) {
        const c = COMMANDS.find((c) => c.name === name);
        if (!c) throw new CommandError(`no command ${JSON.stringify(name)} (groups: ${GROUPS.join(', ')})`);
        io.print(c.usage, 'info');
        io.print(`  ${c.help}`);
        return;
      }
      const groups = name ? [name as Group] : GROUPS;
      const w = Math.max(...COMMANDS.map((c) => c.usage.length));
      for (const g of groups) {
        const list = COMMANDS.filter((c) => c.group === g);
        if (!list.length) continue;
        io.print(`── ${g} ──`, 'info');
        for (const c of list) io.print(`${c.usage.padEnd(w)}  ${c.help}`);
      }
      io.print('chain with ;   !! repeats the last line   ` / F1 terminal  F2 info  F3 perf  F4 chunks', 'dim');
    },
  },
  {
    name: 'stats', group: 'info', usage: 'stats', help: 'frame rate, cards, chunks and worker queues',
    run: (app, _x, io) => statLines(app).forEach((l) => io.print(l)),
  },
  {
    name: 'chunks', group: 'info', usage: 'chunks', help: 'chunk streaming and what the map holds',
    run(app, _x, io) {
      const { world: w, map: m } = needWorld(app);
      io.print(`loaded ${w.loadedCount}, building ${w.pending}, dirty ${w.dirtyCount}, view radius ${w.radius} chunks (${w.info.chunkSize} m each)${w.frozen ? ', streaming FROZEN' : ''}`);
      io.print(`built ${w.built} in all: ${w.editBuilds} after edits, ${w.viewBuilds} after camera moves`);
      io.print(`map: ${m.editedChunks} chunks hold edits, ${m.objectCount} objects`);
    },
  },
  {
    name: 'chunk', group: 'info', usage: 'chunk [cx cz]', help: 'one chunk in detail (default: the one under the camera)',
    run(app, [a, b], io) {
      const { world: w, map: m } = needWorld(app);
      const S = w.info.chunkSize, c = app.viewer.camera.position;
      const cx = a === undefined ? Math.floor(c.x / S) : num(a, 'cx'), cz = b === undefined ? Math.floor(c.z / S) : num(b, 'cz');
      const info = w.chunks().find((k) => k.cx === cx && k.cz === cz);
      io.print(`chunk ${cx},${cz}: x ${cx * S}..${(cx + 1) * S}, z ${cz * S}..${(cz + 1) * S}`, 'info');
      if (!info) io.print('not loaded (outside the view radius)');
      else {
        io.print(`state ${info.state}${info.edited ? ', holds edits' : ''}, map revision ${m.revision(info.key)}`);
        const l = info.loaded;
        if (l) {
          io.print(`last built: ${l.reason}, ${l.buildMs.toFixed(0)} ms, ${fmt(l.cards)} cards, ${((performance.now() - l.builtAt) / 1000).toFixed(0)} s ago`);
          io.print(`built for eye (${l.data.eye.map(f1).join(', ')}), from revision ${l.data.rev}, ${l.data.placed} objects drawn`);
        }
      }
      const paint = Object.entries(m.paintCounts(cx, cz)).map(([k, n]) => `${k} ${n}`).join(', ');
      io.print(`paint: ${paint || 'none (all canvas)'}`);
      const objs = m.objectsIn(cx, cz);
      io.print(`objects: ${objs.length ? objs.slice(0, 12).map((o) => `#${o.id} ${o.kind}`).join(', ') + (objs.length > 12 ? ` ... +${objs.length - 12}` : '') : 'none'}`);
    },
  },
  {
    name: 'obj', group: 'info', usage: 'obj <id>', help: 'everything about one placed object',
    run(app, [id], io) {
      const { map: m, world: w } = needWorld(app);
      const o = m.object(num(id, 'id'));
      if (!o) throw new CommandError(`no object #${id}`);
      const [cx, cz] = m.chunkOf(o.x, o.z);
      io.print(`#${o.id} ${o.kind}`, 'info');
      io.print(`at (${o.x.toFixed(2)}, ${o.z.toFixed(2)})  yaw ${((o.yaw * 180) / Math.PI).toFixed(0)}°  scale ${o.scale}  seed ${o.seed}  chunk ${cx},${cz}`);
      const l = w.chunk(cx, cz), list = m.objectsIn(cx, cz), i = list.indexOf(o), b = l?.data.bounds;
      if (b) {
        for (let k = 0; k + 7 <= b.length; k += 7) {
          if (b[k] !== i) continue;
          io.print(`box x ${b[k + 1]!.toFixed(1)}..${b[k + 4]!.toFixed(1)}  y ${b[k + 2]!.toFixed(1)}..${b[k + 5]!.toFixed(1)}  z ${b[k + 3]!.toFixed(1)}..${b[k + 6]!.toFixed(1)}`);
        }
      }
      const c = app.viewer.camera.position;
      io.print(`${f1(Math.hypot(o.x - c.x, o.z - c.z))} m from the camera`);
    },
  },
  {
    name: 'here', group: 'info', usage: 'here', help: 'what is under the cursor (or below the camera)',
    run(app, _x, io, ctx) {
      const { map: m, world: w } = needWorld(app);
      const c = app.viewer.camera.position;
      const g = ctx.cursor.ground() ?? { x: c.x, z: c.z };
      const S = w.info.chunkSize, t = w.info.tile;
      io.print(`(${g.x.toFixed(2)}, ${g.z.toFixed(2)})  ${ctx.cursor.ground() ? 'under the cursor' : 'below the camera'}`, 'info');
      io.print(`chunk ${Math.floor(g.x / S)},${Math.floor(g.z / S)}  tile ${Math.floor(g.x / t)},${Math.floor(g.z / t)}  ground ${m.groundAt(g.x, g.z)}  height ${m.heightAt(g.x, g.z).toFixed(2)} m`);
      const near = m.allObjects().map((o) => ({ o, d: Math.hypot(o.x - g.x, o.z - g.z) })).filter((p) => p.d < 4).sort((p, q) => p.d - q.d);
      io.print(near.length ? `nearby: ${near.slice(0, 6).map((p) => `#${p.o.id} ${p.o.kind} (${f1(p.d)} m)`).join(', ')}` : 'no objects within 4 m');
    },
  },
  {
    name: 'tile', group: 'info', usage: 'tile <x> <z>', help: 'the ground paint at a point',
    run(app, [xs, zs], io) {
      const { map: m, world: w } = needWorld(app);
      const x = num(xs, 'x'), z = num(zs, 'z'), t = w.info.tile;
      io.print(`tile ${Math.floor(x / t)},${Math.floor(z / t)} (${t} m) at chunk ${m.chunkOf(x, z).join(',')}: ${m.groundAt(x, z)}`);
    },
  },
  {
    name: 'pos', group: 'info', usage: 'pos', help: 'camera position, orbit target and chunk',
    run(app, _x, io) {
      const c = app.viewer.camera.position, t = app.viewer.controls.target;
      const S = app.world?.info.chunkSize ?? 32;
      io.print(`camera (${f1(c.x)}, ${f1(c.y)}, ${f1(c.z)})  target (${f1(t.x)}, ${f1(t.y)}, ${f1(t.z)})  chunk ${Math.floor(c.x / S)},${Math.floor(c.z / S)}`);
    },
  },
  {
    name: 'kinds', group: 'info', usage: 'kinds', help: 'ground paints and object kinds',
    run(app, _x, io) {
      const { map: m } = needWorld(app);
      io.print(`ground: ${m.info.groundKinds.join(' ')}`);
      io.print(`objects: ${m.info.objectKinds.join(' ')}`);
    },
  },
  {
    name: 'objects', group: 'info', usage: 'objects', help: 'list placed objects (nearest 20)',
    run(app, _x, io) {
      const { map: m } = needWorld(app);
      const c = app.viewer.camera.position;
      const all = m.allObjects().sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
      if (all.length === 0) io.print('no objects');
      for (const o of all.slice(0, 20)) io.print(`#${o.id}  ${o.kind.padEnd(22)} (${f1(o.x)}, ${f1(o.z)})  scale ${o.scale}  seed ${o.seed}`);
      if (all.length > 20) io.print(`... and ${all.length - 20} more`, 'info');
    },
  },
  {
    name: 'stack', group: 'info', usage: 'stack', help: 'how many glyphs pile up on one spot of the screen (per 16 px cell)',
    run(app, _x, io) {
      const s = app.viewer.stacking();
      io.print(s.cells ? `glyphs per screen cell: mean ${s.mean.toFixed(1)}, 95% under ${s.p95}, max ${s.max} (${s.cells} cells)` : 'no ground or objects in view');
    },
  },
  {
    name: 'mem', group: 'info', usage: 'mem', help: 'memory: JS heap, GPU buffers, cards, map',
    run(app, _x, io) {
      const m = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
      io.print(m ? `JS heap ${(m.usedJSHeapSize / 2 ** 20).toFixed(0)} MB used of ${(m.totalJSHeapSize / 2 ** 20).toFixed(0)} MB` : 'JS heap: not reported by this browser');
      const r = app.viewer.renderer.info;
      io.print(`GPU: ${r.memory.geometries} geometries, ${r.memory.textures} textures, ${r.render.calls} draw calls last frame`);
      const cards = app.viewer.cards.cardCount;
      io.print(`cards loaded ${fmt(cards)} (~${((cards * 16 * 4) / 2 ** 20).toFixed(0)} MB of card data)`);
      if (app.map) io.print(`map: ${app.map.editedChunks} chunks hold edits (~${((app.map.editedChunks * 4096) / 1024).toFixed(0)} KB of tiles), ${app.map.objectCount} objects`);
    },
  },
  {
    name: 'workers', group: 'info', usage: 'workers', help: 'engine workers: queue, builds done, average build time',
    run(app, _x, io) {
      for (const w of app.engine.workerStats()) {
        io.print(`${w.name.padEnd(8)} queue ${String(w.pending).padStart(2)}  done ${String(w.done).padStart(5)}  avg ${w.done ? (w.busyMs / w.done).toFixed(1) : '-'} ms`);
      }
    },
  },
  {
    name: 'seed', group: 'info', usage: 'seed', help: 'the canvas seed and time of day',
    run: (app, _x, io) => io.print(`canvas seed ${app.canvasOptions.seed}, ${app.canvasOptions.day ? 'day' : 'dusk'}`),
  },
  {
    name: 'weather', group: 'info', usage: 'weather', help: 'current wind, rain and blowing leaves',
    run(app, _x, io) {
      const w = app.state.weather;
      io.print(`wind ${w.wind.toFixed(2)}  rain ${w.rain.toFixed(2)}  leaves ${w.leaves.toFixed(2)}`);
    },
  },

  // ---- camera
  {
    name: 'tp', group: 'camera', usage: 'tp <x> <z>', help: 'move the camera to (x, z), same height and view direction',
    run(app, [xs, zs], io) {
      const x = num(xs, 'x'), z = num(zs, 'z');
      const v = app.viewer;
      const dx = x - v.camera.position.x, dz = z - v.camera.position.z;
      v.camera.position.x += dx;
      v.camera.position.z += dz;
      v.controls.target.x += dx;
      v.controls.target.z += dz;
      v.controls.update();
      v.requestRender();
      io.print(`camera at (${f1(x)}, ${f1(z)})`);
    },
  },
  {
    name: 'goto', group: 'camera', usage: 'goto <id>', help: 'fly to a placed object',
    run(app, [id], io) {
      const { map: m } = needWorld(app);
      const o = m.object(num(id, 'id'));
      if (!o) throw new CommandError(`no object #${id}`);
      const v = app.viewer, c = v.camera.position, t = v.controls.target;
      const back = c.clone().sub(t).setY(0);
      if (back.lengthSq() < 1e-6) back.set(0, 0, 1);
      back.normalize().multiplyScalar(14 * o.scale);
      t.set(o.x, 2 * o.scale, o.z);
      c.set(o.x + back.x, 5 * o.scale, o.z + back.z);
      v.controls.update();
      v.requestRender();
      io.print(`looking at #${o.id} ${o.kind}`);
    },
  },
  {
    name: 'look', group: 'camera', usage: 'look <x> <z>', help: 'turn the camera toward a point on the ground',
    run(app, [xs, zs], io) {
      const v = app.viewer;
      v.controls.target.set(num(xs, 'x'), app.world?.info.ground ?? 0, num(zs, 'z'));
      v.controls.update();
      v.requestRender();
      io.print(`looking at (${xs}, ${zs})`);
    },
  },
  {
    name: 'cam', group: 'camera', usage: 'cam [x y z [tx ty tz]] | cam fov <deg>', help: 'show or set camera position, target, field of view',
    run(app, args, io) {
      const v = app.viewer;
      if (args[0] === 'fov') {
        v.camera.fov = num(args[1], 'fov', 10, 120);
        v.camera.updateProjectionMatrix();
      } else if (args.length >= 3) {
        v.camera.position.set(num(args[0], 'x'), num(args[1], 'y'), num(args[2], 'z'));
        if (args.length >= 6) v.controls.target.set(num(args[3], 'tx'), num(args[4], 'ty'), num(args[5], 'tz'));
      } else if (args.length) throw new CommandError('cam: x y z [tx ty tz], or fov <deg>');
      v.controls.update();
      v.requestRender();
      const c = v.camera.position, t = v.controls.target;
      io.print(`camera (${f1(c.x)}, ${f1(c.y)}, ${f1(c.z)})  target (${f1(t.x)}, ${f1(t.y)}, ${f1(t.z)})  fov ${v.camera.fov.toFixed(0)}°`);
    },
  },

  {
    name: 'camera', group: 'camera', usage: 'camera [top|orbit]', help: 'top-down editing view or orbit (also T)',
    run(_app, [m], io, ctx) {
      if (m === undefined) ctx.editor.toggleMode();
      else if (m === 'top' || m === 'orbit') {
        try {
          ctx.editor.setMode(m);
        } catch (e) {
          throw new CommandError(e instanceof Error ? e.message : String(e));
        }
      } else throw new CommandError('camera: top or orbit');
      io.print(`camera ${ctx.editor.mode}`);
    },
  },
  {
    name: 'grid', group: 'camera', usage: 'grid [on|off]', help: 'ground grid (also G)',
    run(_app, [a], io, ctx) {
      if (a === undefined) ctx.editor.setGrid(!ctx.editor.grid);
      else if (a === 'on' || a === 'off') ctx.editor.setGrid(a === 'on');
      else throw new CommandError('grid: on or off');
      io.print(`grid ${ctx.editor.grid ? 'on' : 'off'}`);
    },
  },
  {
    name: 'snap', group: 'camera', usage: `snap [off|${SNAP_STEPS.slice(1).join('|')}]`, help: 'snap the cursor point to a grid of that size (m)',
    run(_app, [a], io, ctx) {
      if (a !== undefined) {
        const n = a === 'off' ? 0 : Number(a);
        if (!SNAP_STEPS.includes(n)) throw new CommandError(`snap: off or ${SNAP_STEPS.slice(1).join(', ')}`);
        ctx.editor.setSnap(n);
      }
      io.print(ctx.editor.snap ? `snap ${ctx.editor.snap} m` : 'snap off');
    },
  },

  // ---- world
  {
    name: 'canvas', group: 'world', usage: 'canvas [seed] [day|dusk]', help: 'show the canvas (edits are kept)',
    async run(app, args, io) {
      let { seed, day } = app.canvasOptions;
      for (const a of args) {
        if (a === 'day' || a === 'dusk') day = a === 'day';
        else seed = num(a, 'seed', 0, 2 ** 32 - 1);
      }
      await app.showCanvas(seed, day);
      io.print(`canvas seed ${seed}, ${day ? 'day' : 'dusk'}`);
    },
  },
  {
    name: 'day', group: 'world', usage: 'day', help: 'daytime light',
    async run(app, _x, io) {
      await app.showCanvas(app.canvasOptions.seed, true);
      io.print('day');
    },
  },
  {
    name: 'dusk', group: 'world', usage: 'dusk', help: 'evening light',
    async run(app, _x, io) {
      await app.showCanvas(app.canvasOptions.seed, false);
      io.print('dusk');
    },
  },
  {
    name: 'time', group: 'world', usage: 'time [seconds]', help: 'show or set the world clock (drives wind, rain, leaves)',
    run(app, [t], io) {
      if (t !== undefined) app.viewer.setClock(num(t, 'seconds', 0));
      io.print(`world clock ${f1(app.viewer.clock)} s, speed x${app.viewer.clockRate}${app.viewer.clockFrozen ? ' (frozen)' : ''}`);
    },
  },
  {
    name: 'speed', group: 'world', usage: 'speed [x]', help: 'world clock speed: 1 real time, 0.25 slow motion, 0 stopped',
    run(app, [x], io) {
      if (x !== undefined) app.viewer.setClockRate(num(x, 'speed', 0, 16));
      io.print(`world clock speed x${app.viewer.clockRate}`);
    },
  },
  {
    name: 'freeze', group: 'world', usage: 'freeze <seconds|off>', help: 'stop the world clock at a time, or let it run',
    run(app, [a], io) {
      if (a === 'off') {
        app.viewer.freezeTime(null);
        io.print('clock running');
        return;
      }
      app.viewer.freezeTime(num(a, 'seconds', 0));
      io.print(`clock frozen at ${a} s`);
    },
  },
  {
    name: 'wind', group: 'world', usage: 'wind <0-1>', help: 'wind strength (sways plants, carries leaves)',
    run(app, [a], io) {
      app.setEnvironment({ wind: amount(a, 'wind', 0.35) });
      io.print(`wind ${app.state.weather.wind.toFixed(2)}`);
    },
  },
  {
    name: 'rain', group: 'world', usage: 'rain <on|off|0-1>', help: 'rain round the camera',
    run(app, [a], io) {
      app.setEnvironment({ rain: amount(a, 'rain') });
      io.print(`rain ${app.state.weather.rain.toFixed(2)}`);
    },
  },
  {
    name: 'leaves', group: 'world', usage: 'leaves <on|off|0-1>', help: 'blowing leaves (they need some wind)',
    run(app, [a], io) {
      app.setEnvironment({ leaves: amount(a, 'leaves', 0.8) });
      io.print(`leaves ${app.state.weather.leaves.toFixed(2)}`);
    },
  },
  {
    name: 'view', group: 'world', usage: 'view [1-16]', help: 'view distance in chunks (fewer = fewer characters)',
    run(app, [n], io) {
      if (n !== undefined) app.setViewRadius(num(n, 'view', 1, 16));
      io.print(`view radius ${app.viewRadius} chunks`);
    },
  },
  {
    name: 'stream', group: 'world', usage: 'stream [on|off]', help: 'off freezes chunk loading and rebuilding (look around a fixed state)',
    run(app, [a], io) {
      const { world: w } = needWorld(app);
      if (a === 'off') w.frozen = true;
      else if (a === 'on') {
        w.frozen = false;
        w.update(app.viewer.camera.position, true);
      } else if (a !== undefined) throw new CommandError('stream: on or off');
      io.print(`streaming ${w.frozen ? 'frozen' : 'on'}`);
    },
  },
  {
    name: 'rebuild', group: 'world', usage: 'rebuild [all | cx cz]', help: 'build chunks again now (default: the one under the camera)',
    run(app, [a, b], io) {
      const { world: w } = needWorld(app);
      const S = w.info.chunkSize, c = app.viewer.camera.position;
      const n = a === 'all' ? w.rebuild('all') : w.rebuild([[a === undefined ? Math.floor(c.x / S) : num(a, 'cx'), b === undefined ? Math.floor(c.z / S) : num(b, 'cz')]]);
      io.print(`${n} chunk${n === 1 ? '' : 's'} queued for rebuilding`);
    },
  },

  // ---- map
  {
    name: 'brush', group: 'map', usage: 'brush [on|off|<ground>|size <m>|shape circle|square|strength <0-1>|soft <0-1>]',
    help: 'the terrain brush (also P): switch it, pick a paint, or set an option',
    run(app, [a, b], io, ctx) {
      const br = ctx.brush;
      const err = (e: unknown) => new CommandError(e instanceof Error ? e.message : String(e));
      try {
        if (a === undefined) br.setActive(!br.active);
        else if (a === 'on' || a === 'off') br.setActive(a === 'on');
        else if (a === 'size') br.setSize(num(b, 'size', 0.25, 32));
        else if (a === 'shape') {
          if (b !== 'circle' && b !== 'square') throw new CommandError('shape: circle or square');
          br.setShape(b);
        } else if (a === 'strength') br.setStrength(num(b, 'strength', 0.05, 1));
        else if (a === 'soft') br.setSoft(num(b, 'soft', 0, 1));
        else br.setKind(a);
      } catch (e) {
        throw e instanceof CommandError ? e : err(e);
      }
      if (br.active === false && !app.world && (a === undefined || a === 'on')) io.print('the brush is for the canvas (command: canvas)', 'err');
      io.print(`brush ${br.active ? 'on' : 'off'}: ${br.kind}, ${br.shape} ${br.radius} m, strength ${br.strength}, soft ${br.soft}`);
    },
  },
  {
    name: 'tool', group: 'map', usage: 'tool [paint|objects|select|height|off]', help: 'the editing tool: terrain brush (P), object brush (O), select (V), height (H)',
    run(app, [t], io, ctx) {
      needWorld(app);
      if (t === 'paint') ctx.brush.setActive(true);
      else if (t === 'objects') ctx.objects.setActive(true);
      else if (t === 'select') ctx.select.setActive(true);
      else if (t === 'height') ctx.height.setActive(true);
      else if (t === 'off') {
        ctx.brush.setActive(false);
        ctx.objects.setActive(false);
        ctx.select.setActive(false);
        ctx.height.setActive(false);
      } else if (t !== undefined) throw new CommandError('tool paint | objects | select | height | off');
      io.print(`tool: ${ctx.brush.active ? 'paint' : ctx.objects.active ? 'objects' : ctx.select.active ? 'select' : ctx.height.active ? 'height' : 'none'}`);
    },
  },
  {
    name: 'objbrush', group: 'map', usage: 'objbrush [on|off|<kind>|mode spray|single|erase|size <m>|density <n>|spacing <x>|variation <v>|stroke x0 z0 x1 z1]',
    help: 'the object brush (also O): switch it, pick a kind or mix (tree:*), set an option, or paint a stroke',
    run(app, args, io, ctx) {
      const t = ctx.objects, [a, b] = args;
      wrap(() => {
        if (a === undefined) t.setActive(!t.active);
        else if (a === 'on' || a === 'off') t.setActive(a === 'on');
        else if (a === 'mode') {
          if (!OBJECT_MODES.includes(b as ObjectMode)) throw new CommandError(`mode: ${OBJECT_MODES.join(', ')}`);
          t.setMode(b as ObjectMode);
        } else if (a === 'size') t.set({ radius: num(b, 'size', 0.5, 64) });
        else if (a === 'density') t.set({ density: num(b, 'density', 0.1, 200) });
        else if (a === 'spacing') t.set({ spacing: num(b, 'spacing', 0.2, 5) });
        else if (a === 'variation') t.set({ variation: num(b, 'variation', 0, 0.8) });
        else if (a === 'stroke') {
          needWorld(app);
          const [x0, z0, x1, z1] = args.slice(1).map((v, i) => num(v, ['x0', 'z0', 'x1', 'z1'][i]!));
          const n = t.strokeLine({ x: x0!, z: z0! }, { x: x1!, z: z1! });
          io.print(`${t.mode}: ${n} object${n === 1 ? '' : 's'} ${t.mode === 'erase' ? 'removed' : 'placed'}`);
        } else t.setKind(a);
      });
      io.print(`object brush ${t.active ? 'on' : 'off'}: ${t.mode} ${t.kind}, ${t.radius} m, density ${t.density}/100 m², spacing x${t.spacing}, size ±${Math.round(t.variation * 100)}%`);
    },
  },
  {
    name: 'param', group: 'map', usage: 'param [<name> <value> | reset]', help: 'generator parameters of the object brush\'s kind: list, set one, or reset',
    run(_app, [name, value], io, ctx) {
      const t = ctx.objects;
      if (name === 'reset') t.resetParams();
      else if (name !== undefined) wrap(() => t.setParam(name, num(value, name)));
      const descs = t.paramDescs();
      if (!descs.length) return io.print(`${t.kind} has no parameters`);
      io.print(`${t.kind}:`, 'info');
      for (const d of descs) {
        const v = t.param(d.name);
        io.print(`${d.name.padEnd(14)} ${(d.step >= 1 ? String(Math.round(v)) : v.toFixed(2)).padStart(6)}   ${d.min}..${d.max}${Math.abs(v - d.default) > 1e-6 ? `   (default ${d.default})` : ''}   ${d.label}`);
      }
    },
  },
  {
    name: 'preset', group: 'map', usage: 'preset [save|load|delete] <name>', help: 'object brush presets: list, save the current kind and parameters, load, delete',
    run(_app, [verb, ...rest], io, ctx) {
      const name = rest.join(' ');
      if (verb === 'save') {
        const p = wrap(() => ctx.presets.save(name, ctx.objects.kind, ctx.objects.changedParams()));
        io.print(`saved preset "${p.name}" (${p.kind}, ${Object.keys(p.values).length} changed parameters)`);
      } else if (verb === 'load') {
        const p = ctx.presets.get(name);
        if (!p) throw new CommandError(`no preset "${name}"`);
        wrap(() => ctx.objects.applyPreset(p));
        io.print(`loaded preset "${p.name}": ${p.kind}`);
      } else if (verb === 'delete') {
        if (!ctx.presets.delete(name)) throw new CommandError(`no preset "${name}"`);
        io.print(`deleted preset "${name}"`);
      } else if (verb === undefined) {
        const all = ctx.presets.list();
        if (!all.length) return io.print('no presets yet (preset save <name>)');
        for (const p of all) io.print(`${p.name.padEnd(24)} ${p.kind.padEnd(18)} ${Object.entries(p.values).map(([k, v]) => `${k}=${v}`).join(' ')}`);
      } else throw new CommandError('preset save|load|delete <name>');
    },
  },
  {
    name: 'height', group: 'map', usage: 'height [on|off|raise|lower|smooth|flatten|size <m>|strength <s>|stroke x0 z0 x1 z1|at <x> <z>]',
    help: 'the height brush (also H): switch it, pick a mode, set an option, shape a stroke, or read the height at a point',
    run(app, args, io, ctx) {
      const t = ctx.height, [a, b] = args;
      if (a === 'at') {
        const { map } = needWorld(app);
        const x = num(b, 'x'), z = num(args[2], 'z');
        return io.print(`ground at (${x}, ${z}): ${map.heightAt(x, z).toFixed(2)} m`);
      }
      wrap(() => {
        if (a === undefined) t.setActive(!t.active);
        else if (a === 'on' || a === 'off') t.setActive(a === 'on');
        else if (HEIGHT_MODES.includes(a as HeightMode)) t.setMode(a as HeightMode);
        else if (a === 'size') t.set({ radius: num(b, 'size', 0.5, 64) });
        else if (a === 'strength') t.set({ strength: num(b, 'strength', 0.01, 10) });
        else if (a === 'stroke') {
          needWorld(app);
          const [x0, z0, x1, z1] = args.slice(1).map((v, i) => num(v, ['x0', 'z0', 'x1', 'z1'][i]!));
          const n = t.strokeLine({ x: x0!, z: z0! }, { x: x1!, z: z1! });
          io.print(`${t.mode}: ${n} height points moved`);
        } else throw new CommandError(`height on|off|${HEIGHT_MODES.join('|')}|size|strength|stroke|at`);
      });
      io.print(`height brush ${t.active ? 'on' : 'off'}: ${t.mode}, ${t.radius} m, strength ${t.strength}`);
    },
  },
  {
    name: 'select', group: 'map', usage: 'select [<id>|none]', help: 'select an object (select tool, V)',
    run(app, [id], io, ctx) {
      needWorld(app);
      if (id === 'none') ctx.select.select(null);
      else if (id !== undefined) {
        ctx.select.setActive(true);
        const n = num(id, 'id');
        if (!app.map!.object(n)) throw new CommandError(`no object #${n}`);
        ctx.select.select(n);
      }
      const o = ctx.select.object();
      io.print(o ? `selected #${o.id} ${o.kind} at (${o.x.toFixed(1)}, ${o.z.toFixed(1)})` : 'nothing selected');
    },
  },
  {
    name: 'move', group: 'map', usage: 'move <id> <x> <z>', help: 'move an object (undoable; keeps its id)',
    run(app, [id, xs, zs], io, ctx) {
      const { map } = needWorld(app);
      ctx.undo.begin(`move #${id}`);
      const o = wrap(() => map.updateObject(num(id, 'id'), { x: num(xs, 'x'), z: num(zs, 'z') }));
      ctx.undo.end();
      if (!o) throw new CommandError(`no object #${id}`);
      io.print(`#${o.id} at (${o.x}, ${o.z})`);
    },
  },
  {
    name: 'rotate', group: 'map', usage: 'rotate <id> <degrees>', help: 'turn an object to an angle (undoable)',
    run(app, [id, deg], io) {
      const o = needWorld(app).map.updateObject(num(id, 'id'), { yaw: (num(deg, 'degrees') * Math.PI) / 180 });
      if (!o) throw new CommandError(`no object #${id}`);
      io.print(`#${o.id} turned to ${deg}°`);
    },
  },
  {
    name: 'resize', group: 'map', usage: 'resize <id> <scale>', help: 'set an object\'s size (1 = normal; undoable)',
    run(app, [id, sc], io) {
      const o = needWorld(app).map.updateObject(num(id, 'id'), { scale: num(sc, 'scale', 0.05, 20) });
      if (!o) throw new CommandError(`no object #${id}`);
      io.print(`#${o.id} size x${o.scale}`);
    },
  },
  {
    name: 'dab', group: 'map', usage: 'dab <x> <z>', help: 'one dab of the current brush at a point',
    run(app, [xs, zs], io, ctx) {
      needWorld(app);
      const n = ctx.brush.strokeLine({ x: num(xs, 'x'), z: num(zs, 'z') }, { x: num(xs, 'x'), z: num(zs, 'z') });
      io.print(`${ctx.brush.kind}: ${n} tile${n === 1 ? '' : 's'} changed`);
    },
  },
  {
    name: 'stroke', group: 'map', usage: 'stroke <x0> <z0> <x1> <z1>', help: 'a brush stroke along a line',
    run(app, [a, b, c, d], io, ctx) {
      needWorld(app);
      const n = ctx.brush.strokeLine({ x: num(a, 'x0'), z: num(b, 'z0') }, { x: num(c, 'x1'), z: num(d, 'z1') });
      io.print(`${ctx.brush.kind}: ${n} tile${n === 1 ? '' : 's'} changed`);
    },
  },
  {
    name: 'paint', group: 'map', usage: 'paint <ground> <x> <z> <radius>', help: 'paint a disc of ground (canvas erases)',
    run(app, [kind, xs, zs, rs], io) {
      const { map: m } = needWorld(app);
      if (!kind || !m.info.groundKinds.includes(kind)) throw new CommandError(`paint: ground is one of ${m.info.groundKinds.join(', ')}`);
      const keys = m.paintCircle(num(xs, 'x'), num(zs, 'z'), num(rs, 'radius', 0, 200), kind);
      io.print(`painted ${kind}: ${keys.length} chunk${keys.length === 1 ? '' : 's'} changed`);
    },
  },
  {
    name: 'fill', group: 'map', usage: 'fill <ground> <x0> <z0> <x1> <z1>', help: 'paint a rectangle of ground',
    run(app, [kind, a, b, c, d], io) {
      const { map: m } = needWorld(app);
      if (!kind || !m.info.groundKinds.includes(kind)) throw new CommandError(`fill: ground is one of ${m.info.groundKinds.join(', ')}`);
      const [x0, z0, x1, z1] = [num(a, 'x0'), num(b, 'z0'), num(c, 'x1'), num(d, 'z1')];
      if (Math.abs(x1 - x0) * Math.abs(z1 - z0) > 512 * 512) throw new CommandError('fill: at most 512 x 512 m at once');
      const keys = m.paintRect(Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1), kind);
      io.print(`filled ${kind}: ${keys.length} chunk${keys.length === 1 ? '' : 's'} changed`);
    },
  },
  {
    name: 'place', group: 'map', usage: 'place <kind> <x> <z> [scale] [seed]', help: 'place an object (see kinds)',
    run(app, [kind, xs, zs, sc, sd], io) {
      const { map: m } = needWorld(app);
      if (!kind || !m.info.objectKinds.includes(kind)) throw new CommandError(`place: unknown kind ${JSON.stringify(kind ?? '')} (see kinds)`);
      const o = m.addObject({
        kind, x: num(xs, 'x'), z: num(zs, 'z'),
        scale: sc === undefined ? undefined : num(sc, 'scale', 0.05, 20),
        seed: sd === undefined ? undefined : num(sd, 'seed', 0),
      });
      io.print(`placed ${o.kind} #${o.id} at (${o.x}, ${o.z}), seed ${o.seed}`);
    },
  },
  {
    name: 'scatter', group: 'map', usage: 'scatter <kind|trees|bushes|plants|rocks|any> <n> <x> <z> <radius>', help: 'place many objects at random in a disc (stress tests)',
    run(app, [kind, ns, xs, zs, rs], io) {
      const { map: m } = needWorld(app);
      const prefix = kind !== undefined ? KIND_GROUPS[kind] : undefined;
      const pool = prefix !== undefined ? m.info.objectKinds.filter((k) => k.startsWith(prefix)) : kind && m.info.objectKinds.includes(kind) ? [kind] : [];
      if (!pool.length) throw new CommandError(`scatter: a kind (see kinds) or one of ${Object.keys(KIND_GROUPS).join(', ')}`);
      const n = num(ns, 'n', 1, 5000), x = num(xs, 'x'), z = num(zs, 'z'), r = num(rs, 'radius', 0, 500);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, d = r * Math.sqrt(Math.random());
        m.addObject({ kind: pool[Math.floor(Math.random() * pool.length)]!, x: x + d * Math.cos(a), z: z + d * Math.sin(a), yaw: Math.random() * Math.PI * 2, scale: 0.8 + Math.random() * 0.4 });
      }
      io.print(`scattered ${n} objects (${pool.length === 1 ? pool[0] : `${pool.length} kinds`}) round (${x}, ${z})`);
    },
  },
  {
    name: 'remove', group: 'map', usage: 'remove <id>', help: 'remove a placed object',
    run(app, [id], io) {
      if (!needWorld(app).map.removeObject(num(id, 'id'))) throw new CommandError(`no object #${id}`);
      io.print(`removed #${id}`);
    },
  },
  {
    name: 'undo', group: 'map', usage: 'undo [n]', help: 'undo the last change (or n of them); also Ctrl+Z',
    run(_app, [n], io, ctx) {
      const done = ctx.undo.undo(n === undefined ? 1 : num(n, 'n', 1, 500));
      io.print(done.length ? done.map((a) => `undone: ${a.label}`).join('\n') : 'nothing to undo');
    },
  },
  {
    name: 'redo', group: 'map', usage: 'redo [n]', help: 'redo what was undone (or n of them); also Ctrl+Y',
    run(_app, [n], io, ctx) {
      const done = ctx.undo.redo(n === undefined ? 1 : num(n, 'n', 1, 500));
      io.print(done.length ? done.map((a) => `redone: ${a.label}`).join('\n') : 'nothing to redo');
    },
  },
  {
    name: 'history', group: 'map', usage: 'history', help: 'what can be undone and redone',
    run(_app, _x, io, ctx) {
      const h = ctx.undo.history;
      if (!h) return io.print('no history yet (show the canvas)');
      const { undo, redo } = h.list();
      if (!undo.length && !redo.length) return io.print('nothing to undo or redo');
      const show = undo.slice(-15);
      if (undo.length > show.length) io.print(`... ${undo.length - show.length} older`, 'dim');
      show.forEach((l, i) => io.print(`${String(undo.length - show.length + i + 1).padStart(3)}  ${l}${i === show.length - 1 ? '   <- Ctrl+Z undoes this' : ''}`));
      for (const l of redo.slice(0, 5)) io.print(`  +  ${l} (undone, Ctrl+Y redoes)`, 'dim');
      io.print(`limits: ${h.maxActions} actions, ${h.maxSize.toLocaleString()} tile changes`, 'dim');
    },
  },
  {
    name: 'clearmap', group: 'map', usage: 'clearmap yes', help: 'wipe every edit (paint and objects); needs "yes" (undo brings it back)',
    run(app, [yes], io) {
      const { map: m } = needWorld(app);
      if (yes !== 'yes') throw new CommandError(`this removes ${m.objectCount} objects and the paint of ${m.editedChunks} chunks; type: clearmap yes`);
      const keys = m.clear();
      io.print(`map cleared (${keys.length} chunks)`);
    },
  },

  // ---- file
  {
    name: 'save', group: 'file', usage: 'save [name]', help: 'save the scene in the browser (default: the current name); also Ctrl+S',
    run(_app, args, io, ctx) {
      const name = args.length ? args.join(' ') : undefined;
      const r = wrap(() => ctx.scenes.save(name));
      io.print(`saved "${r.name}" (${(r.bytes / 1024).toFixed(1)} KB)`);
    },
  },
  {
    name: 'load', group: 'file', usage: 'load <name>', help: 'load a scene saved in the browser (undoable)',
    async run(_app, args, io, ctx) {
      if (!args.length) throw new CommandError('load <name> (see: scenes)');
      const name = args.join(' ');
      try {
        await ctx.scenes.load(name);
      } catch (e) {
        throw new CommandError(e instanceof Error ? e.message : String(e));
      }
      io.print(`loaded "${name}" (Ctrl+Z goes back)`);
    },
  },
  {
    name: 'scenes', group: 'file', usage: 'scenes', help: 'scenes saved in the browser',
    run(_app, _x, io, ctx) {
      const list = ctx.scenes.list(true);
      if (!list.length) return io.print('no saved scenes yet (save <name>)');
      for (const s of list) io.print(`${s.name.padEnd(24)} ${s.saved.slice(0, 16).replace('T', ' ')}  ${(s.bytes / 1024).toFixed(1).padStart(6)} KB${s.name === ctx.scenes.current ? '  <- current' : ''}`);
      io.print(`${AUTOSAVE} is written every 30 s and on closing (autosave ${ctx.scenes.autosave ? 'on' : 'off'})`, 'dim');
    },
  },
  {
    name: 'delete', group: 'file', usage: 'delete <name>', help: 'delete a scene saved in the browser',
    run(_app, args, io, ctx) {
      if (!args.length) throw new CommandError('delete <name>');
      const name = args.join(' ');
      if (!ctx.scenes.delete(name)) throw new CommandError(`no scene called "${name}"`);
      io.print(`deleted "${name}"`);
    },
  },
  {
    name: 'download', group: 'file', usage: 'download [name]', help: 'download the scene (or a saved one) as a .scene.json file',
    run(_app, args, io, ctx) {
      io.print(`downloaded ${wrap(() => ctx.scenes.download(args.length ? args.join(' ') : undefined))}`);
    },
  },
  {
    name: 'upload', group: 'file', usage: 'upload', help: 'load a .scene.json file from your computer (or drop it on the page)',
    run(_app, _x, io, ctx) {
      ctx.scenes.pickFile();
      io.print('pick a .scene.json file', 'dim');
    },
  },
  {
    name: 'export', group: 'file', usage: 'export png | text [columns] | print [columns]', help: 'the view as a PNG, as a .txt of ASCII, or printed here',
    run(_app, [what, cols], io, ctx) {
      const n = cols === undefined ? 120 : num(cols, 'columns', 20, 400);
      if (what === 'png') io.print(`exported ${wrap(() => ctx.scenes.exportPng())}`);
      else if (what === 'text') io.print(`exported ${wrap(() => ctx.scenes.exportText(n))}`);
      else if (what === 'print') ctx.scenes.viewText(n).split('\n').forEach((l) => io.print(l));
      else throw new CommandError('export png | text [columns] | print [columns]');
    },
  },
  {
    name: 'autosave', group: 'file', usage: 'autosave [on|off|now]', help: 'autosave every 30 s and on closing (restored on reload)',
    run(_app, [a], io, ctx) {
      if (a === 'on' || a === 'off') ctx.settings.set('autosave', a);
      else if (a === 'now') io.print(ctx.scenes.autosaveNow() ? 'autosaved' : 'nothing to autosave (show the canvas)');
      else if (a !== undefined) throw new CommandError('autosave on | off | now');
      io.print(`autosave ${ctx.scenes.autosave ? 'on' : 'off'}`);
    },
  },
  {
    name: 'new', group: 'file', usage: 'new', help: 'start an empty scene (the old one: Ctrl+Z, or save it first)',
    run(_app, _x, io, ctx) {
      wrap(() => ctx.scenes.newScene());
      io.print('new empty scene (Ctrl+Z brings the old one back)');
    },
  },

  // ---- debug
  {
    name: 'debug', group: 'debug', usage: 'debug [option [on|off]]', help: 'list the debug overlays, or switch one (same as the menu)',
    run(_app, [id, v], io, ctx) {
      if (!id) {
        for (const o of DEBUG_OPTIONS) io.print(`${ctx.debug.get(o.id) ? '[x]' : '[ ]'} ${o.id.padEnd(12)} ${o.label}${o.key ? `  (${o.key})` : ''}`);
        return;
      }
      if (!ctx.debug.has(id)) throw new CommandError(`no debug option ${JSON.stringify(id)} (type: debug)`);
      if (v === undefined) ctx.debug.toggle(id);
      else if (v === 'on' || v === 'off') ctx.debug.set(id, v === 'on');
      else throw new CommandError('debug: on or off');
      io.print(`${id} ${ctx.debug.get(id) ? 'on' : 'off'}`);
    },
  },
  {
    name: 'set', group: 'debug', usage: 'set [name value]', help: 'list every setting, or change one (same as the menu)',
    run(_app, [name, ...rest], io, ctx) {
      if (!name) {
        for (const s of ctx.settings.list) io.print(`${s.name.padEnd(8)} ${s.get().padEnd(10)} ${s.help}`);
        return;
      }
      if (!rest.length) throw new CommandError(`set ${name} <value>`);
      try {
        ctx.settings.set(name, rest.join(' '));
      } catch (e) {
        throw new CommandError(e instanceof Error ? e.message : String(e));
      }
      io.print(`${name} = ${ctx.settings.find(name)?.get()}`);
    },
  },
  {
    name: 'watch', group: 'debug', usage: 'watch [stat ...|off]', help: 'pin stats to the info box (Tab lists them), e.g. watch fps drawn',
    run(app, args, io, ctx) {
      if (args[0] === 'off') ctx.debug.setWatches([]);
      else if (args.length) {
        const bad = args.filter((a) => !statNames().includes(a));
        if (bad.length) throw new CommandError(`unknown stat ${bad.join(', ')} (one of: ${statNames().join(' ')})`);
        ctx.debug.setWatches([...new Set([...ctx.debug.watches, ...args])]);
      }
      io.print(ctx.debug.watches.length ? `watching ${ctx.debug.watches.map((w) => `${w}=${statValue(app, ctx.cursor, w)}`).join('  ')}` : 'watching nothing');
    },
  },
  {
    name: 'perf', group: 'debug', usage: 'perf [on|off]', help: 'show / hide the performance overlay (also F3)',
    run(_app, [arg], io, ctx) {
      if (arg !== undefined && arg !== 'on' && arg !== 'off') throw new CommandError('perf: on or off');
      if (arg === undefined) ctx.debug.toggle('perf');
      else ctx.debug.set('perf', arg === 'on');
      io.print(`perf overlay ${ctx.debug.get('perf') ? 'on' : 'off'}`);
    },
  },
  {
    name: 'budget', group: 'debug', usage: 'budget [cards|off]', help: 'most cards drawn per frame, e.g. 80k (far chunks thinned); off = no limit',
    run(app, [a], io) {
      const cards = app.viewer.cards;
      if (a !== undefined) {
        try {
          cards.budget = parseCards(a);
        } catch (e) {
          throw new CommandError(`budget: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      app.viewer.requestRender();
      io.print(Number.isFinite(cards.budget) ? `card budget ${fmt(cards.budget)} per frame` : 'no card budget');
    },
  },
  {
    name: 'profile', group: 'debug', usage: 'profile [seconds]', help: 'record frame times (at least 3 frames): min, average, worst 5%, max, histogram',
    async run(app, [s], io) {
      const secs = s === undefined ? 3 : num(s, 'seconds', 0.5, 60);
      app.viewer.requestRender();
      const times: number[] = [];
      await new Promise<void>((done) => {
        let last = performance.now();
        const t0 = last;
        const step = () => {
          const now = performance.now();
          times.push(now - last);
          last = now;
          app.viewer.requestRender();
          // At least a few frames, even if drawing is slower than the time asked for (max 30 s).
          if ((now - t0 < secs * 1000 || times.length < 4) && now - t0 < 30_000) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      times.shift();
      if (!times.length) throw new CommandError('no frames were drawn');
      const sorted = [...times].sort((a, b) => a - b);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const spent = times.reduce((a, b) => a + b, 0) / 1000;
      io.print(`${times.length} frames in ${spent.toFixed(1)} s: ${(1000 / avg).toFixed(1)} fps average`, 'info');
      io.print(`frame time  min ${sorted[0]!.toFixed(1)}  avg ${avg.toFixed(1)}  worst 5% ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(1)}  max ${sorted[sorted.length - 1]!.toFixed(1)} ms`);
      const edges = [8, 16.7, 33.3, 50, 100, Infinity];
      const names = ['<8', '8-17', '17-33', '33-50', '50-100', '>100'];
      const counts = edges.map((e, i) => times.filter((t) => t < e && (i === 0 || t >= edges[i - 1]!)).length);
      const most = Math.max(...counts);
      counts.forEach((n, i) => io.print(`${names[i]!.padStart(6)} ms ${'#'.repeat(Math.round((n / most) * 30)).padEnd(30)} ${n}`));
    },
  },
  {
    name: 'bench', group: 'debug', usage: 'bench', help: 'rebuild every loaded chunk and time it; glyph stacking in this view',
    async run(app, _x, io) {
      const { world: w } = needWorld(app);
      const t0 = performance.now();
      const n = w.rebuild('all');
      await settle(app);
      const ms = performance.now() - t0;
      io.print(`${n} chunks rebuilt in ${(ms / 1000).toFixed(2)} s (${(ms / Math.max(1, n)).toFixed(1)} ms each, ${app.engine.chunkWorkers} workers)`, 'info');
      const s = app.viewer.stacking();
      io.print(`glyphs per screen cell: mean ${s.mean.toFixed(1)}, 95% under ${s.p95}, max ${s.max}`);
      statLines(app).forEach((l) => io.print(l));
    },
  },
  {
    name: 'verify', group: 'debug', usage: 'verify [cx cz]', help: 'build a chunk twice and check both results are identical',
    async run(app, [a, b], io) {
      const { world: w, map: m } = needWorld(app);
      const S = w.info.chunkSize, c = app.viewer.camera.position;
      const cx = a === undefined ? Math.floor(c.x / S) : num(a, 'cx'), cz = b === undefined ? Math.floor(c.z / S) : num(b, 'cz');
      const eye: [number, number, number] = [c.x, c.y, c.z];
      const aspect = glyphAspect();
      const [r1, r2] = await Promise.all([app.engine.worldChunk(cx, cz, eye, aspect, m.payload(cx, cz)), app.engine.worldChunk(cx, cz, eye, aspect, m.payload(cx, cz))]);
      const same = r1.cards.length === r2.cards.length && r1.cards.every((v, i) => v === r2.cards[i] || (Number.isNaN(v) && Number.isNaN(r2.cards[i])));
      let hash = 0;
      for (let i = 0; i < r1.cards.length; i += 7) hash = (hash * 31 + Math.round(r1.cards[i]! * 1000)) | 0;
      if (!same) throw new CommandError(`chunk ${cx},${cz}: the two builds DIFFER (${r1.count} vs ${r2.count} cards)`);
      io.print(`chunk ${cx},${cz}: identical (${r1.count} cards, hash ${(hash >>> 0).toString(16)})`);
    },
  },
  {
    name: 'link', group: 'debug', usage: 'link', help: 'copy a link that brings back this view (seed, camera, settings, debug)',
    async run(_app, _x, io, ctx) {
      const url = ctx.settings.link(ctx.debug);
      const copied = await copyText(url);
      io.print(url);
      io.print(copied ? 'copied to the clipboard' : 'select and copy it from here', 'dim');
    },
  },
  {
    name: 'screenshot', group: 'debug', usage: 'screenshot', help: 'download a PNG of the view',
    run(app, _x, io) {
      const name = `ascii-sandbox-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      download(name, app.viewer.snapshot());
      io.print(`saved ${name}`);
    },
  },

  // ---- terminal
  { name: 'clear', group: 'terminal', usage: 'clear', help: 'clear the terminal', run: (_a, _x, io) => io.clear() },
  {
    name: 'alias', group: 'terminal', usage: 'alias [name [command line]]', help: 'list aliases, or give a command a short name (alias storm wind 1)',
    run(_app, [name, ...rest], io, ctx) {
      const a = ctx.term.aliases;
      if (!name) {
        if (!a.size) io.print('no aliases');
        for (const [k, v] of a) io.print(`${k.padEnd(10)} ${v}`);
        return;
      }
      if (COMMANDS.some((c) => c.name === name)) throw new CommandError(`${name} is a command`);
      if (!rest.length) {
        a.delete(name);
        io.print(`alias ${name} removed`);
      } else {
        a.set(name, rest.join(' '));
        io.print(`${name} = ${rest.join(' ')}`);
      }
      ctx.term.save();
    },
  },
  {
    name: 'bind', group: 'terminal', usage: 'bind [key [command line]]', help: 'list key bindings, or put a command on a key (bind g goto 1)',
    run(_app, [key, ...rest], io, ctx) {
      const b = ctx.term.binds;
      if (!key) {
        if (!b.size) io.print('no key bindings');
        for (const [k, v] of b) io.print(`${k.padEnd(10)} ${v}`);
        return;
      }
      if (!rest.length) {
        b.delete(key);
        io.print(`key ${key} unbound`);
      } else {
        b.set(key, rest.join(' '));
        io.print(`key ${key}: ${rest.join(' ')} (works when no panel is open)`);
      }
      ctx.term.save();
    },
  },
  {
    name: 'repeat', group: 'terminal', usage: 'repeat <n> <command line>', help: 'run a command line n times',
    async run(_app, [ns, ...rest], io, ctx) {
      const n = num(ns, 'n', 1, 1000);
      if (!rest.length) throw new CommandError('repeat <n> <command line>');
      for (let i = 0; i < n; i++) await ctx.term.exec(rest.join(' '));
      io.print(`ran ${n} times`, 'dim');
    },
  },
  {
    name: 'copy', group: 'terminal', usage: 'copy', help: 'copy the previous command\'s output to the clipboard',
    async run(_app, _x, io, ctx) {
      const text = ctx.term.lastOutput.join('\n');
      if (!text) throw new CommandError('nothing to copy');
      io.print((await copyText(text)) ? `copied ${ctx.term.lastOutput.length} lines` : 'the browser refused the clipboard');
    },
  },
  {
    name: 'log', group: 'terminal', usage: 'log save', help: 'download the terminal log as a text file',
    run(_app, [a], io, ctx) {
      if (a !== 'save') throw new CommandError('log save');
      download('ascii-sandbox-log.txt', new Blob([ctx.term.logText()], { type: 'text/plain' }));
      io.print('saved ascii-sandbox-log.txt');
    },
  },

  // ---- scenes
  {
    name: 'model', group: 'scenes', usage: 'model <1-4>', help: `test models: ${TEST_MODELS.join(', ')}`,
    async run(app, [n], io) {
      const i = num(n, 'model', 1, TEST_MODELS.length) - 1;
      const name = TEST_MODELS[Math.floor(i)]!;
      await app.loadUrl(`${import.meta.env.BASE_URL}models/${name}`, name);
      io.print(`model ${name}`);
    },
  },
  {
    name: 'gallery', group: 'scenes', usage: 'gallery <rocks|plants|bushes|trees>', help: 'a sheet of procedural assets',
    async run(app, [c], io) {
      if (!GALLERY_CATEGORIES.includes(c as GalleryCategory)) throw new CommandError(`gallery: one of ${GALLERY_CATEGORIES.join(', ')}`);
      await app.showGallery(c as GalleryCategory);
      io.print(`gallery ${c}`);
    },
  },
];

/** Add a command (dev builds add the testbed ones this way). */
export function registerCommand(c: Command): void {
  if (!COMMANDS.some((x) => x.name === c.name)) COMMANDS.push(c);
}

export function commandNames(): string[] {
  return COMMANDS.map((c) => c.name);
}

/** Words worth completing after a command (kinds, options, keywords). */
function argWords(app: App, cmd: string, ctx: CommandContext | null): string[] {
  const m = app.map?.info;
  switch (cmd) {
    case 'help': return [...commandNames(), ...GROUPS];
    case 'paint': case 'fill': return m?.groundKinds ?? [];
    case 'brush': return ['on', 'off', 'size', 'shape', 'strength', 'soft', ...(m?.groundKinds ?? [])];
    case 'tool': return ['paint', 'objects', 'select', 'height', 'off'];
    case 'height': return ['on', 'off', ...HEIGHT_MODES, 'size', 'strength', 'stroke', 'at'];
    case 'objbrush': return ['on', 'off', 'mode', 'size', 'density', 'spacing', 'variation', 'stroke', ...KIND_MIXES, ...(m?.objectKinds ?? [])];
    case 'select': return ['none'];
    case 'param': return ['reset', ...(ctx?.objects.paramDescs().map((d) => d.name) ?? [])];
    case 'preset': return ['save', 'load', 'delete'];
    case 'place': return m?.objectKinds ?? [];
    case 'scatter': return [...Object.keys(KIND_GROUPS), ...(m?.objectKinds ?? [])];
    case 'gallery': return GALLERY_CATEGORIES;
    case 'perf': case 'rain': case 'leaves': case 'stream': case 'grid': return ['on', 'off'];
    case 'camera': return ['top', 'orbit'];
    case 'snap': return ['off', ...SNAP_STEPS.slice(1).map(String)];
    case 'freeze': return ['off'];
    case 'canvas': return ['day', 'dusk'];
    case 'rebuild': return ['all'];
    case 'debug': return DEBUG_OPTIONS.map((o) => o.id);
    case 'set': return ctx?.settings.list.map((s) => s.name) ?? [];
    case 'watch': return [...statNames(), 'off'];
    case 'log': return ['save'];
    case 'load': case 'delete': case 'download': return ctx?.scenes.list(true).map((s) => s.name) ?? [];
    case 'export': return ['png', 'text', 'print'];
    case 'autosave': return ['on', 'off', 'now'];
    case 'clearmap': return ['yes'];
    default: return [];
  }
}

/** Completions for the word being typed at the end of `line`. */
export function complete(app: App, line: string, ctx: CommandContext | null = null): string[] {
  const words = line.split(/\s+/);
  const last = words[words.length - 1] ?? '';
  const pool = words.length <= 1 ? [...commandNames(), ...(ctx ? [...ctx.term.aliases.keys()] : [])] : argWords(app, words[0]!, ctx);
  return pool.filter((w) => w.startsWith(last));
}

/** Run one command (no `;`, no aliases). Errors are printed, never thrown. */
export async function runCommand(app: App, line: string, io: CommandIO, ctx: CommandContext): Promise<void> {
  const [name, ...args] = line.trim().split(/\s+/);
  if (!name) return;
  const c = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!c) {
    io.print(`unknown command ${JSON.stringify(name)} (try help)`, 'err');
    return;
  }
  try {
    await c.run(app, args, io, ctx);
  } catch (e) {
    io.print(e instanceof Error ? e.message : String(e), 'err');
  }
}
