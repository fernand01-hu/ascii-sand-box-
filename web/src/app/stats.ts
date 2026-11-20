// Named live numbers about the app: the `stats` lines (terminal, perf
// overlay) and the stats `watch` can pin to the info box. No imports from
// the UI or the commands, so anything can use it.

import type { App } from './app';
import type { Cursor } from './cursor';

const f1 = (n: number) => n.toFixed(1);
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
      `chunks  ${String(w.loadedCount).padStart(4)} loaded  ${w.pending} building  ${w.dirtyCount} dirty  (view ${w.radius})${w.frozen ? ' FROZEN' : ''}`,
      `        ~${fmt(perChunk)} cards/chunk   builds ${w.built} (edits ${w.editBuilds}, moves ${w.viewBuilds})`,
    );
  }
  lines.push(`workers main ${q.main}  chunks ${q.chunks.length ? q.chunks.join(' ') : '-'}`);
  return lines;
}

/** Stats `watch` can pin to the info box, by name. */
export function statNames(): string[] {
  return Object.keys(STATS);
}

const STATS: Record<string, (app: App, cursor: Cursor) => string> = {
  fps: (a) => a.viewer.stats.fps.toFixed(1),
  frame: (a) => `${a.viewer.stats.frameMs.toFixed(1)} ms`,
  draw: (a) => `${a.viewer.stats.drawMs.toFixed(1)} ms`,
  drawn: (a) => fmt(a.viewer.stats.drawn),
  loaded: (a) => fmt(a.viewer.cards.cardCount),
  chunks: (a) => String(a.world?.loadedCount ?? 0),
  building: (a) => String(a.world?.pending ?? 0),
  dirty: (a) => String(a.world?.dirtyCount ?? 0),
  objects: (a) => String(a.map?.objectCount ?? 0),
  edited: (a) => String(a.map?.editedChunks ?? 0),
  clock: (a) => `${f1(a.viewer.clock)} s`,
  speed: (a) => `x${a.viewer.clockRate}`,
  heap: () => {
    const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return m ? `${(m.usedJSHeapSize / 2 ** 20).toFixed(0)} MB` : 'n/a';
  },
  cursor: (_a, c) => {
    const g = c.ground();
    return g ? `${f1(g.x)}, ${f1(g.z)}` : '-';
  },
};

export function statValue(app: App, cursor: Cursor, name: string): string | null {
  const f = STATS[name];
  return f ? f(app, cursor) : null;
}
