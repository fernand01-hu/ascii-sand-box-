// Every setting by name, for `set <name> <value>` in the terminal, for
// remembering choices between visits, and for share links (`link`): a URL
// that brings back the seed, camera, settings and debug options.

import { Vector3 } from 'three';
import type { App } from './app';
import type { DebugState } from './debug';

export interface Setting {
  name: string;
  help: string;
  get(): string;
  /** Apply a value typed by the user; throws an Error with a readable message. */
  set(v: string): void;
  /** Remembered between visits. */
  persist?: boolean;
}

const STORE_KEY = 'ascii-sandbox.settings';

function amount(v: string, what: string, max = 1): number {
  if (v === 'on') return max === 1 ? 1 : max;
  if (v === 'off') return 0;
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || n < 0 || n > max) throw new Error(`${what}: a number from 0 to ${max} (or on / off)`);
  return n;
}

function onOff(v: string, what: string): boolean {
  if (['on', 'yes', 'true', '1'].includes(v)) return true;
  if (['off', 'no', 'false', '0'].includes(v)) return false;
  throw new Error(`${what}: on or off`);
}

export function parseCards(v: string): number {
  if (v === 'off') return Infinity;
  const m = /^(\d+(?:\.\d+)?)(k?)$/i.exec(v);
  if (!m) throw new Error('a number of cards like 80000 or 80k, or off');
  return Math.max(1000, Number(m[1]) * (m[2] ? 1000 : 1));
}

export class Settings {
  readonly list: Setting[] = [];
  private saved = '';

