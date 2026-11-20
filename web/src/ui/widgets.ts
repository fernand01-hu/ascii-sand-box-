// TUI widgets: the building blocks of every panel (menu, settings, help,
// debug terminal, later the brush panel and save dialog). No framework:
// each widget owns a small DOM element styled by tui.css and handles its
// own keys.
//
// Keyboard first, like an old terminal game:
//   Up / Down / Tab   move between rows (a list moves inside itself first)
//   Left / Right      change a slider (Shift: bigger steps), Home / End
//   Space / Enter     toggle a checkbox, run a list item, submit a text input
//   Esc               close the top panel
// The mouse works too: click a row, click or drag along a slider.
//
// Open panels form a stack; the top one gets the keys first. While any
// panel is open, nothing else (dev hotkeys) sees the keys it handles, and
// `panelOpen()` tells others to stay quiet.

import { makeMovable } from './drag';
import './tui.css';

/** One row of a panel. */
export interface Widget {
  readonly el: HTMLElement;
  /** Can take the keyboard focus. */
  readonly focusable: boolean;
  setFocus(on: boolean): void;
  /** Handle a key while focused; return true if it was used. */
  key(e: KeyboardEvent): boolean;
}

function div(cls: string, text = ''): HTMLDivElement {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
}

// ---- the panel stack ---------------------------------------------------------

const stack: Panel[] = [];
type KeyHandler = (e: KeyboardEvent) => boolean;
const globalKeys: KeyHandler[] = [];
const rootKeys: KeyHandler[] = [];
let listening = false;

/** True while any panel is open (others should leave the keyboard alone). */
export function panelOpen(): boolean {
  return stack.length > 0;
}

/** Keys that work whatever is open, before any panel (e.g. ` for the terminal). */
export function addGlobalKeys(f: KeyHandler): void {
  globalKeys.push(f);
  listen();
}

/** Keys pressed while no panel is open (e.g. Esc opens the menu). */
export function addRootKeys(f: KeyHandler): void {
  rootKeys.push(f);
  listen();
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const top = stack[stack.length - 1];
    // Typing into a text field outside any modal panel (a tool panel's field) is not a hotkey.
    const typing = !top && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement);
    const used = globalKeys.some((f) => f(e)) || (top ? top.key(e) : !typing && rootKeys.some((f) => f(e)));
    if (used) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
}

export interface PanelOptions {
  title: string;
  /** Right side of the top border, e.g. "Esc close". */
  hint?: string;
  /** Extra classes (position / size), e.g. "tui-center". */
  className?: string;
  /** Called just before the panel shows (refresh its values here). */
  onOpen?: () => void;
  /** Called after the panel closes. */
  onClose?: () => void;
  /** Esc closes the panel (default true). */
  escCloses?: boolean;
  /**
   * Default true: the panel takes the keyboard while open (it joins the
   * stack). A tool panel (false) is only shown and clicked; its keys stay
   * with whatever handles them (e.g. the brush's root keys).
   */
  modal?: boolean;
  /** Drag it by its title (the id names it in the saved layout). */
  movable?: string;
  /** Lives inside the options sidebar instead of floating. */
  docked?: boolean;
}

/** A box with a title in its top border and rows of widgets. */
export class Panel {
  readonly el: HTMLDivElement;
  readonly body: HTMLDivElement;
  private widgets: Widget[] = [];
  private focusIndex = -1;

