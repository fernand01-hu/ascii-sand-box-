// Named presets for the object brush: a kind (or mix) and its parameter
// values, e.g. "my tall birch". Kept in the browser.

const KEY = 'ascii-sandbox.presets';

export interface Preset {
  name: string;
  /** "tree:birch" or a mix like "tree:*". */
  kind: string;
  values: Record<string, number>;
}

export class PresetStore {
  private listeners = new Set<() => void>();

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  list(kind?: string): Preset[] {
    let all: Preset[] = [];
    try {
      all = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Preset[];
    } catch {
      all = [];
    }
    all = all.filter((p) => p && typeof p.name === 'string' && typeof p.kind === 'string' && p.values && typeof p.values === 'object');
    return (kind ? all.filter((p) => p.kind === kind) : all).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Preset | undefined {
    return this.list().find((p) => p.name === name);
  }

  save(name: string, kind: string, values: Record<string, number>): Preset {
    const n = name.trim();
    if (!/^[\w][\w .-]{0,39}$/.test(n)) throw new Error('a preset name is 1-40 letters, digits, spaces, dots, dashes or underscores');
    const p: Preset = { name: n, kind, values: { ...values } };
    this.write([...this.list().filter((x) => x.name !== n), p]);
    return p;
  }

  delete(name: string): boolean {
    const all = this.list();
    const rest = all.filter((p) => p.name !== name);
    if (rest.length === all.length) return false;
    this.write(rest);
    return true;
  }

  private write(all: Preset[]): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      throw new Error('the browser storage is full or blocked');
    }
    for (const f of this.listeners) f();
  }
}
