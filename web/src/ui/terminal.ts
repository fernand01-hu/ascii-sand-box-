// The debug terminal: a TUI panel at the bottom of the screen with a log
// (command output plus everything the app writes to the console) and a
// prompt. ` (the key left of 1, ² on AZERTY) or F1 opens and closes it,
// Esc closes it, Up/Down walk the history, Tab completes. F3 toggles the
// performance overlay. Built from the TUI widgets. Dev/test builds only.

import type { App } from '../app/app';
import { complete, runCommand, type CommandIO, type LineKind } from '../app/commands';
import { PerfOverlay } from './perf';
import { addGlobalKeys, Panel, TextInput, type Widget } from './widgets';

const MAX_LINES = 500;

/** The scrolling log: a widget that can't take focus. */
class Log implements Widget {
  readonly el = document.createElement('div');
  readonly focusable = false;

  constructor() {
    this.el.className = 'tui-log';
    this.el.setAttribute('role', 'log');
    this.el.setAttribute('aria-live', 'polite');
  }

  print(text: string, kind: string): void {
    const line = document.createElement('div');
    line.className = `tui-${kind}`;
    line.textContent = text;
    const stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
    this.el.appendChild(line);
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild!.remove();
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  clear(): void {
    this.el.replaceChildren();
  }

  setFocus(): void {}
  key(): boolean {
    return false;
  }
}

export class Terminal {
  readonly panel: Panel;
  readonly perf: PerfOverlay;
  private log = new Log();
  private prompt: TextInput;
  private history: string[] = [];
  private historyPos = 0;
  private busy: Promise<void> = Promise.resolve();
  /** While set, `print` also collects lines here (for `run`). */
  private capture: string[] | null = null;
  private io: CommandIO;

  constructor(private app: App, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'terminal', hint: '` / F1 close · help', className: 'tui-terminal' }, root);
    this.prompt = new TextInput({
      label: '>',
      labelWidth: 2,
      clearOnSubmit: true,
      onSubmit: (v) => {
        const line = v.trim();
        if (!line) return;
        if (this.history[this.history.length - 1] !== line) this.history.push(line);
        this.historyPos = this.history.length;
        void this.run(line);
      },
      keys: (e, input) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          if (this.history.length) {
            this.historyPos = Math.min(this.history.length, Math.max(0, this.historyPos + (e.key === 'ArrowUp' ? -1 : 1)));
            input.value = this.history[this.historyPos] ?? '';
          }
          return true;
        }
        if (e.key === 'Tab') {
          this.completeInput(input);
          return true;
        }
        return false;
      },
    });
    this.prompt.el.classList.add('tui-prompt');
    this.panel.add(this.log, this.prompt);
    this.perf = new PerfOverlay(app, root);

    this.io = {
      print: (text, kind) => this.print(text, kind),
      clear: () => this.log.clear(),
      setPerf: (on) => this.perf.toggle(on),
    };

    addGlobalKeys((e) => {
      if (e.code === 'Backquote' || e.key === 'F1') return this.toggle(), true;
      if (e.key === 'F3') return this.perf.toggle(), true;
      return false;
    });
    this.mirrorConsole();
    this.print('debug terminal: type help', 'info');
  }

  get el(): HTMLDivElement {
    return this.panel.el;
  }

  get isOpen(): boolean {
    return this.panel.isOpen;
  }

  open(): void {
    this.panel.open();
    this.log.el.scrollTop = this.log.el.scrollHeight;
  }

  close(): void {
    this.panel.close();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  print(text: string, kind: LineKind | 'echo' | 'dim' = 'out'): void {
    this.capture?.push(text);
    this.log.print(text, kind);
  }

  clear(): void {
    this.log.clear();
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

  private completeInput(input: HTMLInputElement): void {
    const v = input.value;
    const matches = complete(this.app, v);
    if (matches.length === 0) return;
    const head = v.slice(0, v.length - (v.split(/\s+/).pop() ?? '').length);
    if (matches.length === 1) {
      input.value = `${head}${matches[0]} `;
      return;
    }
    // Several: fill in what they share and list them.
    let common = matches[0]!;
    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    input.value = head + common;
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
