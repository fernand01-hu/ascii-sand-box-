// Play mode (Phase 4): walk the canvas you made, in first person.
//   F (or the toolbar's play button)  play / back to editing
//   WASD / arrows walk, Shift run, Space jump, mouse look (click the view
//   to capture the mouse; Esc releases it, Esc again goes back to editing)
// While playing, the editing tools are off and their keys stay quiet; the
// world streams round the player; the physics reads the painted map: its
// heights, trunks, rocks and big bushes to bump into, water to wade through
// (half speed, knee deep, no running or jumping), sand a little slower.

import type { Editor } from './editor';
import type { App } from './app';
import type { Lab } from './lab';
import type { ToolSwitch } from './tools';
import { prependRootKeys } from '../ui/widgets';

/** Keys the walking player uses: they go to the player, not to the editor. */
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space']);

export class PlayMode {
  private listeners = new Set<() => void>();

  constructor(private app: App, private tools: ToolSwitch, private editor: Editor, private lab: Lab) {
    prependRootKeys((e) => {
      if (!this.playing) {
        if (e.key.toLowerCase() === 'f' && this.app.world) {
          this.start();
          return true;
        }
        return false;
      }
      if (e.key.toLowerCase() === 'f' || e.key === 'Escape') {
        this.stop();
        return true;
      }
      if (MOVE.has(e.code)) return false; // for the player
      // The terminal and the options keep working; the editor's keys stay quiet.
      return !(e.key === '`' || e.key === 'F1' || e.key === 'F3' || e.key === 'Tab');
    });
    app.onSceneChange(() => {
      if (!app.player) this.changed();
    });
  }

  get playing(): boolean {
    return !!this.app.player;
  }

  onChange(f: () => void): void {
    this.listeners.add(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }

  start(): void {
    if (this.playing) return;
    if (!this.app.world) throw new Error('play mode walks the canvas (run: canvas)');
    this.tools.offAll();
    if (this.editor.mode === 'top') this.editor.setMode('orbit');
    if (this.lab.enabled) this.lab.setEnabled(false);
    this.app.play();
    this.changed();
  }

  stop(): void {
    if (!this.playing) return;
    this.app.stopPlaying();
    this.changed();
  }

  toggle(): void {
    if (this.playing) this.stop();
    else this.start();
  }
}
