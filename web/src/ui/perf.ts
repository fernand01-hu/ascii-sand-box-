// Performance overlay: a small TUI box in the top-right corner with frame
// rate, frame and draw time, cards drawn / loaded, chunks and worker
// queues, refreshed four times a second. F3 or the `perf` command toggle
// it. Use it to check the 30 FPS target without a GPU.

import type { App } from '../app/app';
import { statLines } from '../app/commands';

export class PerfOverlay {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;
  private timer = 0;

  constructor(private app: App, root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'tui tui-box tui-perf';
    this.el.hidden = true;
    this.el.innerHTML = '<span class="tui-title">perf</span><div></div>';
    this.body = this.el.lastElementChild as HTMLDivElement;
    root.appendChild(this.el);
  }

  get isOn(): boolean {
    return !this.el.hidden;
  }

  /** Show (true), hide (false) or flip (undefined); returns whether it is shown. */
  toggle(on = !this.isOn): boolean {
    this.el.hidden = !on;
    clearInterval(this.timer);
    if (on) {
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), 250);
    }
    return on;
  }

  private refresh(): void {
    const fps = this.app.viewer.stats.fps;
    const lines = statLines(this.app);
    // Colour the frame rate against the 30 FPS target (idle counts as fine).
    const cls = fps === 0 || fps >= 30 ? 'tui-ok' : fps >= 20 ? 'tui-echo' : 'tui-err';
    this.body.replaceChildren(...lines.map((l, i) => {
      const d = document.createElement('div');
      d.textContent = l;
      if (i === 0) d.className = cls;
      return d;
    }));
  }
}
