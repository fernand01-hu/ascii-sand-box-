// Owns the WebGL renderer, camera, mouse orbit controls and the two scene
// layers: the model's body (drawn in the background colour, it only hides
// cards behind the model) and the ASCII cards. Renders only when something
// changed, so an idle page costs nothing.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { GlyphAtlas } from './atlas';
import { CardLayer } from './cards';
import { Underpaint } from './underpaint';

export const BACKGROUND = new Color(0x090c13);

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(35, 1, 0.01, 100);
  readonly controls: OrbitControls;
  readonly cards: CardLayer;
  /** Faint colour wash behind the glyphs, taken from the scene. */
  readonly underpaint: Underpaint;
  private body: Mesh<BufferGeometry, MeshBasicMaterial>;
  private dirty = true;
  private raf = 0;
  private resizeObserver: ResizeObserver;
  private contextLost = false;
  /** Render every frame and advance the animation clock (wind, water, rain). */
  animate = false;
  private clockStart = performance.now();
  private frozenTime: number | null = null;

  constructor(private container: HTMLElement, atlas: GlyphAtlas) {
    this.renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(BACKGROUND, 1);
    container.appendChild(this.renderer.domElement);
    atlas.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.renderer.autoClear = false; // draw() clears (or the underpaint paints the background)
    // Opaque bodies only write depth: they hide what is behind them, and the
    // background (or the underpaint wash) shows where they are.
    this.body = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ color: BACKGROUND, colorWrite: false }));
    this.body.visible = false;
    this.cards = new CardLayer(atlas);
    this.underpaint = new Underpaint(this.cards);
    this.scene.add(this.body, this.cards.group);

    this.camera.position.set(3, 2, 5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.addEventListener('change', () => this.requestRender());

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const canvas = this.renderer.domElement;
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.raf = requestAnimationFrame(this.loop);
  }

  /** Replace the model body and frame the camera on it (STL models). */
  setMesh(positions: Float32Array, normals: Float32Array): void {
    const g = this.setBody(positions, normals);
    this.cards.setMode('blend');
    this.controls.maxPolarAngle = Math.PI;
    this.camera.fov = 35;
    this.frame(g.boundingSphere ?? new Sphere(new Vector3(0, 1, 0), 1.5));
    this.requestRender();
  }

  /** Opaque body drawn in the background colour: it only hides what is behind it. */
  private setBody(positions: Float32Array, normals: Float32Array): BufferGeometry {
    if (positions.length === 0 || positions.length % 9 !== 0 || normals.length !== positions.length) {
      throw new Error('mesh buffers are empty or inconsistent');
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('normal', new BufferAttribute(normals, 3));
    g.computeBoundingSphere();
    this.body.geometry.dispose();
    this.body.geometry = g;
    this.body.visible = true;
    return g;
  }

  /**
   * Show a free-standing procedural scene (foliage, scenery): order-independent
   * transparency, camera placed explicitly, orbit kept above the ground.
   * `body` (optional) is an opaque occluder, e.g. rocks and trunks.
   */
  setFreeScene(
    target: Vector3,
    eye: Vector3,
    opts: { fov?: number; far?: number; body?: { positions: Float32Array; normals: Float32Array } } = {},
  ): void {
    if (opts.body && opts.body.positions.length > 0) {
      this.setBody(opts.body.positions, opts.body.normals);
      this.cards.setMode('coverage', 0.75); // cards must win against the body they sit on
    } else {
      this.body.visible = false;
      this.cards.setMode('coverage');
    }
    this.camera.fov = opts.fov ?? 35;
    const dist = eye.distanceTo(target);
    this.controls.target.copy(target);
    this.camera.position.copy(eye);
    this.camera.near = dist / 200;
    this.camera.far = opts.far ?? dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = dist * 0.15;
    this.controls.maxDistance = dist * 3;
    this.controls.maxPolarAngle = Math.PI * 0.495; // don't orbit under the ground
    this.controls.update();
    this.requestRender();
  }

  setCards(data: Float32Array, stride: number, chunks?: Float32Array): void {
    this.cards.setCards(data, stride, chunks);
    this.requestRender();
  }

  requestRender(): void {
    this.dirty = true;
  }

  /** Draw one frame: background (or underpaint wash), then the glyphs. */
  private draw(): void {
    this.cards.drawn = 0;
    if (this.underpaint.enabled) {
      this.underpaint.render(this.renderer, this.scene, this.camera, this.cards, this.background);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
    }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Render now and count pixels that differ from the background (for tests).
   * Measured without the underpaint, so it counts glyphs, not the wash.
   */
  coverage(): number {
    const wash = this.underpaint.enabled;
    this.underpaint.enabled = false;
    this.draw();
    this.underpaint.enabled = wash;
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const bg = this.background.clone().convertLinearToSRGB();
    const [br, bgc, bb] = [bg.r * 255, bg.g * 255, bg.b * 255];
    let lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (Math.abs(px[i]! - br) + Math.abs(px[i + 1]! - bgc) + Math.abs(px[i + 2]! - bb) > 24) lit++;
    }
    return lit / (w * h);
  }

  /** CSS pixels per world unit at the orbit target's distance. */
  pixelsPerUnit(): number {
    const h = this.renderer.domElement.clientHeight || 1;
    const dist = this.camera.position.distanceTo(this.controls.target);
    return h / 2 / Math.tan((this.camera.fov * Math.PI) / 360) / Math.max(dist, 1e-6);
  }

  /**
   * Render now and return a small block-averaged RGB image (row-major, from
   * the bottom row up), used by the visual regression tests.
   */
  thumbnail(w = 48, h = 36): number[] {
    this.draw();
    const gl = this.renderer.getContext();
    const W = gl.drawingBufferWidth;
    const H = gl.drawingBufferHeight;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const sums = new Float64Array(w * h * 3);
    const counts = new Float64Array(w * h);
    for (let y = 0; y < H; y++) {
      const ty = Math.min(h - 1, Math.floor((y * h) / H));
      for (let x = 0; x < W; x++) {
        const t = ty * w + Math.min(w - 1, Math.floor((x * w) / W));
        const i = (y * W + x) * 4;
        sums[t * 3] = sums[t * 3]! + px[i]!;
        sums[t * 3 + 1] = sums[t * 3 + 1]! + px[i + 1]!;
        sums[t * 3 + 2] = sums[t * 3 + 2]! + px[i + 2]!;
        counts[t] = counts[t]! + 1;
      }
    }
    return Array.from(sums, (s, k) => Math.round(s / Math.max(1, counts[Math.floor(k / 3)]!)));
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.controls.dispose();
    this.cards.dispose();
    this.underpaint.dispose();
    this.body.geometry.dispose();
    this.body.material.dispose();
    this.renderer.dispose();
    canvas.remove();
  }

  private frame(bounds: Sphere): void {
    const r = Math.max(bounds.radius, 1e-3);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fit = Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect));
    const dist = (r / Math.sin(fit / 2)) * 1.05;
    const dir = new Vector3(0.55, 0.32, 1).normalize();
    this.controls.target.copy(bounds.center);
    this.camera.position.copy(bounds.center).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    // Never closer than the bounding sphere, or the camera ends up inside the model.
    this.controls.minDistance = r * 1.08;
    this.controls.maxDistance = dist * 6;
    this.controls.update();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    const db = this.renderer.getDrawingBufferSize(new Vector2());
    this.underpaint.setSize(db.x, db.y);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  /** Background between the glyphs (and colour of the opaque bodies). */
  setBackground(color: Color): void {
    this.renderer.setClearColor(color, 1);
    this.body.material.color.copy(color);
    this.background.copy(color);
    this.requestRender();
  }

  private background = BACKGROUND.clone();

  /** Freeze the animation clock at `t` seconds (tests), or `null` to run. */
  freezeTime(t: number | null): void {
    this.frozenTime = t;
    if (t !== null) this.cards.setTime(t);
    this.requestRender();
  }

  /** Called every frame with the time step (s) while set; e.g. the player. */
  onFrame: ((dt: number) => void) | null = null;
  private lastFrame = performance.now();

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.contextLost) return;
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    if (this.onFrame) {
      this.onFrame(dt);
      this.dirty = true;
    }
    const moved = this.controls.enabled && this.controls.update(); // keeps damping going
    if (this.animate && this.frozenTime === null) {
      this.cards.setTime((performance.now() - this.clockStart) / 1000);
      this.dirty = true;
    }
    if (moved || this.dirty) {
      this.dirty = false;
      this.draw();
    }
  };

  private onContextLost = (e: Event): void => {
    e.preventDefault(); // lets the browser restore the context later
    this.contextLost = true;
    console.warn('WebGL context lost; waiting for it to be restored');
  };

  private onContextRestored = (): void => {
    this.contextLost = false;
    this.requestRender();
  };
}
