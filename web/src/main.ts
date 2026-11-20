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
const scenes = new SceneStore(app, undo, settings);
const terminal = new Terminal(app, { debug, settings, cursor, tools, editor, brush, undo, scenes, objects, select });
new Hud(app, { debug, settings, terminal, editor, brush, undo, scenes, objects, select });
new BrushPanel(app, brush);
new ObjectPanel(app, objects);
new SelectPanel(app, select);
if (DEVTOOLS) {
  void import('./app/devtools').then((m) => m.installDevtools(app, terminal));
}

async function start(): Promise<void> {
  await app.showCanvas();
  settings.restore();
  await scenes.restoreAutosave(); // last session's work, if any
  if (location.hash) await settings.applyLink(location.hash, debug);
}
void start();
