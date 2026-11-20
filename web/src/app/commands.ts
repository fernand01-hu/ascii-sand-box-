// Debug terminal commands: plain functions on the app, so the terminal UI,
// the e2e test and the browser console all run exactly the same thing.
// Dev/test builds only (imported from devtools.ts).

import { GALLERY_CATEGORIES, type GalleryCategory } from '../engine/protocol';
import { showPine } from '../testbed/pine';
import type { App } from './app';
import { TEST_MODELS } from './models';

export type LineKind = 'out' | 'info' | 'err';

export interface CommandIO {
  print(text: string, kind?: LineKind): void;
  clear(): void;
  /** Show / hide the performance overlay; returns whether it is now shown. */
  setPerf(on?: boolean): boolean;
}

interface Command {
  name: string;
  usage: string;
  help: string;
  run(app: App, args: string[], io: CommandIO): void | Promise<void>;
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

function needMap(app: App) {
  if (!app.map || !app.world) throw new CommandError('show the canvas first (command: canvas)');
  return app.map;
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(0)}k` : `${Math.round(n)}`);

/** Lines describing frame rate, cards, chunks and workers (the `stats` command and the perf overlay). */
export function statLines(app: App): string[] {
  const v = app.viewer;
  const s = v.stats;
  const q = app.engine.queue();
  const lines = [
    s.fps > 0 ? `fps     ${s.fps.toFixed(s.fps < 10 ? 1 : 0).padStart(4)}   frame ${s.frameMs.toFixed(1)} ms   draw ${s.drawMs.toFixed(1)} ms` : 'fps     idle (nothing changed, nothing redrawn)',
    `cards   ${fmt(s.drawn).padStart(6)} drawn / ${fmt(v.cards.cardCount)} loaded` +
      (Number.isFinite(v.cards.budget) ? `   budget ${fmt(v.cards.budget)}, ${fmt(v.cards.thinned)} left out` : ''),
  ];
  const w = app.world;
  if (w) {
    const perChunk = w.loadedCount ? (v.cards.cardCount / w.loadedCount) : 0;
    lines.push(
      `chunks  ${String(w.loadedCount).padStart(4)} loaded  ${w.pending} building  ${w.dirtyCount} dirty  (view ${w.radius})`,
      `        ~${fmt(perChunk)} cards/chunk   builds ${w.built} (edits ${w.editBuilds}, moves ${w.viewBuilds})`,
    );
  }
  lines.push(`workers main ${q.main}  chunks ${q.chunks.length ? q.chunks.join(' ') : '-'}`);
  return lines;
}

const COMMANDS: Command[] = [
  {
    name: 'help', usage: 'help [command]', help: 'list commands, or explain one',
    run(_app, [name], io) {
      if (name) {
        const c = COMMANDS.find((c) => c.name === name);
        if (!c) throw new CommandError(`no command ${JSON.stringify(name)}`);
        io.print(`${c.usage}`, 'info');
        io.print(`  ${c.help}`);
        return;
      }
      const w = Math.max(...COMMANDS.map((c) => c.usage.length));
      for (const c of COMMANDS) io.print(`${c.usage.padEnd(w)}  ${c.help}`);
      io.print('keys: ` or F1 open/close, Esc close, Up/Down history, Tab complete, F3 perf overlay', 'info');
    },
  },
  { name: 'clear', usage: 'clear', help: 'clear the terminal', run: (_a, _x, io) => io.clear() },
  {
    name: 'stats', usage: 'stats', help: 'frame rate, cards, chunks and worker queues',
    run: (app, _x, io) => statLines(app).forEach((l) => io.print(l)),
  },
  {
    name: 'perf', usage: 'perf [on|off]', help: 'show / hide the performance overlay (also F3)',
    run(_app, [arg], io) {
      if (arg !== undefined && arg !== 'on' && arg !== 'off') throw new CommandError('perf: on or off');
      io.print(`perf overlay ${io.setPerf(arg === undefined ? undefined : arg === 'on') ? 'on' : 'off'}`);
    },
  },
  {
    name: 'stack', usage: 'stack', help: 'how many glyphs pile up on one spot of the screen (per 16 px cell)',
    run(app, _x, io) {
      const s = app.viewer.stacking();
      io.print(s.cells ? `glyphs per screen cell: mean ${s.mean.toFixed(1)}, 95% under ${s.p95}, max ${s.max} (${s.cells} cells)` : 'no ground or objects in view');
    },
  },
  {
    name: 'budget', usage: 'budget [cards|off]', help: 'most cards drawn per frame, e.g. 80k (far chunks thinned); off = no limit',
    run(app, [a], io) {
      const cards = app.viewer.cards;
      if (a === 'off') cards.budget = Infinity;
      else if (a !== undefined) {
        const m = /^(\d+(?:\.\d+)?)(k?)$/i.exec(a);
        if (!m) throw new CommandError('budget: a number of cards like 80000 or 80k, or off');
        cards.budget = Math.max(1000, Number(m[1]) * (m[2] ? 1000 : 1));
      }
      app.viewer.requestRender();
      io.print(Number.isFinite(cards.budget) ? `card budget ${fmt(cards.budget)} per frame` : 'no card budget');
    },
  },
  {
    name: 'chunks', usage: 'chunks', help: 'chunk streaming and what the map holds',
    run(app, _x, io) {
      const w = app.world;
      if (!w) throw new CommandError('show the canvas first (command: canvas)');
      const m = w.map;
      io.print(`loaded ${w.loadedCount}, building ${w.pending}, dirty ${w.dirtyCount}, view radius ${w.radius} chunks (${w.info.chunkSize} m each)`);
      io.print(`built ${w.built} in all: ${w.editBuilds} after edits, ${w.viewBuilds} after camera moves`);
      io.print(`map: ${m.editedChunks} chunks hold edits, ${m.objectCount} objects`);
    },
  },
  {
    name: 'view', usage: 'view [1-16]', help: 'view distance in chunks (fewer = fewer characters)',
    run(app, [n], io) {
      if (n !== undefined) app.setViewRadius(num(n, 'view', 1, 16));
      io.print(`view radius ${app.viewRadius} chunks`);
    },
  },
  {
    name: 'pos', usage: 'pos', help: 'camera position, orbit target and chunk',
    run(app, _x, io) {
      const c = app.viewer.camera.position, t = app.viewer.controls.target;
      const S = app.world?.info.chunkSize ?? 32;
      io.print(`camera (${c.x.toFixed(1)}, ${c.y.toFixed(1)}, ${c.z.toFixed(1)})  target (${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})  chunk ${Math.floor(c.x / S)},${Math.floor(c.z / S)}`);
    },
  },
  {
    name: 'tp', usage: 'tp <x> <z>', help: 'move the camera to (x, z), same height and view direction',
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
      io.print(`camera at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    },
  },
  {
    name: 'canvas', usage: 'canvas [seed] [day|dusk]', help: 'show the canvas (edits are kept)',
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
    name: 'seed', usage: 'seed', help: 'the canvas seed and time of day',
    run: (app, _x, io) => io.print(`canvas seed ${app.canvasOptions.seed}, ${app.canvasOptions.day ? 'day' : 'dusk'}`),
  },
  {
    name: 'weather', usage: 'weather', help: 'current wind, rain and blowing leaves',
    run(app, _x, io) {
      const w = app.state.weather;
      io.print(`wind ${w.wind.toFixed(2)}  rain ${w.rain.toFixed(2)}  leaves ${w.leaves.toFixed(2)}`);
    },
  },
  {
    name: 'wind', usage: 'wind <0-1>', help: 'wind strength (sways plants, carries leaves)',
    run(app, [a], io) {
      app.setEnvironment({ wind: amount(a, 'wind', 0.35) });
      io.print(`wind ${app.state.weather.wind.toFixed(2)}`);
    },
  },
  {
    name: 'rain', usage: 'rain <on|off|0-1>', help: 'rain round the camera',
    run(app, [a], io) {
      app.setEnvironment({ rain: amount(a, 'rain') });
      io.print(`rain ${app.state.weather.rain.toFixed(2)}`);
    },
  },
  {
    name: 'leaves', usage: 'leaves <on|off|0-1>', help: 'blowing leaves (they need some wind)',
    run(app, [a], io) {
      app.setEnvironment({ leaves: amount(a, 'leaves', 0.8) });
      io.print(`leaves ${app.state.weather.leaves.toFixed(2)}`);
    },
  },
  {
    name: 'freeze', usage: 'freeze <seconds|off>', help: 'stop the animation clock at a time, or let it run',
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
    name: 'kinds', usage: 'kinds', help: 'ground paints and object kinds',
    run(app, _x, io) {
      const m = needMap(app);
      io.print(`ground: ${m.info.groundKinds.join(' ')}`);
      io.print(`objects: ${m.info.objectKinds.join(' ')}`);
    },
  },
  {
    name: 'paint', usage: 'paint <ground> <x> <z> <radius>', help: 'paint a disc of ground (canvas erases)',
    run(app, [kind, xs, zs, rs], io) {
      const m = needMap(app);
      if (!kind || !m.info.groundKinds.includes(kind)) throw new CommandError(`paint: ground is one of ${m.info.groundKinds.join(', ')}`);
      const keys = m.paintCircle(num(xs, 'x'), num(zs, 'z'), num(rs, 'radius', 0, 200), kind);
      io.print(`painted ${kind}: ${keys.length} chunk${keys.length === 1 ? '' : 's'} changed`);
    },
  },
  {
    name: 'place', usage: 'place <kind> <x> <z> [scale] [seed]', help: 'place an object (see kinds)',
    run(app, [kind, xs, zs, sc, sd], io) {
      const m = needMap(app);
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
    name: 'objects', usage: 'objects', help: 'list placed objects (nearest 20)',
    run(app, _x, io) {
      const m = needMap(app);
      const c = app.viewer.camera.position;
      const all = m.allObjects().sort((a, b) => Math.hypot(a.x - c.x, a.z - c.z) - Math.hypot(b.x - c.x, b.z - c.z));
      if (all.length === 0) io.print('no objects');
      for (const o of all.slice(0, 20)) io.print(`#${o.id}  ${o.kind.padEnd(22)} (${o.x.toFixed(1)}, ${o.z.toFixed(1)})  scale ${o.scale}  seed ${o.seed}`);
      if (all.length > 20) io.print(`... and ${all.length - 20} more`, 'info');
    },
  },
  {
    name: 'remove', usage: 'remove <id>', help: 'remove a placed object',
    run(app, [id], io) {
      if (!needMap(app).removeObject(num(id, 'id'))) throw new CommandError(`no object #${id}`);
      io.print(`removed #${id}`);
    },
  },
  {
    name: 'model', usage: 'model <1-4>', help: `test models: ${TEST_MODELS.join(', ')}`,
    async run(app, [n], io) {
      const i = num(n, 'model', 1, TEST_MODELS.length) - 1;
      const name = TEST_MODELS[Math.floor(i)]!;
      await app.loadUrl(`${import.meta.env.BASE_URL}models/${name}`, name);
      io.print(`model ${name}`);
    },
  },
  {
    name: 'gallery', usage: 'gallery <rocks|plants|bushes|trees>', help: 'a sheet of procedural assets',
    async run(app, [c], io) {
      if (!GALLERY_CATEGORIES.includes(c as GalleryCategory)) throw new CommandError(`gallery: one of ${GALLERY_CATEGORIES.join(', ')}`);
      await app.showGallery(c as GalleryCategory);
      io.print(`gallery ${c}`);
    },
  },
  {
    name: 'pine', usage: 'pine', help: 'the testbed pine',
    async run(app, _x, io) {
      await showPine(app);
      io.print('testbed pine');
    },
  },
];