  constructor(private app: App) {
    const w = (k: 'wind' | 'rain' | 'leaves', help: string): Setting => ({
      name: k, help, persist: true,
      get: () => app.state.weather[k].toFixed(2),
      set: (v) => app.setEnvironment({ [k]: amount(v, k) }),
    });
    this.add(
      w('wind', 'wind strength 0-1 (sways plants, carries leaves)'),
      w('rain', 'rain 0-1'),
      w('leaves', 'blowing leaves 0-1'),
      {
        name: 'lodfade', help: 'seconds a detail change takes to fade in (0 = swap at once)', persist: true,
        get: () => String(app.viewer.cards.fadeSeconds),
        set: (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 5) throw new Error('lodfade: seconds, 0-5');
          app.viewer.cards.fadeSeconds = n;
        },
      },
      {
        name: 'view', help: 'view distance in chunks, 1-16', persist: true,
        get: () => String(app.viewRadius),
        set: (v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < 1 || n > 16) throw new Error('view: a whole number from 1 to 16');
          app.setViewRadius(n);
        },
      },
      {
        name: 'budget', help: 'most cards drawn per frame (e.g. 80k) or off', persist: true,
        get: () => (Number.isFinite(app.viewer.cards.budget) ? String(app.viewer.cards.budget) : 'off'),
        set: (v) => {
          app.viewer.cards.budget = parseCards(v);
          app.viewer.requestRender();
        },
      },
      {
        name: 'speed', help: 'world clock speed (1 real time, 0.25 slow motion, 0 stopped)', persist: true,
        get: () => String(app.viewer.clockRate),
        set: (v) => app.viewer.setClockRate(amount(v, 'speed', 16)),
      },
      {
        name: 'seed', help: 'canvas seed (sky and clouds)',
        get: () => String(app.canvasOptions.seed),
        set: (v) => {
          if (!/^\d+$/.test(v) || Number(v) > 2 ** 32 - 1) throw new Error('seed: a whole number');
          void app.showCanvas(Number(v), app.canvasOptions.day);
        },
      },
      {
        name: 'day', help: 'daytime on, or off for dusk',
        get: () => (app.canvasOptions.day ? 'on' : 'off'),
        set: (v) => void app.showCanvas(app.canvasOptions.seed, onOff(v, 'day')),
      },
      {
        name: 'stream', help: 'load and rebuild chunks (off freezes them)',
        get: () => (app.world?.frozen ? 'off' : 'on'),
        set: (v) => {
          if (!app.world) throw new Error('show the canvas first');
          app.world.frozen = !onOff(v, 'stream');
          if (!app.world.frozen) app.world.update(app.viewer.camera.position, true);
        },
      },
    );
    window.setInterval(() => this.save(), 2000);
    window.addEventListener('pagehide', () => this.save());
  }

  add(...s: Setting[]): void {
    this.list.push(...s);
  }

  find(name: string): Setting | undefined {
    return this.list.find((s) => s.name === name);
  }

  set(name: string, value: string): void {
    const s = this.find(name);
    if (!s) throw new Error(`no setting ${JSON.stringify(name)} (try: set)`);
    s.set(value);
    this.save();
  }

  /** Remember the persisted settings (only writes when something changed). */
  save(): void {
    const data: Record<string, string> = {};
    for (const s of this.list) if (s.persist) data[s.name] = s.get();
    const json = JSON.stringify(data);
    if (json === this.saved) return;
    this.saved = json;
    try {
      localStorage.setItem(STORE_KEY, json);
    } catch {
      // storage blocked: settings just aren't remembered
    }
  }

  /** Apply what was remembered last visit (call once the canvas is up). */
  restore(): void {
    let data: Record<string, string> = {};
    try {
      data = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, string>;
    } catch {
      return;
    }
    for (const s of this.list) {
      const v = data[s.name];
      if (!s.persist || typeof v !== 'string') continue;
      try {
        s.set(v);
      } catch {
        // a stale or broken value: keep the default
      }
    }
    this.saved = JSON.stringify(data);
  }

  /** A URL that brings back this view: seed, time of day, camera, settings, debug options. */
  link(debug: DebugState): string {
    const a = this.app, c = a.viewer.camera.position, t = a.viewer.controls.target;
    const f = (v: Vector3) => [v.x, v.y, v.z].map((n) => n.toFixed(2)).join(',');
    const p = new URLSearchParams();
    p.set('seed', String(a.canvasOptions.seed));
    if (a.canvasOptions.day) p.set('day', 'on');
    p.set('cam', f(c));
    p.set('target', f(t));
    for (const s of this.list) if (s.persist) p.set(s.name, s.get());
    const dbg = debug.enabled();
    if (dbg.length) p.set('debug', dbg.join(','));
    return `${location.origin}${location.pathname}#${p.toString()}`;
  }

  /** Apply a link's hash (after `#`); returns false if it holds nothing for us. */
  async applyLink(hash: string, debug: DebugState): Promise<boolean> {
    const p = new URLSearchParams(hash.replace(/^#/, ''));
    if (!p.has('seed') && !p.has('cam')) return false;
    const a = this.app;
    const seed = Number(p.get('seed') ?? a.canvasOptions.seed);
    const day = p.get('day') === 'on';
    if (Number.isInteger(seed) && (seed !== a.canvasOptions.seed || day !== a.canvasOptions.day || !a.world)) await a.showCanvas(seed, day);
    for (const s of this.list) {
      const v = p.get(s.name);
      if (s.persist && v !== null) {
        try {
          s.set(v);
        } catch {
          // ignore a broken value in a link
        }
      }
    }
    const vec = (v: string | null) => {
      const n = (v ?? '').split(',').map(Number);
      return n.length === 3 && n.every(Number.isFinite) ? new Vector3(n[0], n[1], n[2]) : null;
    };
    const cam = vec(p.get('cam')), target = vec(p.get('target'));
    const v = a.viewer;
    if (cam) v.camera.position.copy(cam);
    if (target) v.controls.target.copy(target);
    v.controls.update();
    v.requestRender();
    const want = new Set((p.get('debug') ?? '').split(',').filter(Boolean));
    for (const id of want) if (debug.has(id)) debug.set(id, true);
    return true;
  }
}
