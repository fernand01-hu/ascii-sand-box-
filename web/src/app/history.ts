// Undo / redo. The history records edits and groups them into actions: one
// brush stroke, one terminal line, one menu command. Undo plays an action's
// edits backwards, redo forwards. A new action after an undo drops what
// could have been redone. The oldest actions go once there are more than
// `maxActions` or their edits weigh more than `maxSize`.
//
// Generic over the edit type, with the map's undo rules below; no runtime
// imports, so it can be unit-tested with node --test.

import type { MapData, MapEdit } from './map';

export interface Action<E> {
  label: string;
  edits: E[];
  /** Weight, for the memory limit (e.g. tiles changed). */
  size: number;
}

export interface Applier<E> {
  /** Undo these edits (given in the order they happened). */
  undo(edits: E[]): void;
  redo(edits: E[]): void;
}

export interface HistoryOptions<E> {
  maxActions?: number;
  maxSize?: number;
  sizeOf?: (e: E) => number;
  /** Label for an edit made outside any group. */
  labelOf?: (e: E) => string;
}

export class History<E> {
  private done: Action<E>[] = [];
  private undone: Action<E>[] = [];
  private open: Action<E> | null = null;
  private depth = 0;
  private listeners = new Set<() => void>();
  /** True while undoing or redoing: edits made then are not recorded. */
  applying = false;
  readonly maxActions: number;
  readonly maxSize: number;
  private sizeOf: (e: E) => number;
  private labelOf: (e: E) => string;

  private applier: Applier<E>;

  constructor(applier: Applier<E>, o: HistoryOptions<E> = {}) {
    this.applier = applier;
    this.maxActions = o.maxActions ?? 500;
    this.maxSize = o.maxSize ?? 2_000_000;
    this.sizeOf = o.sizeOf ?? (() => 1);
    this.labelOf = o.labelOf ?? (() => 'edit');
  }

  /** Called whenever what can be undone / redone changes. */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }

  /** Start grouping edits into one action (groups nest; the outermost label wins). */
  begin(label: string): void {
    if (this.depth++ === 0) this.open = { label, edits: [], size: 0 };
  }

  /** Close the group; it becomes one action if anything was edited. */
  end(): void {
    if (this.depth === 0) return;
    if (--this.depth > 0) return;
    const a = this.open;
    this.open = null;
    if (a && a.edits.length) this.push(a);
  }

  /** Rename the open group (e.g. once a stroke knows how many tiles it painted). */
  relabel(label: string): void {
    if (this.open) this.open.label = label;
  }

  /** Record an edit: into the open group, or as an action of its own. */
  record(edit: E): void {
    if (this.applying) return;
    if (this.open) {
      this.open.edits.push(edit);
      this.open.size += this.sizeOf(edit);
      return;
    }
    this.push({ label: this.labelOf(edit), edits: [edit], size: this.sizeOf(edit) });
  }

  private push(a: Action<E>): void {
    this.done.push(a);
    this.undone = [];
    let total = this.done.reduce((t, x) => t + x.size, 0);
    while (this.done.length > 1 && (this.done.length > this.maxActions || total > this.maxSize)) total -= this.done.shift()!.size;
    this.changed();
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** Undo the last action; returns it (null if there was none). */
  undo(): Action<E> | null {
    this.end(); // an unfinished group closes first
    const a = this.done.pop();
    if (!a) return null;
    this.run(() => this.applier.undo(a.edits));
    this.undone.push(a);
    this.changed();
    return a;
  }

  /** Redo the last undone action; returns it (null if there was none). */
  redo(): Action<E> | null {
    const a = this.undone.pop();
    if (!a) return null;
    this.run(() => this.applier.redo(a.edits));
    this.done.push(a);
    this.changed();
    return a;
  }

  private run(f: () => void): void {
    this.applying = true;
    try {
      f();
    } finally {
      this.applying = false;
    }
  }

  /** Labels, oldest first: what can be undone, then what can be redone (latest undone first). */
  list(): { undo: string[]; redo: string[] } {
    return { undo: this.done.map((a) => a.label), redo: [...this.undone].reverse().map((a) => a.label) };
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.changed();
  }
}

// ---- the map's undo rules ------------------------------------------------------

/** Undo / redo map edits: tiles back to their old codes, objects removed or put back. */
export function mapApplier(map: Pick<MapData, 'setTiles' | 'removeObject' | 'restoreObject'>): Applier<MapEdit> {
  return {
    undo(edits) {
      for (let k = edits.length - 1; k >= 0; k--) {
        const e = edits[k]!;
        for (const o of e.added ?? []) map.removeObject(o.id);
        if (e.tiles?.length) map.setTiles([...e.tiles].reverse().map((c) => ({ gi: c.gi, gj: c.gj, code: c.from })));
        for (const o of e.removed ?? []) map.restoreObject(o);
      }
    },
    redo(edits) {
      for (const e of edits) {
        for (const o of e.removed ?? []) map.removeObject(o.id);
        if (e.tiles?.length) map.setTiles(e.tiles.map((c) => ({ gi: c.gi, gj: c.gj, code: c.to })));
        for (const o of e.added ?? []) map.restoreObject(o);
      }
    },
  };
}

export function mapEditSize(e: MapEdit): number {
  return (e.tiles?.length ?? 0) + (e.added?.length ?? 0) + (e.removed?.length ?? 0);
}

export function mapEditLabel(e: MapEdit): string {
  if (e.added?.length === 1 && !e.tiles?.length && !e.removed?.length) return `place ${e.added[0]!.kind}`;
  if (e.removed?.length === 1 && !e.tiles?.length && !e.added?.length) return `remove ${e.removed[0]!.kind}`;
  const parts: string[] = [];
  if (e.tiles?.length) parts.push(`${e.tiles.length} tiles`);
  if (e.added?.length) parts.push(`+${e.added.length} objects`);
  if (e.removed?.length) parts.push(`-${e.removed.length} objects`);
  return parts.join(', ') || 'edit';
}

/** The undo history for a map: records its edits, undoes them with the map's rules. */
export function mapHistory(map: MapData, o: Omit<HistoryOptions<MapEdit>, 'sizeOf' | 'labelOf'> = {}): History<MapEdit> {
  const h = new History<MapEdit>(mapApplier(map), { ...o, sizeOf: mapEditSize, labelOf: mapEditLabel });
  map.onEdit((e) => h.record(e));
  return h;
}
