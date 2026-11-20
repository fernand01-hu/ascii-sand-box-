// The toolbar: a small bar of buttons (bottom centre by default) for the
// editing tools and the things used most. The tool that is on is shown in
// reverse video; every button also has its key, shown in brackets. Drag the
// grip on its left to move it (double-click it to put it back).

import type { App } from '../app/app';
import type { BrushTool } from '../app/brushtool';
import type { Editor } from '../app/editor';
import type { HeightTool } from '../app/heighttool';
import type { ObjectTool } from '../app/objecttool';
import type { SceneStore } from '../app/scenes';
import type { SelectTool } from '../app/selecttool';
import type { Undo } from '../app/undo';
import type { Dock } from './dock';
import type { Lab } from '../app/lab';
import type { PlayMode } from '../app/playmode';
import { makeMovable } from './drag';
import './tui.css';

export interface ToolbarDeps {
  editor: Editor;
  brush: BrushTool;
  objects: ObjectTool;
  select: SelectTool;
  height: HeightTool;
  undo: Undo;
  scenes: SceneStore;
  dock: Dock;
  openMenu: () => void;
  openTerminal: () => void;
  flash: (text: string) => void;
  lab: Lab;
  play: PlayMode;
}

interface Button {
  el: HTMLButtonElement;
  on?: () => boolean;
}

export class Toolbar {
  readonly el: HTMLDivElement;
  private buttons: Button[] = [];

  constructor(private app: App, d: ToolbarDeps, root: HTMLElement = document.body) {
    this.el = document.createElement('div');
    this.el.className = 'tui tui-box tui-toolbar';
    this.el.setAttribute('role', 'toolbar');
    const grip = document.createElement('span');
    grip.className = 'tui-grip';
    grip.textContent = '≡';
    this.el.append(grip);
    const tool = (t: { active: boolean; setActive(on: boolean): void }) => () => t.setActive(!t.active);
    const groups: [string, string, string, () => void, (() => boolean)?][][] = [
      [
        ['select', 'V', 'select, move, turn, delete objects', tool(d.select), () => d.select.active],
        ['paint', 'P', 'paint the ground: grass, sand, water, rock', tool(d.brush), () => d.brush.active],
        ['objects', 'O', 'spray or place trees, bushes, rocks, plants', tool(d.objects), () => d.objects.active],
        ['height', 'H', 'raise, lower, smooth, flatten the ground', tool(d.height), () => d.height.active],
      ],
      [
        ['top', 'T', 'top-down view', () => d.editor.toggleMode(), () => d.editor.mode === 'top'],
        ['grid', 'G', 'grid on the ground', () => d.editor.setGrid(!d.editor.grid), () => d.editor.grid],
        ['lab', 'L', 'look lab: compare lighting, weather and water side by side', () => {
          try {
            d.lab.setEnabled(!d.lab.enabled);
          } catch (e) {
            d.flash(e instanceof Error ? e.message : String(e));
          }
        }, () => d.lab.enabled],
      ],
      [
        ['play', 'F', 'play: walk the canvas in first person', () => {
          try {
            d.play.toggle();
          } catch (e) {
            d.flash(e instanceof Error ? e.message : String(e));
          }
        }, () => d.play.playing],
      ],
      [
        ['undo', '^Z', 'undo', () => d.undo.undo()],
        ['redo', '^Y', 'redo', () => d.undo.redo()],
        ['save', '^S', 'save the scene', () => {
          try {
            const r = d.scenes.save();
            d.flash(`saved "${r.name}"`);
          } catch (e) {
            d.flash(e instanceof Error ? e.message : String(e));
          }
        }],
      ],
      [
        ['options', 'Tab', 'show / hide the options sidebar', () => d.dock.toggle(), () => d.dock.shown],
        ['terminal', '`', 'terminal', d.openTerminal],
        ['menu', 'Esc', 'menu: settings, scenes, debug, help', d.openMenu],
      ],
    ];
    groups.forEach((g, gi) => {
      if (gi) {
        const sep = document.createElement('span');
        sep.className = 'tui-sep';
        sep.textContent = '│';
        this.el.append(sep);
      }
      for (const [label, key, help, run, on] of g) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tui-tool';
        b.dataset.tool = label;
        b.title = `${help} (${key})`;
        b.innerHTML = `<span class="tui-key">${key}</span> ${label}`;
        b.addEventListener('click', () => {
          run();
          this.refresh();
          b.blur(); // keys go back to the app, not the button
        });
        this.el.append(b);
        this.buttons.push({ el: b, on });
      }
    });
    for (const type of ['pointerdown', 'wheel', 'contextmenu'] as const) this.el.addEventListener(type, (e) => e.stopPropagation());
    root.appendChild(this.el);
    makeMovable(this.el, grip, 'toolbar');
    for (const t of [d.brush, d.objects, d.select, d.height, d.editor]) t.onChange(() => this.refresh());
    d.dock.onChange(() => this.refresh());
    d.lab.onChange(() => this.refresh());
    d.play.onChange(() => this.refresh());
    app.onSceneChange(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    const canvas = !!this.app.world;
    for (const b of this.buttons) {
      b.el.classList.toggle('tui-sel', !!b.on?.());
      // Editing tools are for the canvas.
      if (['select', 'paint', 'objects', 'height', 'top', 'grid', 'lab', 'play'].includes(b.el.dataset.tool ?? '')) b.el.disabled = !canvas;
    }
  }
}
