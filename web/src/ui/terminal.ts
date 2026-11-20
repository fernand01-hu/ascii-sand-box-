// The terminal: a TUI panel at the bottom of the screen with a log (command
// output plus everything the app writes to the console) and a prompt.
// ` (the key left of 1, ² on AZERTY) or F1 opens and closes it, Esc closes
// it, Up/Down walk the history, Tab completes. A line can hold several
// commands separated by `;`, `!!` repeats the previous line, aliases and key
// bindings are remembered. Warnings and errors are counted for the status
// bar. Built from the TUI widgets; ships in every build.

import type { App } from '../app/app';
import { complete, runCommand, type CommandContext, type CommandIO, type LineKind } from '../app/commands';
import { addGlobalKeys, addRootKeys, Panel, TextInput, type Widget } from './widgets';

const MAX_LINES = 500;
const STORE_KEY = 'ascii-sandbox.terminal';

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

  text(): string {
    return [...this.el.children].map((c) => c.textContent ?? '').join('\n');
  }

  setFocus(): void {}
  key(): boolean {
    return false;
  }
}

export class Terminal {
  readonly panel: Panel;
  private log = new Log();
  private prompt: TextInput;
  private history: string[] = [];
  private historyPos = 0;
  private busy: Promise<void> = Promise.resolve();
  /** While set, `print` also collects lines here (for `run`). */
  private capture: string[] | null = null;
  private io: CommandIO;
  /** What commands can reach (debug options, settings, cursor, tools, terminal features). */
  readonly ctx: CommandContext;
  /** Warnings and errors since the terminal was last opened. */
  problems = 0;
  private problemListeners = new Set<(n: number) => void>();
  private lastLine = '';

  constructor(private app: App, ctx: Omit<CommandContext, 'term'>, root: HTMLElement = document.body) {
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

    this.io = { print: (text, kind) => this.print(text, kind), clear: () => this.log.clear() };
    const term: CommandContext['term'] = {
      aliases: new Map(),
      binds: new Map(),
      lastOutput: [],
      logText: () => this.log.text(),
      exec: (line) => this.exec(line),
      save: () => this.saveStore(),
    };
    this.ctx = { ...ctx, term };
    this.loadStore();

    addGlobalKeys((e) => {
      if (e.code === 'Backquote' || e.key === 'F1') return this.toggle(), true;
      return false;
    });
    // Key bindings work whenever no panel is open.
    addRootKeys((e) => {
      const line = term.binds.get(e.key) ?? term.binds.get(e.key.toLowerCase());
      if (!line) return false;
      void this.run(line);
      return true;
    });
    this.mirrorConsole();
    this.print('terminal: type help', 'info');
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
    this.setProblems(0);
  }

  close(): void {
    this.panel.close();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Called with the number of warnings / errors not yet seen. */
  onProblems(f: (n: number) => void): void {
    this.problemListeners.add(f);
  }

  private setProblems(n: number): void {
    this.problems = n;
    for (const f of this.problemListeners) f(n);
  }

  print(text: string, kind: LineKind | 'echo' | 'dim' = 'out'): void {
    this.capture?.push(text);
    this.log.print(text, kind);
  }

  clear(): void {
    this.log.clear();
  }

  /** Run a line as if typed (`;`, `!!`, aliases); resolves with what it printed. One line at a time. */
  run(line: string): Promise<string[]> {
    const result = this.busy.then(async () => {
      const out: string[] = [];
      const outer = this.capture;
      this.capture = out;
      try {
        await this.exec(line, true);
      } finally {
        this.capture = outer;
        outer?.push(...out);
      }
      this.ctx.term.lastOutput = out;
      return out;
    });
    this.busy = result.then(() => {}, () => {});
    return result;
  }

  /** Expand and run a line: `!!`, aliases, then each `;`-separated command. */
  private async exec(line: string, echo = false, depth = 0): Promise<void> {
    if (depth > 8) {
      this.print('alias loop: stopped', 'err');
      return;
    }
    let text = line.trim();
    if (text === '!!') {
      if (!this.lastLine) return this.print('nothing to repeat', 'err');
      text = this.lastLine;
    }
    if (echo) {
      // The echo goes to the log, not into the captured output.
      const cap = this.capture;
      this.capture = null;
      this.print(`> ${text}`, 'echo');
      this.capture = cap;
      if (line.trim() !== '!!') this.lastLine = text;
    }
    for (const part of text.split(';').map((p) => p.trim()).filter(Boolean)) {
      const [name, ...rest] = part.split(/\s+/);
      const alias = this.ctx.term.aliases.get(name!);
      if (alias) await this.exec([alias, ...rest].join(' '), false, depth + 1);
      else await runCommand(this.app, part, this.io, this.ctx);
    }
  }

  private completeInput(input: HTMLInputElement): void {
    const v = input.value;
    const current = v.split(';').pop() ?? '';
    const lead = v.slice(0, v.length - current.length);
    const matches = complete(this.app, current.trimStart(), this.ctx);
    if (matches.length === 0) return;
    const head = current.slice(0, current.length - (current.split(/\s+/).pop() ?? '').length);
    if (matches.length === 1) {
      input.value = `${lead}${head}${matches[0]} `;
      return;
    }
    // Several: fill in what they share and list them.
    let common = matches[0]!;
    for (const m of matches) while (!m.startsWith(common)) common = common.slice(0, -1);
    input.value = lead + head + common;
    this.print(matches.join('  '), 'dim');
  }

  private loadStore(): void {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as { aliases?: [string, string][]; binds?: [string, string][] };
      for (const [k, l] of v.aliases ?? []) this.ctx.term.aliases.set(k, l);
      for (const [k, l] of v.binds ?? []) this.ctx.term.binds.set(k, l);
    } catch {
      // nothing remembered
    }
  }

  private saveStore(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ aliases: [...this.ctx.term.aliases], binds: [...this.ctx.term.binds] }));
    } catch {
      // storage blocked
    }
  }

  /** Show console output in the log too (the browser console still gets it); count problems. */
  private mirrorConsole(): void {
    const kinds: [keyof Console & ('log' | 'info' | 'warn' | 'error'), LineKind][] = [['log', 'out'], ['info', 'info'], ['warn', 'err'], ['error', 'err']];
    for (const [method, kind] of kinds) {
      const original = console[method].bind(console);
      console[method] = (...args: unknown[]) => {
        original(...args);
        try {
          this.print(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : safeJson(a))).join(' '), kind);
          if (kind === 'err' && !this.isOpen) this.setProblems(this.problems + 1);
        } catch {
          // never let logging break the app
        }
      };
    }
    window.addEventListener('error', (e) => {
      this.print(`error: ${e.message}`, 'err');
      if (!this.isOpen) this.setProblems(this.problems + 1);
    });
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
