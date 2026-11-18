// Entry point. No UI yet: drag with the mouse to orbit, wheel to zoom,
// right-drag to pan.

import { App } from './app/app';

// Build-time constant: production builds drop the dev tools and test scenes.
const DEVTOOLS = import.meta.env.DEV || import.meta.env.MODE === 'test';

const container = document.getElementById('app');
if (!container) throw new Error('#app element is missing');

const app = new App(container);
if (DEVTOOLS) {
  void import('./app/devtools').then((m) => m.installDevtools(app));
}
void app.loadUrl(`${import.meta.env.BASE_URL}models/torus-knot.stl`, 'torus-knot.stl');