  constructor(private opts: PanelOptions, root: HTMLElement = document.body) {
    this.el = div(`tui tui-box tui-panel ${opts.docked ? 'tui-docked ' : ''}${opts.className ?? ''}`.trim());
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', opts.title);
    const title = div('tui-title', opts.title);
    this.el.append(title);
    if (opts.movable) makeMovable(this.el, title, opts.movable);
    if (opts.hint) this.el.append(div('tui-hint', opts.hint));
    this.body = div('tui-body');
    this.el.append(this.body);
    // Pointer and wheel input stays in the panel (no orbiting behind it).
    for (const type of ['pointerdown', 'wheel', 'contextmenu'] as const) this.el.addEventListener(type, (e) => e.stopPropagation());
    root.appendChild(this.el);
    listen();
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Remove every row (to rebuild the panel's content). */
  clear(): void {
    this.widgets[this.focusIndex]?.setFocus(false);
    this.widgets = [];
    this.focusIndex = -1;
    this.body.replaceChildren();
  }

  /** Append widgets (rows). */
  add(...ws: Widget[]): this {
    for (const w of ws) {
      this.widgets.push(w);
      this.body.append(w.el);
      if (w.focusable && this.opts.modal !== false) w.el.addEventListener('pointerdown', () => this.focus(this.widgets.indexOf(w)));
    }
    return this;
  }

  open(): void {
    if (this.isOpen) return;
    this.opts.onOpen?.();
    this.el.hidden = false;
    if (this.opts.modal === false) return;
    stack.push(this);
    if (this.focusIndex < 0) this.focusIndex = this.widgets.findIndex((w) => w.focusable);
    this.focus(this.focusIndex);
  }

  close(): void {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.widgets[this.focusIndex]?.setFocus(false);
    const i = stack.indexOf(this);
    if (i >= 0) stack.splice(i, 1);
    this.opts.onClose?.();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Focus the row at `i` (no-op if it can't take focus). */
  focus(i: number): void {
    const w = this.widgets[i];
    if (!w?.focusable) return;
    if (i !== this.focusIndex) this.widgets[this.focusIndex]?.setFocus(false);
    this.focusIndex = i;
    w.setFocus(true);
  }

  private move(dir: 1 | -1): void {
    const n = this.widgets.length;
    for (let k = 1; k <= n; k++) {
      const i = (this.focusIndex + dir * k + n) % n;
      if (this.widgets[i]!.focusable) return this.focus(i);
    }
  }

  key(e: KeyboardEvent): boolean {
    if (this.widgets[this.focusIndex]?.key(e)) return true;
    if (e.key === 'Escape' && this.opts.escCloses !== false) {
      this.close();
      return true;
    }
    if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
      this.move(1);
      return true;
    }
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      this.move(-1);
      return true;
    }
    return false;
  }
}

// ---- widgets -------------------------------------------------------------------

/** A line of text that can't take focus: a heading, a hint, a value. */
export class Text implements Widget {
  readonly el: HTMLDivElement;
  readonly focusable = false;

  constructor(text: string, cls: 'tui-out' | 'tui-dim' | 'tui-head' | 'tui-info' = 'tui-out') {
    this.el = div(`tui-row ${cls}`, text);
  }

  set(text: string): void {
    this.el.textContent = text;
  }

  setFocus(): void {}
  key(): boolean {
    return false;
  }
}

export interface ListItem {
  label: string;
  /** A letter that runs it directly (shown on the right). */
  key?: string;
  run: () => void;
}

/** A menu: one item selected (reverse video), Enter or a click runs it. */
export class List implements Widget {
  readonly el: HTMLDivElement;
  readonly focusable = true;
  private rows: HTMLDivElement[];
  private sel = 0;
  private focused = false;

  constructor(private items: ListItem[]) {
    this.el = div('tui-list');
    this.rows = items.map((it, i) => {
      const r = div('tui-row tui-item');
      r.append(div('tui-label', it.label));
      if (it.key) r.append(div('tui-key', `[${it.key.toUpperCase()}]`));
      r.addEventListener('pointerenter', () => this.select(i));
      r.addEventListener('click', () => it.run());
      return r;
    });
    this.el.append(...this.rows);
    this.paint();
  }

  get selected(): number {
    return this.sel;
  }

  select(i: number): void {
    this.sel = Math.max(0, Math.min(this.items.length - 1, i));
    this.paint();
  }

  setFocus(on: boolean): void {
    this.focused = on;
    this.paint();
  }

  private paint(): void {
    this.rows.forEach((r, i) => r.classList.toggle('tui-sel', i === this.sel && this.focused));
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'ArrowDown' && this.sel < this.items.length - 1) return this.select(this.sel + 1), true;
    if (e.key === 'ArrowUp' && this.sel > 0) return this.select(this.sel - 1), true;
    if (e.key === 'Home') return this.select(0), true;
    if (e.key === 'End') return this.select(this.items.length - 1), true;
    if (e.key === 'Enter' || e.key === ' ') {
      this.items[this.sel]?.run();
      return true;
    }
    const hot = this.items.findIndex((it) => it.key && it.key.toLowerCase() === e.key.toLowerCase());
    if (hot >= 0) {
      this.select(hot);
      this.items[hot]!.run();
      return true;
    }
    return false;
  }
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  /** How the value is shown (default: 2 decimals). */
  format?: (v: number) => string;
  onChange: (v: number) => void;
  /** Characters in the bar. */
  width?: number;
  /** Label column width in characters (to line rows up). */
  labelWidth?: number;
}

/** `wind  [######··········] 0.35`: Left / Right, Home / End, click or drag. */
export class Slider implements Widget {
  readonly el: HTMLDivElement;
  readonly focusable = true;
  private bar: HTMLSpanElement;
  private text: HTMLSpanElement;
  private v: number;

