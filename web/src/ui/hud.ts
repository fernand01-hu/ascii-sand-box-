// The interface, in the style of an old terminal game: a status bar along
// the bottom (with a warning counter that opens the terminal), a menu on
// Esc, a settings panel (canvas seed and time of day, view distance,
// weather, FPS readout, card budget), a debug panel (every debug overlay,
// world clock speed, freeze streaming) and a help panel. All built from the
// TUI widgets; this ships in every build.

import { SWITCHES, type Look } from '../app/look';
import type { App } from '../app/app';
import { DEBUG_OPTIONS, type DebugState } from '../app/debug';
import { SNAP_STEPS, type Editor } from '../app/editor';
import type { BrushTool } from '../app/brushtool';
import type { Undo } from '../app/undo';
import type { SceneStore } from '../app/scenes';
import type { ObjectTool } from '../app/objecttool';
import type { SelectTool } from '../app/selecttool';
import type { HeightTool } from '../app/heighttool';
import type { Settings } from '../app/settings';
import type { Terminal } from './terminal';
import { addRootKeys, Checkbox, List, Panel, Slider, Text, TextInput } from './widgets';

export interface HudDeps {
  debug: DebugState;
  settings: Settings;
  terminal: Terminal;
  editor: Editor;
  brush: BrushTool;
  undo: Undo;
  scenes: SceneStore;
  objects: ObjectTool;
  select: SelectTool;
  height: HeightTool;
  look: Look;
}

/** Card budget steps: 0 = no budget. */
const BUDGETS = [0, 20_000, 30_000, 40_000, 60_000, 80_000, 100_000, 150_000, 200_000];

export class Hud {
  readonly status: HTMLDivElement;
  readonly menu: Panel;
  readonly settings: Panel;
  readonly help: Panel;
  readonly debugPanel: Panel;
  readonly filePanel: Panel;
  private showFps = false;
  private warn: HTMLSpanElement;
  private editor: Editor;
  private brush: BrushTool;
  private objectTool!: ObjectTool;
  private selectTool!: SelectTool;
  private heightTool!: HeightTool;
  private flashText = '';
  private flashTimer = 0;
  private info: HTMLSpanElement;
  private fps: HTMLSpanElement;

