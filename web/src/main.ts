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
const brush = new BrushTool(app, editor, settings);
const terminal = new Terminal(app, { debug, settings, cursor, tools, editor, brush });
new Hud(app, { debug, settings, terminal, editor, brush });
new BrushPanel(app, brush);
if (DEVTOOLS) {
  void import('./app/devtools').then((m) => m.installDevtools(app, terminal));
}

async function start(): Promise<void> {
  await app.showCanvas();
  settings.restore();
  if (location.hash) await settings.applyLink(location.hash, debug);
}
void start();