  constructor(private o: SliderOptions) {
    this.v = o.value;
    this.el = div('tui-row tui-slider');
    const label = document.createElement('span');
    label.className = 'tui-label';
    label.textContent = o.label.padEnd(o.labelWidth ?? 10);
    this.bar = document.createElement('span');
    this.bar.className = 'tui-bar';
    this.text = document.createElement('span');
    this.text.className = 'tui-value';
    this.el.append(label, this.bar, this.text);
    const fromPointer = (e: PointerEvent) => {
      const r = this.bar.getBoundingClientRect();
      // Inside the brackets: the bar characters only.
      const chars = (o.width ?? 16) + 2;
      const t = ((e.clientX - r.left) / r.width) * chars - 1;
      this.set(o.min + Math.max(0, Math.min(1, t / (o.width ?? 16))) * (o.max - o.min), true);
    };
    this.bar.addEventListener('pointerdown', (e) => {
      this.bar.setPointerCapture(e.pointerId);
      fromPointer(e);
    });
    this.bar.addEventListener('pointermove', (e) => {
      if (this.bar.hasPointerCapture(e.pointerId)) fromPointer(e);
    });
    this.paint();
  }

  get value(): number {
    return this.v;
  }

  /** Change the value (snapped to the step, kept in range); `notify` calls onChange. */
  set(v: number, notify = false): void {
    const { min, max, step } = this.o;
    const snapped = Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
    const changed = Math.abs(snapped - this.v) > 1e-9;
    this.v = Number(snapped.toFixed(6));
    this.paint();
    if (notify && changed) this.o.onChange(this.v);
  }

  setFocus(on: boolean): void {
    this.el.classList.toggle('tui-sel', on);
  }

  private paint(): void {
    const w = this.o.width ?? 16;
    const f = (this.v - this.o.min) / (this.o.max - this.o.min || 1);
    const n = Math.round(f * w);
    this.bar.textContent = `[${'#'.repeat(n)}${'·'.repeat(w - n)}]`;
    this.text.textContent = ` ${(this.o.format ?? ((x: number) => x.toFixed(2)))(this.v)}`;
  }

  key(e: KeyboardEvent): boolean {
    const big = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowRight') return this.set(this.v + this.o.step * big, true), true;
    if (e.key === 'ArrowLeft') return this.set(this.v - this.o.step * big, true), true;
    if (e.key === 'Home') return this.set(this.o.min, true), true;
    if (e.key === 'End') return this.set(this.o.max, true), true;
    return false;
  }
}

/** `[x] label`: Space, Enter or a click toggles. */
export class Checkbox implements Widget {
  readonly el: HTMLDivElement;
  readonly focusable = true;
  private box: HTMLSpanElement;
  private on: boolean;

  constructor(label: string, checked: boolean, private onChange: (on: boolean) => void) {
    this.on = checked;
    this.el = div('tui-row tui-check');
    this.box = document.createElement('span');
    this.box.className = 'tui-box-mark';
    const l = document.createElement('span');
    l.textContent = ` ${label}`;
    this.el.append(this.box, l);
    this.el.addEventListener('click', () => this.toggle());
    this.paint();
  }

  get checked(): boolean {
    return this.on;
  }

  set(on: boolean, notify = false): void {
    const changed = on !== this.on;
    this.on = on;
    this.paint();
    if (notify && changed) this.onChange(on);
  }

  toggle(): void {
    this.set(!this.on, true);
  }

  setFocus(on: boolean): void {
    this.el.classList.toggle('tui-sel', on);
  }

  private paint(): void {
    this.box.textContent = this.on ? '[x]' : '[ ]';
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === ' ' || e.key === 'Enter') {
      this.toggle();
      return true;
    }
    return false;
  }
}

export interface TextInputOptions {
  /** Shown before the field (e.g. "seed", or ">" for a prompt). */
  label: string;
  value?: string;
  placeholder?: string;
  labelWidth?: number;
  /** Enter: return an error message to show, or nothing if accepted. */
  onSubmit: (value: string) => string | void;
  /** Extra keys (history, completion); return true if used. */
  keys?: (e: KeyboardEvent, input: HTMLInputElement) => boolean;
  /** Clear the field after a successful submit. */
  clearOnSubmit?: boolean;
  /** Handle its own keys (for fields in non-modal tool panels, which get no keys from the stack). */
  ownKeys?: boolean;
}

