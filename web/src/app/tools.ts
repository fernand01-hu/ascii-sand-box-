// One editing tool at a time: the terrain brush (P), the object brush (O),
// the select tool (V) or the height brush (H). Turning one on turns
// whichever was on off.

export type ToolName = 'paint' | 'objects' | 'select' | 'height';

export class ToolSwitch {
  active: ToolName | null = null;
  private offs = new Map<ToolName, () => void>();

  /** `name` is turning on: turn the active tool off first. `off` turns `name` off later. */
  claim(name: ToolName, off: () => void): void {
    this.offs.set(name, off);
    if (this.active && this.active !== name) {
      const prev = this.offs.get(this.active);
      this.active = null;
      prev?.();
    }
    this.active = name;
  }

  release(name: ToolName): void {
    if (this.active === name) this.active = null;
  }
}
