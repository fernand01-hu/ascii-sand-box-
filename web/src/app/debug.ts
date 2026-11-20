// The debug options: one list that the menu (Debug panel), the terminal
// (`debug <option> on|off`), hotkeys and share links all read and write, so
// they always agree. A new option added here gets a menu checkbox and a
// terminal switch by itself. Choices are remembered between visits.

export interface DebugOption {
  id: string;
  label: string;
  /** Hotkey, shown in the menu. */
  key?: string;
}

export const DEBUG_OPTIONS: readonly DebugOption[] = [
  { id: 'info', label: 'info box: position, chunk, facing, clock', key: 'F2' },
  { id: 'cursor', label: 'cursor: the ground under the mouse' },
  { id: 'chunks', label: 'chunk borders (colour = state)', key: 'F4' },
  { id: 'chunkLabels', label: 'chunk coordinates' },
  { id: 'objects', label: 'object labels (#id kind)' },
  { id: 'outlines', label: 'object outlines (footprint + box)' },
  { id: 'tiles', label: 'paint tile grid near the cursor' },
  { id: 'culling', label: 'culling boxes (16 m render chunks)' },
  { id: 'axes', label: 'origin and axes' },
  { id: 'bodies', label: 'hidden solid shapes (wireframe)' },
  { id: 'light', label: 'light view: sun white, sky blue' },
  { id: 'size', label: 'glyph size tint' },
  { id: 'heat', label: 'stacking heat map' },
  { id: 'inspector', label: 'glyph inspector (point the mouse)' },
  { id: 'perf', label: 'performance overlay', key: 'F3' },
  { id: 'rebuilds', label: 'log every chunk rebuild' },
];

/** Options that colour the glyphs: only one at a time. */
const EXCLUSIVE = [['light', 'size']];

const STORE_KEY = 'ascii-sandbox.debug';

export class DebugState {
  private values = new Map<string, boolean>();
  private listeners = new Set<(id: string, on: boolean) => void>();
  /** Stats pinned to the info box (`watch`). */
  watches: string[] = [];

  constructor(private persist = true) {
    if (persist) this.load();
  }

  has(id: string): boolean {
    return DEBUG_OPTIONS.some((o) => o.id === id);
  }

  get(id: string): boolean {
    return this.values.get(id) ?? false;
  }

  /** The options that are on. */
  enabled(): string[] {
    return DEBUG_OPTIONS.filter((o) => this.get(o.id)).map((o) => o.id);
  }

  set(id: string, on: boolean): void {
    if (!this.has(id)) throw new Error(`no debug option ${JSON.stringify(id)}`);
    if (this.get(id) === on) return;
    if (on) for (const group of EXCLUSIVE) if (group.includes(id)) for (const other of group) if (other !== id) this.set(other, false);
    this.values.set(id, on);
    this.save();
    for (const f of this.listeners) f(id, on);
  }

  toggle(id: string): boolean {
    this.set(id, !this.get(id));
    return this.get(id);
  }

  setWatches(w: string[]): void {
    this.watches = w;
    this.save();
    for (const f of this.listeners) f('watch', w.length > 0);
  }

  /** Called with (option, on) whenever one changes. */
  onChange(f: (id: string, on: boolean) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { on?: string[]; watches?: string[] };
      for (const id of v.on ?? []) if (this.has(id)) this.values.set(id, true);
      this.watches = (v.watches ?? []).filter((w) => typeof w === 'string');
    } catch {
      // storage blocked or corrupt: start with everything off
    }
  }

  private save(): void {
    if (!this.persist) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ on: this.enabled(), watches: this.watches }));
    } catch {
      // storage blocked: choices just aren't remembered
    }
  }
}
