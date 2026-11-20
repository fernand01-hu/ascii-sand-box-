// Where the mouse is: on screen, and the point of the ground under it
// (a ray from the camera through the mouse, hitting the flat canvas). The
// debug tools use it now; the brushes (TODO step 6+) will paint with it.

import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { App } from './app';

export class Cursor {
  /** Mouse position in CSS px from the canvas's top-left, or null when off it. */
  screen: { x: number; y: number } | null = null;
  private ray = new Raycaster();
  private plane = new Plane(new Vector3(0, 1, 0), 0);
  private hit = new Vector3();

  constructor(private app: App) {
    const el = app.viewer.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    });
    el.addEventListener('pointerleave', () => (this.screen = null));
  }

  /** The ground point under the mouse (null off the canvas or above the horizon). */
  ground(): { x: number; z: number } | null {
    if (!this.screen) return null;
    return this.groundAt(this.screen.x, this.screen.y);
  }

  /** The ground point under screen position (x, y) in CSS px. */
  groundAt(x: number, y: number): { x: number; z: number } | null {
    const v = this.app.viewer, el = v.renderer.domElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.ray.setFromCamera(new Vector2((x / w) * 2 - 1, 1 - (y / h) * 2), v.camera);
    this.plane.constant = -(this.app.world?.info.ground ?? 0);
    const p = this.ray.ray.intersectPlane(this.plane, this.hit);
    if (!p || p.distanceTo(v.camera.position) > 5000) return null;
    return { x: p.x, z: p.z };
  }
}
