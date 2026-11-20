// Owns the WebGL renderer, camera, mouse orbit controls and the two scene
// layers: the model's body (drawn in the background colour, it only hides
// cards behind the model) and the ASCII cards. Renders only when something
// changed, so an idle page costs nothing.

import {
  Group,
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

export interface ViewPane {
  x: number;
  y: number;
  w: number;
  h: number;
  /** The view it is a strip of (wipe), as x, y, w, h fractions; default: its own rectangle. */
  view?: [number, number, number, number];
  apply: () => void;
}

export class Viewer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  /** Debug lines and markers: drawn over the glyphs, left out of the underpaint wash. */
  readonly overlay = new Group();
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
  // World clock (drives wind, water, rain, leaves): base + elapsed x speed.
  private clockBase = 0;
  private clockSince = performance.now();
  private clockSpeed = 1;
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
    this.overlay.renderOrder = 2;
    this.scene.add(this.body, this.cards.group, this.overlay);

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

  private bodies = new Map<string, Mesh<BufferGeometry, MeshBasicMaterial>>();

  /** Add (or replace) a named opaque body, e.g. one streamed world chunk. */
  addBody(key: string, positions: Float32Array, normals: Float32Array): void {
    this.removeBody(key);
    if (positions.length === 0) return;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('normal', new BufferAttribute(normals, 3));
    g.computeBoundingSphere();
    const m = new Mesh(g, this.body.material);
    this.bodies.set(key, m);
    this.scene.add(m);
  }

  removeBody(key: string): void {
    const m = this.bodies.get(key);
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
    this.bodies.delete(key);
  }

  clearBodies(): void {
    for (const k of [...this.bodies.keys()]) this.removeBody(k);
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
    this.stopMotion();
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

  /**
   * Split view (look lab): panes drawn one after the other from the same
   * camera, each after its `apply` sets its look. Fractions of the canvas,
   * y from the top. A `wipe` pane keeps the full view and only shows its
   * strip of it (before / after across a divider); the others each show the
   * whole view, narrower.
   */
  panes: ViewPane[] | null = null;
  /** Called once per frame before drawing (e.g. the sun shadow map). */
  beforeDraw: (() => void) | null = null;

  /** The pane under a canvas point (CSS px), for picking in a split view. */
  paneAt(x: number, y: number): ViewPane | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
    return this.panes?.find((p) => fx >= p.x && fx < p.x + p.w && fy >= p.y && fy < p.y + p.h) ?? null;
  }

  /** Draw one frame: each pane, or the whole canvas. */
  private draw(): void {
    this.beforeDraw?.();
    const panes = this.panes;
    if (!panes || panes.length === 0) {
      this.drawView();
      return;
    }
    const size = this.renderer.getSize(new Vector2());
    const W = size.x, H = size.y, aspect = this.camera.aspect;
    let drawn = 0;
    // Clear the whole canvas first: panes may not cover all of it.
    this.renderer.setRenderTarget(null);
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, W, H);
    this.renderer.clear();
    this.renderer.setScissorTest(true);
    for (const p of panes) {
      const px = Math.round(p.x * W), pw = Math.round((p.x + p.w) * W) - px;
      const ph = Math.round((p.y + p.h) * H) - Math.round(p.y * H), py = H - Math.round(p.y * H) - ph;
      if (p.view) {
        const [vx, vy, vw, vh] = p.view;
        const X = Math.round(vx * W), Wd = Math.round(vw * W), Hd = Math.round(vh * H), Y = H - Math.round(vy * H) - Hd;
        this.renderer.setViewport(X, Y, Wd, Hd);
        this.camera.aspect = Wd / Math.max(Hd, 1);
      } else {
        this.renderer.setViewport(px, py, pw, ph);
        this.camera.aspect = pw / Math.max(ph, 1);
      }
      this.camera.updateProjectionMatrix();
      this.renderer.setScissor(px, py, pw, ph);
      p.apply();
      this.drawView();
      drawn += this.cards.drawn;
    }
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, W, H);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.cards.drawn = drawn;
  }

  /** Draw the view: background (or underpaint wash), then the glyphs. */
  private drawView(): void {
    this.cards.cullSky(this.camera);
    this.cards.applyBudget(this.camera);
    if (this.underpaint.enabled) {
      this.overlay.visible = false;
      this.underpaint.render(this.renderer, this.scene, this.camera, this.cards, this.background);
      this.overlay.visible = true;
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
    }
    this.cards.drawn = 0; // count the glyph pass only, not the underpaint
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Frame statistics, refreshed twice a second: frames drawn per second
   * (0 while nothing changes, so nothing is redrawn), average time between
   * them, CPU time spent submitting a frame, and glyph cards drawn in the
   * last frame after culling.
   */
  readonly stats = { fps: 0, frameMs: 0, drawMs: 0, drawn: 0 };
  private statFrames = 0;
  private statDrawMs = 0;
  private statSince = performance.now();

  private updateStats(now: number): void {
    const span = now - this.statSince;
    if (span < 500) return;
    const s = this.stats;
    s.fps = (this.statFrames * 1000) / span;
    s.frameMs = this.statFrames ? span / this.statFrames : 0;
    s.drawMs = this.statFrames ? this.statDrawMs / this.statFrames : 0;
    this.statFrames = 0;
    this.statDrawMs = 0;
    this.statSince = now;
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

  /** Draw a frame now and return it as a PNG data URL (the `screenshot` command). */
  snapshot(): string {
    this.draw();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /** Glyph stacking on screen right now (see CardLayer.stacking). */
  stacking(cellPx = 16): ReturnType<CardLayer['stacking']> {
    const el = this.renderer.domElement;
    return this.cards.stacking(this.camera, el.clientWidth || 1, el.clientHeight || 1, cellPx);
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

  /**
   * Drop the camera's leftover momentum (damping keeps it gliding after a
   * drag or a wheel turn). Call before placing the camera, or the old glide
   * carries on into the new view.
   */
  stopMotion(): void {
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update(); // applies what was left, all at once
    this.controls.enableDamping = damping;
  }

  private frame(bounds: Sphere): void {
    this.stopMotion();
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
    if (t === null && this.frozenTime !== null) this.setClock(this.frozenTime);
    this.frozenTime = t;
    if (t !== null) this.cards.setTime(t);
    this.requestRender();
  }

  /** The world clock, seconds (what wind, water, rain and leaves animate from). */
  get clock(): number {
    return this.frozenTime ?? this.clockBase + ((performance.now() - this.clockSince) / 1000) * this.clockSpeed;
  }

  get clockFrozen(): boolean {
    return this.frozenTime !== null;
  }

  /** Set the world clock to `t` seconds; it keeps running from there. */
  setClock(t: number): void {
    this.clockBase = t;
    this.clockSince = performance.now();
    if (this.frozenTime !== null) this.frozenTime = t;
    this.cards.setTime(t);
    this.requestRender();
  }

  /** How fast the world clock runs (1 = real time, 0.25 slow motion, 0 stopped). */
  get clockRate(): number {
    return this.clockSpeed;
  }

  setClockRate(speed: number): void {
    this.setClock(this.clock); // re-base so the clock doesn't jump
    this.clockSpeed = Math.max(0, speed);
  }

  /** The opaque bodies (hidden solid shapes) by set key, for the debug wireframe. */
  get bodyMeshes(): ReadonlyMap<string, Mesh<BufferGeometry, MeshBasicMaterial>> {
    return this.bodies;
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
      this.cards.setTime(this.clock);
      this.dirty = true;
    }
    if (moved || this.dirty) {
      this.dirty = false;
      const t0 = performance.now();
      this.draw();
      this.statDrawMs += performance.now() - t0;
      this.statFrames++;
      this.stats.drawn = this.cards.drawn;
    }
    this.updateStats(now);
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
