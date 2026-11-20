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

  /** The ground point under screen position (x, y) in CSS px (on the real terrain). */
  groundAt(x: number, y: number): { x: number; z: number } | null {
    const p = this.groundPoint(x, y);
    return p ? { x: p.x, z: p.z } : null;
  }

  /** The ground point (with its height) under screen position (x, y). */
  groundPoint(x: number, y: number): { x: number; y: number; z: number } | null {
    const v = this.app.viewer, el = v.renderer.domElement;
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    this.ray.setFromCamera(new Vector2((x / w) * 2 - 1, 1 - (y / h) * 2), v.camera);
    const g = this.app.world?.info.ground ?? 0;
    const map = this.app.map;
    if (!map?.hasHeights) {
      // Flat canvas: hit the plane.
      this.plane.constant = -g;
      const p = this.ray.ray.intersectPlane(this.plane, this.hit);
      if (!p || p.distanceTo(v.camera.position) > 5000) return null;
      return { x: p.x, y: g, z: p.z };
    }
    // Hills: step along the ray until it is under the ground, then narrow it down.
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    const above = (t: number) => o.y + d.y * t - (g + map.heightAt(o.x + d.x * t, o.z + d.z * t));
    // Fine steps (0.2 m + 1% of the distance), so a ray just touching a summit isn't missed.
    let t0 = 0, t1 = 0;
    for (let t = 0.2; t < 3000; t += 0.2 + t * 0.01) {
      if (above(t) <= 0) {
        t1 = t;
        break;
      }
      t0 = t;
    }
    if (!t1) return null;
    for (let k = 0; k < 24; k++) {
      const m = (t0 + t1) / 2;
      if (above(m) > 0) t0 = m;
      else t1 = m;
    }
    const t = (t0 + t1) / 2, px = o.x + d.x * t, pz = o.z + d.z * t;
    return { x: px, y: g + map.heightAt(px, pz), z: pz };
  }
}
