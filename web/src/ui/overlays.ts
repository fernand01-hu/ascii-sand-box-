// On-screen debug pieces in the TUI style: a text box (the info box, the
// glyph inspector's tooltip), labels pinned to points in the world (chunk
// coordinates, object ids) and a heat map of glyph stacking. None of them
// take the mouse or the keyboard.

import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import './tui.css';

/** A TUI box of text lines, fixed on screen. */
export class OverlayBox {
  readonly el: HTMLDivElement;
  private body: HTMLDivElement;

  constructor(title: string, className: string, root: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = `tui tui-box tui-overlay ${className}`;
    this.el.hidden = true;
    const t = document.createElement('div');
    t.className = 'tui-title';
    t.textContent = title;
    this.body = document.createElement('div');
    this.body.className = 'tui-overlay-body';
    this.el.append(t, this.body);
    root.appendChild(this.el);
  }

  get shown(): boolean {
    return !this.el.hidden;
  }

  show(on: boolean): void {
    this.el.hidden = !on;
  }

  /** Lines of text; a line may be [text, class] to colour it. */
  setLines(lines: (string | [string, string])[]): void {
    this.body.replaceChildren(...lines.map((l) => {
      const d = document.createElement('div');
      if (typeof l === 'string') d.textContent = l;
      else [d.textContent, d.className] = l;
      return d;
    }));
  }

  /** Place near a screen point, kept inside the window. */
  placeNear(x: number, y: number): void {
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const left = Math.min(window.innerWidth - w - 8, x + 18), top = Math.min(window.innerHeight - h - 32, y + 18);
    this.el.style.left = `${Math.max(8, left)}px`;
    this.el.style.top = `${Math.max(8, top)}px`;
  }
}

export interface Label {
  x: number;
  y: number;
  z: number;
  text: string;
  cls?: string;
}

/** Small tags pinned to world points, re-placed every frame. */
export class Labels {
  readonly el: HTMLDivElement;
  private pool: HTMLDivElement[] = [];
  private v = new Vector3();

  constructor(root: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'tui tui-labels';
    root.appendChild(this.el);
  }

  /** Show these labels for this camera (behind the camera or off screen: hidden). */
  update(labels: Label[], camera: PerspectiveCamera, width: number, height: number): number {
    let shown = 0;
    for (const l of labels) {
      this.v.set(l.x, l.y, l.z).project(camera);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      let d = this.pool[shown];
      if (!d) {
        d = document.createElement('div');
        this.pool.push(d);
        this.el.appendChild(d);
      }
      d.className = `tui-label-tag ${l.cls ?? ''}`;
      d.textContent = l.text;
      d.style.transform = `translate(${((this.v.x + 1) / 2) * width}px, ${((1 - this.v.y) / 2) * height}px) translate(-50%, -100%)`;
      d.hidden = false;
      shown++;
    }
    for (let i = shown; i < this.pool.length; i++) this.pool[i]!.hidden = true;
    return shown;
  }

  clear(): void {
    for (const d of this.pool) d.hidden = true;
  }
}

/** Screen cells holding too many glyphs, tinted from yellow to red. */
export class HeatMap {
  readonly el: HTMLCanvasElement;

  constructor(root: HTMLElement = document.body) {
    this.el = document.createElement('canvas');
    this.el.className = 'tui-heat';
    this.el.hidden = true;
    root.appendChild(this.el);
  }

  show(on: boolean): void {
    this.el.hidden = !on;
  }

  /** Paint a stacking grid (`cellPx` per cell); cells with more than `ok` glyphs are tinted. */
  draw(grid: { cols: number; rows: number; counts: Uint32Array }, cellPx: number, ok = 3): void {
    const c = this.el, w = window.innerWidth, h = window.innerHeight;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, w, h);
    for (let r = 0; r < grid.rows; r++) {
      for (let k = 0; k < grid.cols; k++) {
        const n = grid.counts[r * grid.cols + k]!;
        if (n <= ok) continue;
        const t = Math.min(1, (n - ok) / (ok * 4));
        g.fillStyle = `rgba(255, ${Math.round(200 * (1 - t))}, 60, ${0.18 + 0.4 * t})`;
        g.fillRect(k * cellPx, r * cellPx, cellPx, cellPx);
      }
    }
  }
}
