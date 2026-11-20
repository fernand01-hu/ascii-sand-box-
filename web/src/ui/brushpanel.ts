// The brush panel: shown while the brush is on, docked bottom-left. A tool
// panel: clicked and dragged with the mouse, never takes the keyboard (the
// brush keys keep working). Built from the TUI widgets.

import type { App } from '../app/app';
import { BRUSH_SIZES } from '../app/brush';
import { PAINT_KEYS, type BrushTool } from '../app/brushtool';
import { Checkbox, Panel, Slider, Text } from './widgets';

export class BrushPanel {
  readonly panel: Panel;

  constructor(app: App, brush: BrushTool, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'brush', hint: 'P close', className: 'tui-brush tui-paint', modal: false, docked: true }, root);
    const kinds = ['canvas', ...PAINT_KEYS];
    // One checkbox per paint, acting as radio buttons.
    const paints = kinds.map((k) => {
      const key = k === 'canvas' ? 'E' : String(PAINT_KEYS.indexOf(k) + 1);
      const label = k === 'canvas' ? 'eraser (canvas #)' : k;
      return new Checkbox(`${label.padEnd(18)} ${key}`, brush.kind === k, () => brush.setKind(k));
    });
    const W = 10;
    const sizeIndex = () => {
      const i = BRUSH_SIZES.findIndex((s) => s >= brush.radius - 1e-9);
      return i < 0 ? BRUSH_SIZES.length - 1 : i;
    };
    const size = new Slider({
      label: 'size', labelWidth: W, min: 0, max: BRUSH_SIZES.length - 1, step: 1, value: sizeIndex(), width: 12,
      format: (i) => `${BRUSH_SIZES[i]} m  [ ]`, onChange: (i) => brush.setSize(BRUSH_SIZES[i]!),
    });
    const square = new Checkbox('square brush', brush.shape === 'square', (on) => brush.setShape(on ? 'square' : 'circle'));
    const strength = new Slider({
      label: 'strength', labelWidth: W, min: 0.05, max: 1, step: 0.05, value: brush.strength, width: 12,
      onChange: (v) => brush.setStrength(v),
    });
    const soft = new Slider({
      label: 'soft edge', labelWidth: W, min: 0, max: 1, step: 0.05, value: brush.soft, width: 12,
      onChange: (v) => brush.setSoft(v),
    });
    this.panel.add(
      new Text('paint', 'tui-head'), ...paints,
      new Text('brush', 'tui-head'), size, square, strength, soft,
      new Text('left drag paints · right drag pans', 'tui-dim'),
      new Text('Ctrl+Z undo · Ctrl+Y redo', 'tui-dim'),
    );
    const sync = () => {
      kinds.forEach((k, i) => paints[i]!.set(brush.kind === k));
      size.set(sizeIndex());
      square.set(brush.shape === 'square');
      strength.set(brush.strength);
      soft.set(brush.soft);
      if (brush.active && app.world) this.panel.open();
      else this.panel.close();
    };
    brush.onChange(sync);
    sync();
  }
}