export const COMMAND_NAMES = COMMANDS.map((c) => c.name);

/** Words worth completing after a command (kinds, keywords). */
function argWords(app: App, cmd: string): string[] {
  const m = app.map?.info;
  switch (cmd) {
    case 'help': return COMMAND_NAMES;
    case 'paint': return m?.groundKinds ?? [];
    case 'place': return m?.objectKinds ?? [];
    case 'gallery': return GALLERY_CATEGORIES;
    case 'perf': return ['on', 'off'];
    case 'rain': case 'leaves': return ['on', 'off'];
    case 'freeze': return ['off'];
    case 'canvas': return ['day', 'dusk'];
    default: return [];
  }
}

/** Completions for the word being typed at the end of `line`. */
export function complete(app: App, line: string): string[] {
  const words = line.split(/\s+/);
  const last = words[words.length - 1] ?? '';
  const pool = words.length <= 1 ? COMMAND_NAMES : argWords(app, words[0]!);
  return pool.filter((w) => w.startsWith(last));
}

/** Run one command line. Errors are printed, never thrown. */
export async function runCommand(app: App, line: string, io: CommandIO): Promise<void> {
  const [name, ...args] = line.trim().split(/\s+/);
  if (!name) return;
  const c = COMMANDS.find((c) => c.name === name.toLowerCase());
  if (!c) {
    io.print(`unknown command ${JSON.stringify(name)} (try help)`, 'err');
    return;
  }
  try {
    await c.run(app, args, io);
  } catch (e) {
    io.print(e instanceof Error ? e.message : String(e), 'err');
  }
}
