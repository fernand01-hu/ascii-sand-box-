// Undo / redo for the canvas: Ctrl+Z undoes, Ctrl+Y or Ctrl+Shift+Z redoes
// (Cmd on a Mac). Anything that changes the map is recorded (brush strokes,
// place, remove, scatter, fill, paint, clearmap); one brush stroke or one
// terminal line is one action. In a text field the keys keep their usual
// meaning. The history itself is app/history.ts.

import type { App } from './app';
import type { BrushTool } from './brushtool';
import { mapHistory, type Action, type History } from './history';
import type { MapEdit } from './map';

export type UndoListener = (verb: 'undo' | 'redo', action: Action<MapEdit>) => void;

export class Undo {
  history: History<MapEdit> | null = null;
  private applied = new Set<UndoListener>();
  private changeListeners = new Set<() => void>();

  constructor(app: App, private brush: BrushTool) {
    const attach = () => {
      if (this.history || !app.map) return;
      this.history = mapHistory(app.map);
      this.history.onChange(() => this.changeListeners.forEach((f) => f()));
      this.changeListeners.forEach((f) => f());
    };
    app.onSceneChange(attach);
    attach();
    // A brush stroke is one action, labelled once it knows what it did.
    brush.group = {
      begin: (label) => this.begin(label),
      end: (label) => {
        if (label) this.history?.relabel(label);
        this.end();
      },
    };
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return; // text undo stays text undo
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) this.undo();
      else if (k === 'y' || (k === 'z' && e.shiftKey)) this.redo();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  /** Called after each undo or redo with what it did (status bar). */
  onApplied(f: UndoListener): () => void {
    this.applied.add(f);
    return () => this.applied.delete(f);
  }

  /** Called whenever what can be undone / redone changes (menu, terminal). */
  onChange(f: () => void): () => void {
    this.changeListeners.add(f);
    return () => this.changeListeners.delete(f);
  }

  begin(label: string): void {
    this.history?.begin(label);
  }

  end(): void {
    this.history?.end();
  }

  /** Undo up to `n` actions; returns those undone (most recent first). */
  undo(n = 1): Action<MapEdit>[] {
    return this.step('undo', n);
  }

  redo(n = 1): Action<MapEdit>[] {
    return this.step('redo', n);
  }

  private step(verb: 'undo' | 'redo', n: number): Action<MapEdit>[] {
    const h = this.history;
    if (!h) return [];
    this.brush.end(); // a stroke in progress finishes first
    const out: Action<MapEdit>[] = [];
    for (let k = 0; k < n; k++) {
      const a = verb === 'undo' ? h.undo() : h.redo();
      if (!a) break;
      out.push(a);
      for (const f of this.applied) f(verb, a);
    }
    return out;
  }
}
