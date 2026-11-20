// Entry point: opens on the blank canvas with the TUI interface (status
// bar, Esc menu), the terminal (` or F1) and the debug tools (F2-F4, menu
// Debug), all in every build. Drag with the mouse to orbit, wheel to zoom,
// right-drag to pan. Settings and debug choices from the last visit come
// back; a share link (`link` in the terminal) brings back a whole view.

import { App } from './app/app';
import { Cursor } from './app/cursor';
import { DebugState } from './app/debug';
import { DebugTools } from './app/debugtools';
import { Editor } from './app/editor';
import { BrushTool } from './app/brushtool';
import { BrushPanel } from './ui/brushpanel';
import { Undo } from './app/undo';
import { SceneStore } from './app/scenes';
import { ToolSwitch } from './app/tools';
import { ObjectTool } from './app/objecttool';
import { SelectTool } from './app/selecttool';
import { ObjectPanel, SelectPanel } from './ui/objectpanel';
import { PresetStore } from './app/presets';
import { ParamPanel } from './ui/parampanel';
import { HeightTool } from './app/heighttool';
import { HeightPanel } from './ui/heightpanel';
import { Dock } from './ui/dock';
import { Toolbar } from './ui/toolbar';
import { Lab } from './app/lab';
import { Look } from './app/look';
import { PlayMode } from './app/playmode';
import { QualityPresets } from './app/quality';
import { LabPanel } from './ui/labpanel';
import { Settings } from './app/settings';
import { Hud } from './ui/hud';
import { Terminal } from './ui/terminal';

// Build-time constant: production builds drop the dev tools and test scenes.
const DEVTOOLS = import.meta.env.DEV || import.meta.env.MODE === 'test';

const container = document.getElementById('app');
if (!container) throw new Error('#app element is missing');

const app = new App(container);
const debug = new DebugState();
const settings = new Settings(app);
const cursor = new Cursor(app);
const tools = new DebugTools(app, debug, cursor);
const editor = new Editor(app, cursor, settings);
tools.editor = editor;
const toolSwitch = new ToolSwitch();
const brush = new BrushTool(app, editor, settings);
brush.switch = toolSwitch;
const undo = new Undo(app, brush);
const objects = new ObjectTool(app, editor, undo, toolSwitch, settings);
const select = new SelectTool(app, editor, undo, toolSwitch);
const height = new HeightTool(app, editor, undo, toolSwitch, settings);
const scenes = new SceneStore(app, undo, settings);
const presets = new PresetStore();
const look = new Look(app, settings);
const lab = new Lab(app, look);
const play = new PlayMode(app, toolSwitch, editor, lab);
const quality = new QualityPresets(app, look, settings);
const terminal = new Terminal(app, { debug, settings, cursor, tools, editor, brush, undo, scenes, objects, select, presets, height, lab });
const hud = new Hud(app, { debug, settings, terminal, editor, brush, undo, scenes, objects, select, height, look });
// The options sidebar holds each tool's panel; the toolbar switches tools.
const dock = new Dock();
new SelectPanel(app, select, dock.body);
new BrushPanel(app, brush, dock.body);
new ObjectPanel(app, objects, dock.body);
new ParamPanel(app, objects, presets, dock.body);
new HeightPanel(app, height, dock.body);
new LabPanel(app, lab, (line) => terminal.run(line), dock.body);
lab.onChange(() => {
  if (lab.enabled && !dock.shown) dock.show(true);
});
// Split panes stop where the options sidebar starts (when it sits on the right).
lab.room = () => {
  if (!dock.shown) return 1;
  const r = dock.el.getBoundingClientRect();
  return r.left > window.innerWidth * 0.4 ? (r.left - 6) / window.innerWidth : 1;
};
dock.onChange(() => lab.relayout());
window.addEventListener('resize', () => lab.relayout());
new Toolbar(app, {
  editor, brush, objects, select, height, undo, scenes, dock,
  openMenu: () => hud.menu.open(), openTerminal: () => terminal.open(), flash: (t) => hud.flash(t),
  lab, play,
});
// Walking needs the whole view: the options sidebar steps aside while playing.
let dockWasShown = false;
play.onChange(() => {
  hud.refresh();
  if (play.playing && dock.shown) {
    dockWasShown = true;
    dock.show(false);
  } else if (!play.playing && dockWasShown) {
    dockWasShown = false;
    dock.show(true);
  }
});
if (DEVTOOLS) {
  void import('./app/devtools').then((m) => m.installDevtools(app, terminal));
}

async function start(): Promise<void> {
  await app.showCanvas();
  settings.restore();
  quality.firstVisit();
  await scenes.restoreAutosave(); // last session's work, if any
  if (location.hash) await settings.applyLink(location.hash, debug);
}
void start();
