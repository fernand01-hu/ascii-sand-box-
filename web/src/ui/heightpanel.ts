// The height brush panel: docked bottom-left while the height brush is on.
// Mouse only: the brush keys keep working.

import type { App } from '../app/app';
import { HEIGHT_MODES } from '../app/heightbrush';
import type { HeightTool } from '../app/heighttool';
import { Checkbox, Panel, Slider, Text } from './widgets';

export class HeightPanel {
  readonly panel: Panel;

  constructor(app: App, tool: HeightTool, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'height', hint: 'H close', className: 'tui-brush tui-height', modal: false }, root);
    const modes = HEIGHT_MODES.map((m, i) => new Checkbox(`${m.padEnd(8)} ${i + 1}`, tool.mode === m, () => tool.setMode(m)));
    const size = new Slider({ label: 'size', labelWidth: 10, min: 1, max: 32, step: 1, value: tool.radius, width: 12, format: (v) => `${v} m  [ ]`, onChange: (v) => tool.set({ radius: v }) });
    const strength = new Slider({
      label: 'strength', labelWidth: 10, min: 0.05, max: 3, step: 0.05, value: tool.strength, width: 12,
      format: (v) => (tool.mode === 'raise' || tool.mode === 'lower' ? `${v.toFixed(2)} m` : `${Math.round(Math.min(1, v) * 100)}%`),
      onChange: (v) => tool.set({ strength: v }),
    });
    this.panel.add(new Text('mode', 'tui-head'), ...modes, new Text('brush', 'tui-head'), size, strength,
      new Text('left drag shapes · right drag pans', 'tui-dim'), new Text('flatten: to the height where you start', 'tui-dim'), new Text('Ctrl+Z undo', 'tui-dim'));
    const sync = () => {
      HEIGHT_MODES.forEach((m, i) => modes[i]!.set(tool.mode === m));
      size.set(tool.radius);
      strength.set(tool.strength);
      if (tool.active && app.world) this.panel.open();
      else this.panel.close();
    };
    tool.onChange(sync);
    sync();
  }
}
