// The interface, in the style of an old terminal game: a status bar along
// the bottom (with a warning counter that opens the terminal), a menu on
// Esc, a settings panel (canvas seed and time of day, view distance,
// weather, FPS readout, card budget), a debug panel (every debug overlay,
// world clock speed, freeze streaming) and a help panel. All built from the
// TUI widgets; this ships in every build.

import type { App } from '../app/app';
import { DEBUG_OPTIONS, type DebugState } from '../app/debug';
import type { Settings } from '../app/settings';
import type { Terminal } from './terminal';
import { addRootKeys, Checkbox, List, Panel, Slider, Text, TextInput } from './widgets';

export interface HudDeps {
  debug: DebugState;
  settings: Settings;
  terminal: Terminal;
}

/** Card budget steps: 0 = no budget. */
const BUDGETS = [0, 20_000, 30_000, 40_000, 60_000, 80_000, 100_000, 150_000, 200_000];

export class Hud {
  readonly status: HTMLDivElement;
  readonly menu: Panel;
  readonly settings: Panel;
  readonly help: Panel;
  readonly debugPanel: Panel;
  private showFps = false;
  private warn: HTMLSpanElement;
  private info: HTMLSpanElement;
  private fps: HTMLSpanElement;

  constructor(private app: App, deps: HudDeps, root: HTMLElement = document.body) {
    const { debug, settings, terminal } = deps;
    // ---- status bar
    this.status = document.createElement('div');
    this.status.className = 'tui tui-status';
    this.status.innerHTML = '<span class="tui-name">ASCII SANDBOX</span><span class="tui-info"></span><span class="tui-warn" hidden></span><span class="tui-fps"></span><span class="tui-keys"><b>[Esc]</b> menu <b>[?]</b> help <b>[`]</b> terminal</span>';
    this.info = this.status.querySelector('.tui-info')!;
    this.fps = this.status.querySelector('.tui-fps')!;
    this.warn = this.status.querySelector('.tui-warn')!;
    this.warn.title = 'warnings or errors: click to open the terminal';
    this.warn.addEventListener('click', () => terminal.open());
    terminal.onProblems((n) => {
      this.warn.hidden = n === 0;
      this.warn.textContent = `⚠ ${n}`;
    });
    for (const [sel, run] of [['.tui-keys', () => this.menu.open()], ['.tui-name', () => this.menu.open()]] as const) {
      this.status.querySelector(sel)!.addEventListener('click', run);
    }
    this.status.addEventListener('pointerdown', (e) => e.stopPropagation());
    root.appendChild(this.status);

    // ---- menu
    this.menu = new Panel({ title: 'menu', hint: 'Esc close', className: 'tui-center tui-menu' }, root);
    this.menu.add(new List([
      { label: 'Settings', key: 's', run: () => this.settings.open() },
      { label: 'Debug', key: 'd', run: () => this.debugPanel.open() },
      { label: 'Terminal', key: 't', run: () => { this.menu.close(); terminal.open(); } },
      { label: 'Help', key: 'h', run: () => this.help.open() },
      { label: 'Back to the canvas', key: 'c', run: () => { this.menu.close(); void app.showCanvas(app.canvasOptions.seed, app.canvasOptions.day); } },
      { label: 'Close', key: 'q', run: () => this.menu.close() },
    ]));

    // ---- settings
    const W = 12; // label column
    const seed = new TextInput({
      label: 'seed', labelWidth: W, value: String(app.canvasOptions.seed),
      onSubmit: (v) => {
        const n = Number(v);
        if (!/^\d+$/.test(v.trim()) || n > 2 ** 32 - 1) return 'a whole number';
        void app.showCanvas(n, app.canvasOptions.day);
      },
    });
    const day = new Checkbox('daytime (off: dusk)', app.canvasOptions.day, (on) => void app.showCanvas(app.canvasOptions.seed, on));
    const view = new Slider({
      label: 'view', labelWidth: W, min: 1, max: 16, step: 1, value: app.viewRadius,
      format: (v) => `${v} chunks`, onChange: (v) => app.setViewRadius(v),
    });
    const weather = (k: 'wind' | 'rain' | 'leaves') => new Slider({
      label: k, labelWidth: W, min: 0, max: 1, step: 0.05, value: app.state.weather[k],
      onChange: (v) => app.setEnvironment({ [k]: v }),
    });
    const wind = weather('wind'), rain = weather('rain'), leaves = weather('leaves');
    const fps = new Checkbox('show FPS in the status bar', false, (on) => { this.showFps = on; this.refresh(); });
    settings.add({
      name: 'fps', help: 'show FPS in the status bar (on / off)', persist: true,
      get: () => (this.showFps ? 'on' : 'off'),
      set: (v) => {
        if (v !== 'on' && v !== 'off') throw new Error('fps: on or off');
        this.showFps = v === 'on';
        fps.set(this.showFps);
        this.refresh();
      },
    });
    const budgetIndex = () => Math.max(0, BUDGETS.indexOf(Number.isFinite(app.viewer.cards.budget) ? app.viewer.cards.budget : 0));
    const budget = new Slider({
      label: 'card budget', labelWidth: W, min: 0, max: BUDGETS.length - 1, step: 1, value: budgetIndex(),
      format: (i) => (BUDGETS[i] ? `${BUDGETS[i]! / 1000}k per frame` : 'off'),
      onChange: (i) => {
        app.viewer.cards.budget = BUDGETS[i] || Infinity;
        app.viewer.requestRender();
      },
    });
    // Values can change elsewhere (terminal, dev keys): pull them in on open.
    const sync = () => {
      seed.set(String(app.canvasOptions.seed));
      day.set(app.canvasOptions.day);
      view.set(app.viewRadius);
      wind.set(app.state.weather.wind);
      rain.set(app.state.weather.rain);
      leaves.set(app.state.weather.leaves);
      budget.set(budgetIndex());
      fps.set(this.showFps);
    };
    this.settings = new Panel({ title: 'settings', hint: 'Esc back', className: 'tui-center tui-settings', onOpen: sync }, root);
    this.settings.add(
      new Text('world', 'tui-head'), seed, day, view,
      new Text('weather', 'tui-head'), wind, rain, leaves,
      new Text('display', 'tui-head'), fps, budget,
      new Text('Up/Down move · Left/Right change · Space toggle · Enter apply', 'tui-dim'),
    );
    // ---- debug: one checkbox per debug option, generated from the shared list
    const checks = DEBUG_OPTIONS.map((o) => new Checkbox(`${o.label}${o.key ? `  (${o.key})` : ''}`, debug.get(o.id), (on) => debug.set(o.id, on)));
    const speed = new Slider({
      label: 'clock speed', labelWidth: W, min: 0, max: 4, step: 0.25, value: app.viewer.clockRate,
      format: (v) => (v === 0 ? 'stopped' : `x${v}`), onChange: (v) => app.viewer.setClockRate(v),
    });
    const stream = new Checkbox('freeze chunk streaming (look round a fixed state)', false, (on) => {
      if (!app.world) return;
      app.world.frozen = on;
      if (!on) app.world.update(app.viewer.camera.position, true);
    });
    const syncDebug = () => {
      DEBUG_OPTIONS.forEach((o, i) => checks[i]!.set(debug.get(o.id)));
      speed.set(app.viewer.clockRate);
      stream.set(!!app.world?.frozen);
    };
    this.debugPanel = new Panel({ title: 'debug', hint: 'Esc back', className: 'tui-center tui-debug', onOpen: syncDebug }, root);
    this.debugPanel.add(new Text('overlays', 'tui-head'), ...checks, new Text('world', 'tui-head'), speed, stream,
      new Text('all of these also work from the terminal: debug, set, help', 'tui-dim'));
    debug.onChange(() => { if (this.debugPanel.isOpen) syncDebug(); });

    // ---- help
    this.help = new Panel({ title: 'help', hint: 'Esc back', className: 'tui-center tui-help' }, root);
    for (const [k, v] of [
      ['mouse drag', 'orbit round the view'],
      ['wheel', 'zoom'],
      ['right drag', 'pan (travel across the canvas)'],
      ['Esc', 'menu / close a panel'],
      ['Up / Down', 'move in a panel'],
      ['Left / Right', 'change a slider'],
      ['Space / Enter', 'toggle / apply'],
      ['?', 'this help'],
      ['` or F1', 'terminal (type help)'],
      ['F2 / F3 / F4', 'info box / performance / chunk borders'],
    ] as const) this.help.add(new Text(`${k.padEnd(15)} ${v}`));
    this.help.add(new Text('Painting and placing objects come next (see TODO.md).', 'tui-dim'));

    addRootKeys((e) => {
      if (e.key === 'Escape') return this.menu.open(), true;
      if (e.key === '?') return this.help.open(), true;
      return false;
    });
    this.refresh();
    window.setInterval(() => this.refresh(), 500);
  }

  /** Update the status bar text. */
  refresh(): void {
    const a = this.app, s = a.state, w = s.weather;
    const where = a.world ? `canvas ${a.canvasOptions.seed} · ${a.canvasOptions.day ? 'day' : 'dusk'}` : s.model || '…';
    const status = s.status === 'loading' ? ' · loading' : s.status === 'error' ? ' · error' : '';
    this.info.textContent = `${where}${status} │ wind ${w.wind.toFixed(2)} rain ${w.rain > 0 ? w.rain.toFixed(2) : 'off'} leaves ${w.leaves.toFixed(2)}`;
    const f = a.viewer.stats.fps;
    this.fps.textContent = this.showFps ? `${f > 0 ? f.toFixed(f < 10 ? 1 : 0) : 'idle'} fps` : '';
    this.fps.className = `tui-fps ${f === 0 || f >= 30 ? 'tui-ok' : f >= 20 ? 'tui-echo' : 'tui-err'}`;
  }
}
