// The parameter panel: shown with the object brush (docked bottom-right),
// built from the engine's description of each kind's parameters, so a new
// parameter gets its slider here by itself. A live preview of the object,
// a slider per parameter, reset, another variant, presets (pick one, or save
// the current values under a name). Mouse only: the brush keys keep working.

import type { App } from '../app/app';
import type { ObjectTool } from '../app/objecttool';
import type { PresetStore } from '../app/presets';
import { ObjectPreview } from './preview';
import { Choice, List, Panel, Slider, Text, TextInput, type Widget } from './widgets';

/** Wrap a plain element as a panel row that can't take focus. */
function row(el: HTMLElement): Widget {
  return { el, focusable: false, setFocus() {}, key: () => false };
}

const PICK = '(pick a preset)';

export class ParamPanel {
  readonly panel: Panel;
  readonly preview: ObjectPreview;
  private sliders = new Map<string, Slider>();
  private builtFor = '';
  private variant = 1;

  constructor(private app: App, private tool: ObjectTool, private presets: PresetStore, root: HTMLElement = document.body) {
    this.panel = new Panel({ title: 'parameters', className: 'tui-params', modal: false }, root);
    this.preview = new ObjectPreview(app);
    tool.onChange(() => this.sync());
    presets.onChange(() => this.rebuild());
    this.sync();
  }

  private sync(): void {
    const show = this.tool.active && this.tool.mode !== 'erase' && !!this.app.world;
    if (!show) {
      this.panel.close();
      return;
    }
    this.panel.open();
    if (this.builtFor !== this.tool.kind) this.rebuild();
    for (const [name, s] of this.sliders) s.set(this.tool.param(name));
    this.refreshPreview();
  }

  /** The kind the preview shows: the brush's kind, or a family member for a mix. */
  private previewKind(): string {
    const k = this.tool.kind;
    if (!k.endsWith(':*')) return k;
    const fam = (this.app.map?.info.objectKinds ?? []).filter((x) => x.split(':')[0] === k.split(':')[0]);
    return fam[this.variant % Math.max(1, fam.length)] ?? k;
  }

  private refreshPreview(): void {
    const k = this.previewKind();
    this.preview.show(k, this.tool.paramsFor(k), this.variant);
  }

  private rebuild(): void {
    const t = this.tool, p = this.panel;
    this.builtFor = t.kind;
    this.sliders.clear();
    p.clear();
    const kindName = t.kind.endsWith(':*') ? `any ${t.kind.split(':')[0]}` : t.kind;
    p.add(new Text(kindName, 'tui-head'), row(this.preview.el), row(this.preview.info));
    const descs = t.paramDescs();
    if (!descs.length) p.add(new Text('no parameters for this kind', 'tui-dim'));
    for (const d of descs) {
      const s = new Slider({
        label: d.label.length > 20 ? `${d.label.slice(0, 19)}.` : d.label, labelWidth: 21, min: d.min, max: d.max, step: d.step, value: t.param(d.name), width: 10,
        format: (v) => (d.step >= 1 ? String(Math.round(v)) : v.toFixed(2)), onChange: (v) => t.setParam(d.name, v),
      });
      this.sliders.set(d.name, s);
      p.add(s);
    }
    p.add(new List([
      { label: 'reset to defaults', run: () => t.resetParams() },
      { label: 'another variant (preview)', run: () => { this.variant++; this.refreshPreview(); } },
    ]));
    const names = this.presets.list(t.kind).map((x) => x.name);
    p.add(
      new Text('presets', 'tui-head'),
      new Choice({
        label: 'load', labelWidth: 8, options: [PICK, ...names], value: PICK,
        onChange: (v) => {
          const pr = v === PICK ? undefined : this.presets.get(v);
          if (pr) t.applyPreset(pr);
        },
      }),
      new TextInput({
        label: 'save as', labelWidth: 8, ownKeys: true, placeholder: 'e.g. tall oak', clearOnSubmit: true,
        onSubmit: (v) => {
          try {
            this.presets.save(v, t.kind, t.changedParams());
            return;
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        },
      }),
    );
  }
}