  constructor(private app: App, deps: HudDeps, root: HTMLElement = document.body) {
    const { debug, settings, terminal, editor, brush, undo, scenes, objects, select, height, look } = deps;
    this.heightTool = height;
    height.onChange(() => this.refresh());
    this.objectTool = objects;
    this.selectTool = select;
    objects.onChange(() => this.refresh());
    select.onChange(() => this.refresh());
    scenes.onMessage((text) => this.flash(text));
    undo.onApplied((verb, a) => this.flash(`${verb}: ${a.label}`));
    this.editor = editor;
    this.brush = brush;
    brush.onChange(() => this.refresh());
    // ---- status bar
    this.status = document.createElement('div');
    this.status.className = 'tui tui-status';
    this.status.innerHTML = '<span class="tui-name">ASCII SANDBOX</span><span class="tui-info"></span><span class="tui-warn" hidden></span><span class="tui-fps"></span><span class="tui-keys"><b>[Tab]</b> options <b>[Esc]</b> menu <b>[?]</b> help</span>';
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
    this.menu = new Panel({ title: 'menu', hint: 'Esc close', className: 'tui-center tui-menu', movable: 'menu' }, root);
    this.menu.add(new List([
      { label: 'Brush (paint the ground)', key: 'b', run: () => { this.menu.close(); brush.setActive(!brush.active); } },
      { label: 'Object brush (trees, rocks...)', key: 'o', run: () => { this.menu.close(); objects.setActive(!objects.active); } },
      { label: 'Select objects', key: 'v', run: () => { this.menu.close(); select.setActive(!select.active); } },
      { label: 'Height brush (hills, valleys)', key: 'e', run: () => { this.menu.close(); height.setActive(!height.active); } },
      { label: 'Save / load scenes', key: 'f', run: () => this.filePanel.open() },
      { label: 'Undo (Ctrl+Z)', key: 'u', run: () => undo.undo() },
      { label: 'Redo (Ctrl+Y)', key: 'r', run: () => undo.redo() },
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
    const top = new Checkbox('top-down view (T)', editor.mode === 'top', (on) => {
      try {
        editor.setMode(on ? 'top' : 'orbit');
      } catch {
        top.set(editor.mode === 'top');
      }
    });
    const grid = new Checkbox('grid on the ground (G)', editor.grid, (on) => editor.setGrid(on));
    const snap = new Slider({
      label: 'snap', labelWidth: W, min: 0, max: SNAP_STEPS.length - 1, step: 1, value: SNAP_STEPS.indexOf(editor.snap),
      format: (i) => (SNAP_STEPS[i] ? `${SNAP_STEPS[i]} m` : 'off'), onChange: (i) => editor.setSnap(SNAP_STEPS[i] ?? 0),
    });
    // The look (Phase 3): time of day, storm, and each feature.
    const sceneLight = new Checkbox('time of day follows the scene', look.hour === null, (on) => look.setHour(on ? null : 16.5));
    const daytime = new Slider({
      label: 'time of day', labelWidth: W, min: 0, max: 24, step: 0.25, value: look.hour ?? 16.5, width: 16,
      format: (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
      onChange: (v) => look.setHour(v),
    });
    const storm = new Checkbox('storm: dark sky, lightning', look.features.storm, (on) => look.set({ storm: on }));
    const feats = SWITCHES.filter(([k]) => k !== 'storm').map(([k, help]) => [k, new Checkbox(help, look.features[k] as boolean, (on) => look.set({ [k]: on }))] as const);
    // Values can change elsewhere (terminal, dev keys): pull them in on open.
    const sync = () => {
      sceneLight.set(look.hour === null);
      if (look.hour !== null) daytime.set(look.hour);
      storm.set(look.features.storm);
      for (const [k, c] of feats) c.set(look.features[k] as boolean);
      top.set(editor.mode === 'top');
      grid.set(editor.grid);
      snap.set(Math.max(0, SNAP_STEPS.indexOf(editor.snap)));
      seed.set(String(app.canvasOptions.seed));
      day.set(app.canvasOptions.day);
      view.set(app.viewRadius);
      wind.set(app.state.weather.wind);
      rain.set(app.state.weather.rain);
      leaves.set(app.state.weather.leaves);
      budget.set(budgetIndex());
      fps.set(this.showFps);
    };
    this.settings = new Panel({ title: 'settings', hint: 'Esc back', className: 'tui-center tui-settings', onOpen: sync, movable: 'settings' }, root);
    this.settings.add(
      new Text('world', 'tui-head'), seed, day, view,
      new Text('weather', 'tui-head'), wind, rain, leaves, storm,
      new Text('light', 'tui-head'), sceneLight, daytime,
      new Text('look (all on = standard; `style classic` = before)', 'tui-head'), ...feats.map(([, c]) => c),
      new Text('editing', 'tui-head'), top, grid, snap,
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
    this.debugPanel = new Panel({ title: 'debug', hint: 'Esc back', className: 'tui-center tui-debug', onOpen: syncDebug, movable: 'debug' }, root);
    this.debugPanel.add(new Text('overlays', 'tui-head'), ...checks, new Text('world', 'tui-head'), speed, stream,
      new Text('all of these also work from the terminal: debug, set, help', 'tui-dim'));
    debug.onChange(() => { if (this.debugPanel.isOpen) syncDebug(); });

    // ---- save / load: rebuilt each time it opens (the list of scenes changes)
    this.filePanel = new Panel({ title: 'scenes', hint: 'Esc back', className: 'tui-center tui-file', onOpen: () => this.fillFilePanel(scenes), movable: 'scenes' }, root);

    // ---- help
    this.help = new Panel({ title: 'help', hint: 'Esc back', className: 'tui-center tui-help', movable: 'help' }, root);
    for (const [k, v] of [
      ['mouse drag', 'orbit round the view'],
      ['wheel', 'zoom'],
      ['right drag', 'pan (travel across the canvas)'],
      ['T', 'top-down view (drag pans, wheel height)'],
      ['arrows', 'pan in the top-down view (Shift: faster)'],
      ['G', 'grid on the ground'],
      ['P', 'brush: left drag paints'],
      ['1-4 / E', 'brush paint: grass sand water rock / eraser'],
      ['[ / ]', 'smaller / bigger brush'],
      ['O', 'object brush: 1 spray 2 single 3 erase'],
      ['V', 'select: drag moves, R turns, Delete removes'],
      ['H', 'height: 1 raise 2 lower 3 smooth 4 flatten'],
      ['Ctrl+Z / Ctrl+Y', 'undo / redo (also Ctrl+Shift+Z)'],
      ['Ctrl+S', 'save the scene (menu: Save / load)'],
      ['Esc', 'menu / close a panel'],
      ['Tab', 'show / hide the options sidebar'],
      ['drag a title', 'move a window (double-click: put it back)'],
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

  private fillFilePanel(scenes: SceneStore): void {
    const p = this.filePanel, run = (f: () => unknown, ok: (r: never) => string) => {
      try {
        this.flash(ok(f() as never));
      } catch (e) {
        this.flash(e instanceof Error ? e.message : String(e));
      }
    };
    p.clear();
    p.add(
      new Text('save', 'tui-head'),
      new TextInput({
        label: 'name', labelWidth: 6, value: scenes.current,
        onSubmit: (v) => {
          try {
            const r = scenes.save(v);
            this.flash(`saved "${r.name}"`);
            this.fillFilePanel(scenes); // show it in the list
            return;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
      }),
      new Text('Enter saves · Ctrl+S saves the current scene any time', 'tui-dim'),
      new Text('load', 'tui-head'),
    );
    const list = scenes.list(true);
    if (list.length) {
      p.add(new List(list.map((s) => ({
        label: `${s.name.slice(0, 24).padEnd(24)} ${s.saved.slice(0, 16).replace('T', ' ')}`,
        run: () => {
          void scenes.load(s.name).then(
            () => {
              this.flash(`loaded "${s.name}" (Ctrl+Z goes back)`);
              p.close();
              this.menu.close();
            },
            (e: unknown) => this.flash(e instanceof Error ? e.message : String(e)),
          );
        },
      }))));
    } else p.add(new Text('no saved scenes yet', 'tui-dim'));
    p.add(
      new Text('files', 'tui-head'),
      new List([
        { label: 'Download the scene (.scene.json)', run: () => run(() => scenes.download(), (f) => `downloaded ${f}`) },
        { label: 'Load a scene file...', run: () => scenes.pickFile() },
        { label: 'Export the view as PNG', run: () => run(() => scenes.exportPng(), (f) => `exported ${f}`) },
        { label: 'Export the view as text (.txt)', run: () => run(() => scenes.exportText(), (f) => `exported ${f}`) },
        { label: 'New empty scene (Ctrl+Z undoes)', run: () => run(() => scenes.newScene(), () => 'new empty scene') },
      ]),
    );
  }

  private toolText(): string {
    const o = this.objectTool, s = this.selectTool, h = this.heightTool;
    if (h?.active) return ` · HEIGHT ${h.mode} ${h.radius} m`;
    if (o?.active) return ` · OBJECTS ${o.mode} ${o.kind.endsWith(':*') ? `any ${o.kind.split(':')[0]}` : o.kind} ${o.radius} m`;
    if (s?.active) {
      const sel = s.object();
      return ` · SELECT${sel ? ` #${sel.id} ${sel.kind}` : ''}`;
    }
    return '';
  }

  /** Show a short message in the status bar for a few seconds. */
  flash(text: string): void {
    this.flashText = text;
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashText = '';
      this.refresh();
    }, 3000);
    this.refresh();
  }

  /** Update the status bar text. */
  refresh(): void {
    const a = this.app, s = a.state, w = s.weather;
    const ed = this.editor;
    const br = this.brush;
    const edit = a.world
      ? `${ed.mode === 'top' ? ' · TOP' : ''}${ed.grid ? ' · grid' : ''}${ed.snap ? ` · snap ${ed.snap} m` : ''}${br.active ? ` · BRUSH ${br.kind} ${br.radius} m` : ''}${this.toolText()}`
      : '';
    const where = a.world ? `canvas ${a.canvasOptions.seed} · ${a.canvasOptions.day ? 'day' : 'dusk'}${edit}` : s.model || '…';
    const status = s.status === 'loading' ? ' · loading' : s.status === 'error' ? ' · error' : '';
    this.info.textContent = this.flashText
      ? `${where} │ ${this.flashText}`
      : `${where}${status} │ wind ${w.wind.toFixed(2)} rain ${w.rain > 0 ? w.rain.toFixed(2) : 'off'} leaves ${w.leaves.toFixed(2)}`;
    const f = a.viewer.stats.fps;
    this.fps.textContent = this.showFps ? `${f > 0 ? f.toFixed(f < 10 ? 1 : 0) : 'idle'} fps` : '';
    this.fps.className = `tui-fps ${f === 0 || f >= 30 ? 'tui-ok' : f >= 20 ? 'tui-echo' : 'tui-err'}`;
  }
}