/** A text field: type, Enter submits. Arrow keys inside it move the caret. */
export class TextInput implements Widget {
  readonly el: HTMLLabelElement;
  readonly focusable = true;
  readonly input: HTMLInputElement;
  private err: HTMLSpanElement;

  constructor(private o: TextInputOptions) {
    this.el = document.createElement('label');
    this.el.className = 'tui-row tui-input';
    const l = document.createElement('span');
    l.className = 'tui-label';
    l.textContent = o.label.padEnd(o.labelWidth ?? o.label.length);
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.input.setAttribute('autocapitalize', 'off');
    this.input.setAttribute('aria-label', o.label);
    this.input.value = o.value ?? '';
    if (o.placeholder) this.input.placeholder = o.placeholder;
    this.err = document.createElement('span');
    this.err.className = 'tui-err';
    this.el.append(l, this.input, this.err);
    if (o.ownKeys) {
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') return this.input.blur();
        if (this.key(e)) e.preventDefault();
      });
    }
  }

  get value(): string {
    return this.input.value;
  }

  set(v: string): void {
    this.input.value = v;
  }

  setFocus(on: boolean): void {
    this.el.classList.toggle('tui-sel', on);
    if (on) this.input.focus();
    else this.input.blur();
  }

  key(e: KeyboardEvent): boolean {
    if (this.o.keys?.(e, this.input)) return true;
    if (e.key === 'Enter') {
      const msg = this.o.onSubmit(this.input.value);
      this.err.textContent = msg ? ` ${msg}` : '';
      if (!msg && this.o.clearOnSubmit) this.input.value = '';
      return true;
    }
    // Typing (and caret keys) go to the field itself, never to hotkeys.
    if (e.key.length === 1 || ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'].includes(e.key)) {
      e.stopImmediatePropagation();
      return false;
    }
    return false;
  }
}

export interface ChoiceOptions {
  label: string;
  options: readonly string[];
  value: string;
  labelWidth?: number;
  /** How an option is shown (default: as is). */
  format?: (v: string) => string;
  onChange: (v: string) => void;
}

/** `kind      ‹ tree:* ›`: one of a list; Left / Right or a click on an arrow cycles. */
export class Choice implements Widget {
  readonly el: HTMLDivElement;
  readonly focusable = true;
  private text: HTMLSpanElement;
  private options: string[];
  private i: number;

  constructor(private o: ChoiceOptions) {
    this.options = [...o.options];
    this.i = Math.max(0, this.options.indexOf(o.value));
    this.el = div('tui-row tui-choice');
    const label = document.createElement('span');
    label.className = 'tui-label';
    label.textContent = o.label.padEnd(o.labelWidth ?? 10);
    const prev = document.createElement('span'), next = document.createElement('span');
    prev.className = next.className = 'tui-arrow';
    prev.textContent = '‹ ';
    next.textContent = ' ›';
    this.text = document.createElement('span');
    this.text.className = 'tui-value';
    prev.addEventListener('click', () => this.step(-1));
    next.addEventListener('click', () => this.step(1));
    this.el.append(label, prev, this.text, next);
    this.paint();
  }

  get value(): string {
    return this.options[this.i] ?? '';
  }

  /** Change the list (keeps the value if it is still there). */
  setOptions(options: readonly string[]): void {
    const v = this.value;
    this.options = [...options];
    this.i = Math.max(0, this.options.indexOf(v));
    this.paint();
  }

  set(v: string): void {
    const i = this.options.indexOf(v);
    if (i >= 0) this.i = i;
    this.paint();
  }

  step(dir: 1 | -1): void {
    if (!this.options.length) return;
    this.i = (this.i + dir + this.options.length) % this.options.length;
    this.paint();
    this.o.onChange(this.value);
  }

  setFocus(on: boolean): void {
    this.el.classList.toggle('tui-sel', on);
  }

  private paint(): void {
    this.text.textContent = (this.o.format ?? ((v: string) => v))(this.value);
  }

  key(e: KeyboardEvent): boolean {
    if (e.key === 'ArrowRight') return this.step(1), true;
    if (e.key === 'ArrowLeft') return this.step(-1), true;
    return false;
  }
}
