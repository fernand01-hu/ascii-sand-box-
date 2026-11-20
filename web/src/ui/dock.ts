// The options sidebar: one box (right side by default) holding the options
// of the tool that is on: terrain brush, object brush with its parameters
// and preview, height brush, selection. Tab or the toolbar's options button
// shows / hides it; drag its title to move it anywhere (double-click puts it
// back). Whether it is shown is remembered.

import { makeMovable } from './drag';
import { addRootKeys } from './widgets';
import './tui.css';

const KEY = 'ascii-sandbox.dock';

export class Dock {
  readonly el: HTMLDivElement;
  /** Tool panels go in here (Panel option `docked`). */
  readonly body: HTMLDivElement;
  private hint: HTMLDivElement;
  private listeners = new Set<() => void>();

  constructor(root: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'tui tui-box tui-dock';
    const title = document.createElement('div');
    title.className = 'tui-title';
    title.textContent = 'options';
    const close = document.createElement('div');
    close.className = 'tui-hint tui-dock-close';
    close.textContent = 'Tab hide ×';
    close.addEventListener('click', () => this.show(false));
    this.hint = document.createElement('div');
    this.hint.className = 'tui-dim tui-dock-empty';
    this.hint.textContent = 'Pick a tool in the toolbar (or press V, P, O, H) and its options show here.';
    this.body = document.createElement('div');
    this.body.className = 'tui-dock-body';
    this.body.append(this.hint);
    this.el.append(title, close, this.body);
    for (const type of ['pointerdown', 'wheel', 'contextmenu'] as const) this.el.addEventListener(type, (e) => e.stopPropagation());
    root.appendChild(this.el);
    makeMovable(this.el, title, 'dock');
    let shown = true;
    try {
      shown = localStorage.getItem(KEY) !== 'hidden';
    } catch {
      // storage blocked: shown
    }
    this.el.hidden = !shown;
    addRootKeys((e) => {
      if (e.key !== 'Tab' || e.shiftKey) return false;
      this.toggle();
      return true;
    });
    // Show the hint only when no tool panel is open in here.
    new MutationObserver(() => this.refreshHint()).observe(this.body, { subtree: true, attributes: true, attributeFilter: ['hidden'], childList: true });
    this.refreshHint();
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
    try {
      localStorage.setItem(KEY, on ? 'shown' : 'hidden');
    } catch {
      // storage blocked
    }
    for (const f of this.listeners) f();
  }

  toggle(): void {
    this.show(!this.shown);
  }

  onChange(f: () => void): void {
    this.listeners.add(f);
  }

  private refreshHint(): void {
    const any = [...this.body.children].some((c) => c !== this.hint && !(c as HTMLElement).hidden);
    // Only when it really changes: setting it again would wake the observer
    // watching these attributes, forever.
    if (this.hint.hidden !== any) this.hint.hidden = any;
  }
}
