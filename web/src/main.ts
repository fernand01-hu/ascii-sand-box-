// Entry point: opens on the blank canvas with the TUI interface (status
// bar, Esc menu). Drag with the mouse to orbit, wheel to zoom, right-drag
// to pan.

import { App } from './app/app';
import { Hud } from './ui/hud';

// Build-time constant: production builds drop the dev tools and test scenes.
const DEVTOOLS = import.meta.env.DEV || import.meta.env.MODE === 'test';

const container = document.getElementById('app');
if (!container) throw new Error('#app element is missing');

const app = new App(container);
new Hud(app);
if (DEVTOOLS) {
  void import('./app/devtools').then((m) => m.installDevtools(app));
}
void app.showCanvas();
