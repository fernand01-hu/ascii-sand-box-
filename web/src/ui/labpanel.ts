// The look lab's panel (in the options sidebar while the lab is on): the
// layout, each pane's lighting / weather / water variant, the shared time of
// day and weather, the test scene. What each variant does is shown under
// its pane (and in the terminal: `lab list`).

import type { App } from '../app/app';
import { LAB_VIEWS, LAYOUTS, LIGHTS, WATERS, WEATHERS, type Lab, type LabLayout, type PaneLook, type Variant } from '../app/lab';
import { Checkbox, Choice, List, Panel, Slider, Text } from './widgets';

const LAYOUT_NAMES: Record<LabLayout, string> = { '1': 'one view', wipe: 'wipe (divider)', '2': 'side by side', '4': '2 x 2' };

export class LabPanel {
  readonly panel: Panel;
  private built = '';

  constructor(private app: App, private lab: Lab, private run: (line: string) => Promise<unknown>, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'look lab', hint: 'lab off ×', className: 'tui-brush tui-lab', modal: false, docked: true, onClose: () => {
      if (lab.enabled) lab.setEnabled(false);
    } }, root);
    lab.onChange(() => this.sync());
    app.onSceneChange(() => this.sync());
    this.sync();
  }

  private sync(): void {
    if (!this.lab.enabled || !this.app.world) {
      if (!this.panel.el.hidden) this.panel.close();
      return;
    }
    const key = JSON.stringify([this.lab.layout, this.lab.panes, this.lab.hour === null]);
    if (key !== this.built || this.panel.el.hidden) this.rebuild(key);
    if (this.panel.el.hidden) this.panel.open();
  }

  private rebuild(key: string): void {
    this.built = key;
    const p = this.panel, lab = this.lab;
    p.clear();
    p.add(new Choice({
      label: 'layout', labelWidth: 9, options: LAYOUTS, value: lab.layout, format: (v) => LAYOUT_NAMES[v as LabLayout],
      onChange: (v) => lab.setLayout(v as LabLayout),
    }));
    const pick = (i: number, what: keyof PaneLook, label: string, list: Variant[]) => new Choice({
      label, labelWidth: 9, options: list.map((x) => x.id), value: lab.panes[i]![what],
      format: (id) => list.find((x) => x.id === id)?.name ?? id,
      onChange: (id) => lab.setPane(i, what, id),
    });
    for (let i = 0; i < lab.paneCount; i++) {
      const look = lab.panes[i]!;
      const help = (list: Variant[], id: string) => list.find((x) => x.id === id)?.help ?? '';
      p.add(
        new Text(lab.layout === 'wipe' ? (i === 0 ? 'left of the divider' : 'right of the divider') : `pane ${i + 1}`, 'tui-head'),
        pick(i, 'light', 'light', LIGHTS),
        pick(i, 'weather', 'weather', WEATHERS),
        pick(i, 'water', 'water', WATERS),
        new Text(`${help(LIGHTS, look.light)}; ${help(WEATHERS, look.weather)}; ${help(WATERS, look.water)}`, 'tui-dim'),
      );
    }
    p.add(new Text('shared', 'tui-head'));
    p.add(new Checkbox('scene light (untick: time of day)', lab.hour === null, (on) => lab.setHour(on ? null : 18)));
    if (lab.hour !== null) {
      p.add(new Slider({
        label: 'time', min: 0, max: 24, step: 0.25, value: lab.hour, width: 16,
        format: (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
        onChange: (v) => lab.setHour(v),
      }));
    }
    const w = this.app.state.weather;
    p.add(
      new Slider({ label: 'wind', min: 0, max: 1, step: 0.05, value: w.wind, width: 16, onChange: (v) => this.app.setEnvironment({ wind: v }) }),
      new Slider({ label: 'rain', min: 0, max: 1, step: 0.05, value: w.rain, width: 16, onChange: (v) => this.app.setEnvironment({ rain: v }) }),
      new Slider({ label: 'leaves', min: 0, max: 1, step: 0.05, value: w.leaves, width: 16, onChange: (v) => this.app.setEnvironment({ leaves: v }) }),
    );
    p.add(new Choice({
      label: 'camera', labelWidth: 9, options: ['(pick)', ...Object.keys(LAB_VIEWS)], value: '(pick)',
      onChange: (v) => {
        if (v !== '(pick)') void this.run(`lab view ${v}`);
      },
    }));
    p.add(new List([
      { label: 'build the landscape (replaces the map)', run: () => void this.run('lab landscape') },
      { label: 'build the small test scene (replaces the map)', run: () => void this.run('lab scene') },
      { label: `water current arrows (${lab.arrows ? 'on' : 'off'})`, run: () => { lab.setArrows(!lab.arrows); this.built = ''; this.sync(); } },
      { label: 'every pane like pane 1', run: () => {
        for (let i = 1; i < 4; i++) for (const k of ['light', 'weather', 'water'] as const) lab.setPane(i, k, lab.panes[0]![k]);
      } },
      { label: 'close the lab', run: () => lab.setEnabled(false) },
    ]));
    p.add(new Text('editing works in "one view" and "wipe"', 'tui-dim'));
  }
}
