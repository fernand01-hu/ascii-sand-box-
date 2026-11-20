// The debug terminal: a TUI panel at the bottom of the screen with a log
// (command output plus everything the app writes to the console) and a
// prompt. ` (the key left of 1, ² on AZERTY) or F1 opens and closes it,
// Esc closes it, Up/Down walk the history, Tab completes. F3 toggles the
// performance overlay. Dev/test builds only.

import type { App } from '../app/app';
import { complete, runCommand, type CommandIO, type LineKind } from '../app/commands';
import { PerfOverlay } from './perf';
import './tui.css';

const MAX_LINES = 500;

export class Terminal {
  readonly el: HTMLDivElement;
  readonly perf: PerfOverlay;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private history: string[] = [];
  private historyPos = 0;
  private busy: Promise<void> = Promise.resolve();
  /** While set, `print` also collects lines here (for `run`). */
  private capture: string[] | null = null;
  private io: CommandIO;

  constructor(private app: App, root: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'tui tui-box tui-terminal';
    this.el.hidden = true;
    this.el.innerHTML = `<span class="tui-title">terminal</span><span class="tui-hint">\` / F1 close · help</span>
      <div class="tui-log" role="log" aria-live="polite"></div>
      <label class="tui-prompt"><span>&gt;</span><input type="text" spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="command"></label>`;
    this.log = this.el.querySelector('.tui-log')!;
    this.input = this.el.querySelector('input')!;
    root.appendChild(this.el);
    this.perf = new PerfOverlay(app, root);

    this.io = {
      print: (text, kind) => this.print(text, kind),
      clear: () => this.clear(),
      setPerf: (on) => this.perf.toggle(on),
    };

    // Keep pointer and wheel input inside the panel (no orbiting behind it).
    for (const type of ['pointerdown', 'wheel', 'contextmenu'] as const) this.el.addEventListener(type, (e) => e.stopPropagation());
    this.input.addEventListener('keydown', this.onInputKey);
    window.addEventListener('keydown', this.onGlobalKey, true);
    this.mirrorConsole();
    this.print('debug terminal: type help', 'info');
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  open(): void {
    this.el.hidden = false;
    this.input.focus();
    this.log.scrollTop = this.log.scrollHeight;
  }

  close(): void {
    this.el.hidden = true;
    this.input.blur();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  print(text: string, kind: LineKind | 'echo' | 'dim' = 'out'): void {
    this.capture?.push(text);
    const line = document.createElement('div');
    line.className = `tui-${kind}`;
    line.textContent = text;
    const stick = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
    this.log.appendChild(line);
    while (this.log.childElementCount > MAX_LINES) this.log.firstElementChild!.remove();
    if (stick) this.log.scrollTop = this.log.scrollHeight;
  }

  clear(): void {
    this.log.replaceChildren();
  }

  /** Run a command as if typed; resolves with the lines it printed. Commands run one at a time. */
  run(line: string): Promise<string[]> {
    const result = this.busy.then(async () => {
      this.print(`> ${line}`, 'echo');
      const out: string[] = [];
      this.capture = out;
      try {
        await runCommand(this.app, line, this.io);
      } finally {
        this.capture = null;
      }
      return out;
    });
    this.busy = result.then(() => {}, () => {});
    return result;
  }

  private onGlobalKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Backquote' || e.key === 'F1') {
      e.preventDefault();
      e.stopPropagation();
      this.toggle();
    } else if (e.key === 'F3') {
      e.preventDefault();
      this.perf.toggle();
    } else if (e.key === 'Escape' && this.isOpen) {
      e.preventDefault();
      this.close();
    }
  };

  private onInputKey = (e: KeyboardEvent): void => {
    e.stopPropagation(); // typing never reaches the dev hotkeys
    if (e.key === 'Enter') {
      const line = this.input.value.trim();
      this.input.value = '';
      if (!line) return;
      if (this.history[this.history.length - 1] !== line) this.history.push(line);
      this.historyPos = this.history.length;
      void this.run(line);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.history.length) return;
      this.historyPos = Math.min(this.history.length, Math.max(0, this.historyPos + (e.key === 'ArrowUp' ? -1 : 1)));
      this.input.value = this.history[this.historyPos] ?? '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      this.completeInput();
    }
  };

  private completeInput(): void {
    const v = this.input.value;
    const matches = complete(this.app, v);
    if (matches.length === 0) return;
    const head = v.slice(0, v.length - (v.split(/\s+/).pop() ?? '').length);
    if (matches.length === 1) {
      this.input.value = `${head}${matches[0]} `;
      return;
    }
    // Several: fill in what they share and list them.
    let common = matches[0]!;
    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    this.input.value = head + common;
    this.print(matches.join('  '), 'dim');
  }

  /** Show console output in the log too (the browser console still gets it). */
  private mirrorConsole(): void {
    const kinds: [keyof Console & ('log' | 'info' | 'warn' | 'error'), LineKind][] = [['log', 'out'], ['info', 'info'], ['warn', 'err'], ['error', 'err']];
    for (const [method, kind] of kinds) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        original(...args);
        try {
          this.print(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeJson(a))).join(' '), kind);
        } catch {
          // never let logging break the app
        }
      };
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
