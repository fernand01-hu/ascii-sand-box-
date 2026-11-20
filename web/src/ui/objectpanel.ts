// Tool panels for objects, docked bottom-left like the brush panel: the
// object brush (mode, kind, size, density, spacing, size variation) and the
// selected object (what it is, where, and the keys). Mouse only: the tools'
// keys keep working.

import type { App } from '../app/app';
import { OBJECT_MODES, type ObjectTool } from '../app/objecttool';
import type { SelectTool } from '../app/selecttool';
import { Checkbox, Choice, Panel, Slider, Text } from './widgets';

const DENSITIES = [0.5, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80];

export class ObjectPanel {
  readonly panel: Panel;

  constructor(app: App, tool: ObjectTool, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'objects', hint: 'O close', className: 'tui-brush tui-objects', modal: false }, root);
    const W = 10;
    const modes = OBJECT_MODES.map((m, i) => new Checkbox(`${m.padEnd(8)} ${i + 1}`, tool.mode === m, () => tool.setMode(m)));
    const kind = new Choice({
      label: 'kind', labelWidth: W, options: tool.kinds(), value: tool.kind,
      format: (k) => (k.endsWith(':*') ? `any ${k.split(':')[0]}` : k), onChange: (k) => tool.setKind(k),
    });
    const size = new Slider({ label: 'size', labelWidth: W, min: 0.5, max: 32, step: 0.5, value: tool.radius, width: 12, format: (v) => `${v} m  [ ]`, onChange: (v) => tool.set({ radius: v }) });
    const di = () => Math.max(0, DENSITIES.findIndex((d) => d >= tool.density - 1e-9));
    const density = new Slider({
      label: 'density', labelWidth: W, min: 0, max: DENSITIES.length - 1, step: 1, value: di(), width: 12,
      format: (i) => `${DENSITIES[i]} / 100 m²`, onChange: (i) => tool.set({ density: DENSITIES[i]! }),
    });
    const spacing = new Slider({ label: 'spacing', labelWidth: W, min: 0.25, max: 3, step: 0.25, value: tool.spacing, width: 12, format: (v) => `x${v}`, onChange: (v) => tool.set({ spacing: v }) });
    const variation = new Slider({ label: 'size ±', labelWidth: W, min: 0, max: 0.8, step: 0.05, value: tool.variation, width: 12, format: (v) => `${Math.round(v * 100)}%`, onChange: (v) => tool.set({ variation: v }) });
    this.panel.add(new Text('mode', 'tui-head'), ...modes, new Text('objects', 'tui-head'), kind, size, density, spacing, variation,
      new Text('left drag: spray / erase · click: single', 'tui-dim'), new Text('Ctrl+Z undo · V select tool', 'tui-dim'));
    const sync = () => {
      OBJECT_MODES.forEach((m, i) => modes[i]!.set(tool.mode === m));
      kind.setOptions(tool.kinds());
      kind.set(tool.kind);
      size.set(tool.radius);
      density.set(di());
      spacing.set(tool.spacing);
      variation.set(tool.variation);
      if (tool.active && app.world) this.panel.open();
      else this.panel.close();
    };
    tool.onChange(sync);
    sync();
  }
}

export class SelectPanel {
  readonly panel: Panel;

  constructor(app: App, tool: SelectTool, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'select', hint: 'V close', className: 'tui-brush tui-select', modal: false }, root);
    const what = new Text('click an object to select it');
    const where = new Text('', 'tui-dim');
    this.panel.add(what, where, new Text('drag: move · R: turn (Shift back)', 'tui-dim'), new Text('[ ]: size · Delete: remove · Esc: let go', 'tui-dim'));
    const sync = () => {
      const o = tool.object();
      what.set(o ? `#${o.id} ${o.kind}` : 'click an object to select it');
      where.set(o ? `at (${o.x.toFixed(1)}, ${o.z.toFixed(1)})  ${Math.round((o.yaw * 180) / Math.PI)}°  x${o.scale.toFixed(2)}  seed ${o.seed}` : '');
      if (tool.active && app.world) this.panel.open();
      else this.panel.close();
    };
    tool.onChange(sync);
    sync();
  }
}
