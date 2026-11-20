// All cards are one instanced draw: a unit quad instanced once per card, with
// the card data read straight from the engine's Float32Array. Lighting runs
// per card in the vertex shader, so moving the camera or the sun is free;
// only changing the cards themselves touches the CPU.
//
// The environment is animated here too, from a time uniform: wind sways
// flexible cards (grass, leaves, needles, reeds) with gusts that travel
// downwind, streams slide along their flow, rain falls in a box that follows
// the camera, and blown leaves drift and tumble across the scene.

import {
  BufferAttribute,
  Frustum,
  Group,
  Matrix4,
  type PerspectiveCamera,
  Sphere,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import type { GlyphAtlas } from './atlas';
import { CHUNK_FLOATS } from '../engine/chunks';

/** Must match `cards::STRIDE` / `cards::layout` in the Rust engine. */
export const CARD_STRIDE = 16;
/**
 * Glyph slot = atlas index + 1024 * (material + 64 * mode). Must match
 * `cards::MATERIAL_SHIFT` and `scenery::skin::pack` in the Rust engine.
 * mode 0 uses the material's own billboard setting; 1 billboard round V,
 * 2 billboard round U, 3 solid (back faces not drawn), 4 emissive (colour
 * as given: sky), 5 rain particle, 6 blown-leaf particle, 7 ground mark and
 * 8 water glyph: stored flat on the surface and leaned toward the *current*
 * camera every frame, so they read from any viewing angle.
 */
const MATERIAL_SHIFT = 1024;
/** Size of the shader's material table. */
export const MAX_MATERIALS = 64;

export interface Lighting {
  sunDir: Vector3;
  sunColor: Vector3;
  skyColor: Vector3;
  glintColor: Vector3;
  /** Tone curve: colour = 1 - exp(-exposure * radiance). Default 2.2. */
  exposure?: number;
  /** Sky light strength (default 0.5) and constant ambient (default 0.03). */
  skyGain?: number;
  ambient?: number;
  /** 1: sky light falls off on downward-facing cards; 0: uniform. Default 1. */
  hemi?: number;
}

export const DEFAULT_LIGHTING: Lighting = {
  sunDir: new Vector3(-0.6, 0.55, 0.6).normalize(),
  sunColor: new Vector3(1.3, 0.92, 0.58),
  skyColor: new Vector3(0.46, 0.52, 0.8),
  glintColor: new Vector3(1.0, 0.86, 0.62),
};

/**
 * Per-material shading, indexed by the material id packed in each card.
 *   spec, shininess  Blinn-Phong glint
 *   trans            light passing through cards lit from behind
 *   wrap             wrapped diffuse
 *   billboard        0 none, 1 spin around V to face the viewer, 2 spin around U
 *   twist            random spin away from facing (radians, +-)
 *   alphaLit         extra opacity where sunlit ("lit = crisp" needles)
 *   haze             per-material distance haze (old pine testbed ground)
 *   flex             how much wind moves it (0 rigid, 1 grass blade)
 *   flow             flowing water: slide speed along the card's U axis
 *   fog              1 if the scene's distance haze applies
 */
export interface MaterialDef {
  spec: number;
  shininess: number;
  trans: number;
  wrap: number;
  billboard: 0 | 1 | 2;
  twist: number;
  alphaLit: number;
  haze?: number;
  flex?: number;
  flow?: number;
  fog?: number;
}

/** Material 0: cards lying on a model's surface. */
export const SURFACE_MATERIAL: MaterialDef = {
  spec: 0.25, shininess: 18, trans: 0.15, wrap: 0.25, billboard: 0, twist: 0, alphaLit: 0,
};

/** Weather and wind. All strengths 0..1. */
export interface Environment {
  /** Wind direction in the ground plane (x, z) and strength. */
  windDir: [number, number];
  wind: number;
  rain: number;
  leaves: number;
  /** Distance haze: e-folding distance in metres and strength (0 = off). */
  fogDist: number;
  fog: number;
  hazeColor: [number, number, number];
  /** Box (x, y, z sizes) rain falls in, following the camera. */
  rainBox: [number, number, number];
  /** Blown leaves travel in a box of side [2] round the camera ([0], [1] unused). */
  leafBox: [number, number, number];
}

export const CALM: Environment = {
  windDir: [1, 0], wind: 0, rain: 0, leaves: 0, fogDist: 420, fog: 0,
  hazeColor: [120 / 255, 112 / 255, 140 / 255], rainBox: [36, 24, 36], leafBox: [0, 0, 1],
};

/**
 * blend:    classic alpha blending, no depth writes. Right for cards lying on
 *           an opaque body that hides everything behind it.
 * coverage: alpha-to-coverage with depth writes. Order-independent, so free
 *           standing scenes (foliage) look right from every angle unsorted.
 */
export type CardMode = 'blend' | 'coverage';

export const vertexShader = /* glsl */ `
uniform vec2 uGrid;
uniform vec2 uInset;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGlintColor;
uniform float uDepthBias;
uniform vec4 uMatA[${MAX_MATERIALS}]; // spec, shininess, trans, wrap
uniform vec4 uMatB[${MAX_MATERIALS}]; // billboard, twist, alphaLit, haze
uniform vec4 uMatC[${MAX_MATERIALS}]; // flex, flow, fog, -
uniform vec4 uTone; // exposure, sky gain, ambient, hemi
uniform float uAlphaGain;
uniform vec3 uHazeColor;
uniform float uHazeDist;
uniform vec2 uFog;      // e-folding distance, strength
uniform float uTime;
uniform vec4 uWind;     // dir x, dir z, strength, -
uniform float uRain;
uniform float uLeaves;
uniform vec3 uRainBox;
uniform vec3 uLeafBox;  // min x, min z, size
uniform float uUnder;   // 1 in the underpaint pass (particles stay out of it)

attribute vec3 iCenter;
attribute vec3 iU;
attribute vec3 iV;
attribute vec4 iColor;
attribute float iGlyph;
attribute vec2 iLight; // sun, sky visibility

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

float hash(vec3 p) {
  return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
}

vec3 rotateAbout(vec3 v, vec3 axis, float a) {
  float c = cos(a);
  return v * c + cross(axis, v) * sin(a) + axis * dot(axis, v) * (1.0 - c);
}

void main() {
  float high = floor((iGlyph + 0.5) / ${MATERIAL_SHIFT.toFixed(1)});
  float glyph = iGlyph - high * ${MATERIAL_SHIFT.toFixed(1)};
  float cardMode = floor((high + 0.5) / ${MAX_MATERIALS.toFixed(1)});
  float mat = high - cardMode * ${MAX_MATERIALS.toFixed(1)};
  int m = int(min(mat, ${(MAX_MATERIALS - 1).toFixed(1)}));
  vec4 A = uMatA[m];
  vec4 B = uMatB[m];
  vec4 C = uMatC[m];
  bool solid = cardMode > 2.5 && cardMode < 3.5;
  bool waterLean = cardMode > 7.5;
  bool lean = cardMode > 6.5;
  bool emissive = (cardMode > 3.5 && cardMode < 4.5) || waterLean;
  bool rain = cardMode > 4.5 && cardMode < 5.5;
  bool leaf = cardMode > 5.5 && cardMode < 6.5;
  float billboard = (solid || emissive || leaf || lean) ? 0.0 : (rain ? 1.0 : (cardMode > 0.5 ? cardMode : B.x));

  float h = hash(iCenter);
  vec3 wind3 = vec3(uWind.x, 0.0, uWind.y);
  float ws = uWind.z;
  vec3 center = iCenter;
  vec3 U = iU;
  vec3 V = iV;
  float alphaMul = 1.0;

  if (uUnder > 0.5 && (rain || leaf)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  if (cardMode > 3.5 && cardMode < 4.5) {
    // Sky dome and stars: built round the origin, kept centred on the camera.
    center = iCenter + cameraPosition;
  }
  if (rain) {
    // Seeds live in a box that wraps round the camera: rain everywhere.
    vec3 fall = vec3(uWind.x * ws * 9.0, -14.0, uWind.y * ws * 9.0) * uTime;
    vec3 rel = mod(iCenter + fall - cameraPosition, uRainBox) - 0.5 * uRainBox;
    center = cameraPosition + rel;
    // Streaks right next to the eye would be huge bars: shrink and fade them.
    float near = smoothstep(2.0, 9.0, length(rel));
    V = normalize(vec3(uWind.x * ws * 0.65, -1.0, uWind.y * ws * 0.65)) * length(iV) * mix(0.35, 1.0, near);
    U = iU * mix(0.35, 1.0, near);
    vec3 q = abs(rel) / uRainBox;
    float edge = 1.0 - smoothstep(0.35, 0.5, max(q.x, max(q.y, q.z)));
    alphaMul = step(h, uRain) * edge * smoothstep(2.5, 6.0, length(rel));
  } else if (leaf) {
    // Carried downwind in a box that stays round the camera (seeds hold the
    // height above the camera's feet), bobbing and tumbling.
    float speed = (1.5 + 7.0 * ws) * (0.7 + 0.6 * h);
    vec3 p = iCenter + wind3 * speed * uTime;
    vec2 boxMin = cameraPosition.xz - 0.5 * uLeafBox.z;
    p.xz = boxMin + mod(p.xz - boxMin, vec2(uLeafBox.z));
    p.y = cameraPosition.y - 1.6 + iCenter.y + sin(uTime * (1.1 + h) + h * 40.0) * 0.6 + sin(uTime * 0.37 + h * 13.0) * 0.4;
    center = p;
    vec3 axis = normalize(vec3(h - 0.5, 0.6, fract(h * 7.3) - 0.5));
    float spin = uTime * (1.5 + 3.0 * fract(h * 3.1)) * (0.3 + ws);
    U = rotateAbout(iU, axis, spin);
    V = rotateAbout(iV, axis, spin);
    vec2 e = min(p.xz - boxMin, boxMin + uLeafBox.z - p.xz);
    alphaMul = step(fract(h * 5.7), uLeaves) * smoothstep(0.03, 0.15, ws) * smoothstep(0.0, 4.0, min(e.x, e.y));
  }

  vec3 toCam = normalize(cameraPosition - center);
  // Surface normal of flat-stored cards: used to lean them and to light them.
  vec3 n0 = normalize(cross(iU, iV));
  if (lean) {
    // Lean toward the current camera (the original does this for its one
    // camera): ground marks by a fixed amount, water 35-60 degrees. The
    // glyph's horizontal runs across the view, upright (ground: or flipped).
    float k = waterLean ? mix(0.7, 1.7, fract(h * 3.7)) : 0.9;
    vec3 nn = normalize(n0 + toCam * k);
    vec3 side = cross(n0, toCam);
    vec3 u = dot(side, side) > 1e-6 ? normalize(side) : normalize(iU);
    float a = waterLean ? (h - 0.5) * 0.4 : (h - 0.5) + (fract(h * 9.1) < 0.5 ? 0.0 : 3.14159);
    u = rotateAbout(u, nn, a);
    u = normalize(u - nn * dot(u, nn));
    U = u * length(iU);
    V = cross(nn, u) * length(iV);
  }
  // Billboards keep their axis but turn round it to face the viewer, then
  // twist away by a fixed per-card amount so they don't all line up.
  float tw = (h - 0.5) * 2.0 * B.y;
  if (billboard > 0.5 && billboard < 1.5) {
    vec3 axis = normalize(V);
    vec3 side = cross(axis, toCam);
    if (dot(side, side) > 1e-8) {
      side = normalize(side);
      U = (side * cos(tw) + cross(side, axis) * sin(tw)) * length(iU);
    }
  } else if (billboard > 1.5) {
    vec3 axis = normalize(U);
    vec3 side = cross(toCam, axis);
    if (dot(side, side) > 1e-8) {
      side = normalize(side);
      V = (side * cos(tw) + cross(axis, side) * sin(tw)) * length(iV);
    }
  }

  // Wind: flexible cards lean and shift downwind; gust fronts travel with
  // the wind across the land, and each card flutters at its own rate.
  vec3 sway = vec3(0.0);
  if (C.x > 0.0 && ws > 0.0 && !rain && !leaf) {
    float gust = 0.55 + 0.45 * sin(uTime * 0.8 - dot(center.xz, uWind.xy) * 0.09 + h);
    float flutter = sin(uTime * (2.6 + 1.4 * h) + h * 31.0 + dot(center.xz, vec2(0.7, 0.4)));
    float amt = ws * C.x * gust;
    float size = length(V);
    sway = wind3 * (amt * size * (0.6 + 0.4 * flutter)) - vec3(0.0, 0.1 * amt * size, 0.0);
    V = normalize(V / max(size, 1e-5) + wind3 * (amt * 0.8 * (0.75 + 0.25 * flutter))) * size;
  }

  // Flowing water slides along U; it fades in and out so the wrap is hidden.
  if (C.y > 0.0) {
    float travel = max(length(iU) * 2.0, 1e-3);
    float ph = fract(uTime * C.y / travel + h);
    center += normalize(iU) * (ph - 0.5) * travel;
    // Streams fade in and out fully; slow lake ripples only shimmer.
    alphaMul *= mix(0.75 + 0.25 * sin(3.14159 * ph), sin(3.14159 * ph), smoothstep(0.3, 0.8, C.y));
  }

  float baseA = iColor.a;

  vec3 world = center + sway + U * position.x + V * position.y;
  vec3 N = normalize(cross(U, V));
  float facing = dot(N, toCam);
  // Leaned ground is lit by the true surface normal, as in the original.
  vec3 Nlight = lean ? n0 : N;
  if (solid && facing < 0.0) {
    // Back face of an opaque surface (far side of a rock or trunk): skip it.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Light the side we can see. Seen from behind (e.g. an STL with flipped
  // winding) the glyph is also un-mirrored below, so text always reads right.
  float flip = facing < 0.0 ? -1.0 : 1.0;
  N *= flip;
  if (!lean) Nlight = N;
  float dist = length(cameraPosition - center);

  if (emissive || rain) {
    vColor = iColor.rgb;
    vAlpha = baseA * alphaMul * (rain ? 1.0 : smoothstep(0.02, 0.25, abs(facing)));
  } else {
    float ts = leaf ? 1.0 : iLight.x;
    float tk = leaf ? 1.0 : iLight.y;
    ts *= 1.0 - 0.6 * uRain; // overcast while it rains
    float ndl = dot(Nlight, uSunDir);
    float diff = clamp((ndl + A.w) / (1.0 + A.w), 0.0, 1.0);
    float back = clamp(-ndl, 0.0, 1.0);
    float spec = pow(clamp(dot(Nlight, normalize(uSunDir + toCam)), 0.0, 1.0), A.y) * step(0.0, ndl);
    float hemi = mix(1.0, 0.55 + 0.45 * Nlight.y, uTone.w);
    vec3 rad = iColor.rgb * (ts * uSunColor * (1.25 * diff + A.z * back) + uTone.y * tk * hemi * uSkyColor + uTone.z)
             + A.x * spec * ts * uGlintColor;
    vColor = 1.0 - exp(-uTone.x * rad);
    // Per-material distance haze, as in the pine script's ground.
    float hz = B.w * pow(clamp(dist / uHazeDist, 0.0, 1.0), 0.65);
    vColor = mix(vColor, uHazeColor, hz);
    // Cards seen almost edge-on become slivers: fade them out instead of streaking.
    // Foliage seen edge-on keeps most of its opacity (a crown has leaves at
    // every angle; fading them all out left holes). Other cards fade.
    float edge = smoothstep(0.02, 0.25, abs(facing));
    if (C.x > 0.3) edge = max(edge, 0.7);
    vAlpha = min(1.0, (baseA + B.z * ts * diff) * uAlphaGain) * edge * alphaMul;
  }
  // Scene haze: far things melt into the sky colour (thicker in the rain).
  if (uFog.y > 0.0 && C.z > 0.5) {
    float hz = (1.0 - exp(-dist / (uFog.x * (1.0 - 0.55 * uRain)))) * uFog.y;
    vColor = mix(vColor, uHazeColor, hz);
  }

  float row = floor((glyph + 0.5) / uGrid.x);
  float col = glyph - row * uGrid.x;
  vec2 cuv = vec2(flip > 0.0 ? uv.x : 1.0 - uv.x, 1.0 - uv.y);
  vUv = (vec2(col, row) + mix(uInset, 1.0 - uInset, cuv)) / uGrid;

  // Pull each card toward the eye by a fraction of its own size, so it wins
  // the depth test against the body it sits on whatever the triangle winding,
  // while the body still hides cards on the far side of the model.
  vec4 viewPos = viewMatrix * vec4(world, 1.0);
  viewPos.xyz += normalize(-viewPos.xyz) * (uDepthBias * length(iV));
  gl_Position = projectionMatrix * viewPos;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  float a = texture2D(uAtlas, vUv).a * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

/** One render chunk: a group of cards culled and thinned together. */
interface Chunk {
  mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  count: number;
  global: boolean;
  /** Sky sector: direction of its centre and angular radius (rad), or null. */
  sky: { dir: Vector3; radius: number } | null;
  lo: Vector3;
  hi: Vector3;
}

export class CardLayer {
  /** All chunk meshes; add this to the scene. */
  readonly group = new Group();
  readonly material: ShaderMaterial;
  private chunks: Chunk[] = [];
  private sets = new Map<string, Chunk[]>();
  private count = 0;
  /** Cards actually submitted in the last frame (after frustum culling). */
  drawn = 0;
  /**
   * Most cards to draw per frame (Infinity = no limit). Over budget, the
   * nearest chunks in view draw in full and farther ones an even sample of
   * their cards (each chunk is shuffled, so any prefix is a fair sample).
   * Sky, rain and leaves always draw and count against it.
   */
  budget = Infinity;
  /** Cards left out by the budget in the last frame. */
  thinned = 0;
  /** Always-drawn cards (sky sectors in view, rain, leaves) in the last budgeted frame. */
  globalDrawn = 0;
  private budgeted = false;

  constructor(atlas: GlyphAtlas, lighting: Lighting = DEFAULT_LIGHTING) {
    const vec4s = () => Array.from({ length: MAX_MATERIALS }, () => new Vector4());
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uAtlas: { value: atlas.texture },
        uGrid: { value: new Vector2(atlas.cols, atlas.rows) },
        uInset: { value: new Vector2(...atlas.inset) },
        uSunDir: { value: new Vector3() },
        uSunColor: { value: new Vector3() },
        uSkyColor: { value: new Vector3() },
        uGlintColor: { value: new Vector3() },
        uDepthBias: { value: 0.75 },
        uMatA: { value: vec4s() },
        uMatB: { value: vec4s() },
        uMatC: { value: vec4s() },
        uTone: { value: new Vector4(2.2, 0.5, 0.03, 1) },
        uAlphaGain: { value: 1 },
        uHazeColor: { value: new Vector3(120 / 255, 112 / 255, 140 / 255) },
        uHazeDist: { value: 110 }, // same falloff as the pine script
        uFog: { value: new Vector2(420, 0) },
        uTime: { value: 0 },
        uWind: { value: new Vector4(1, 0, 0, 0) },
        uRain: { value: 0 },
        uLeaves: { value: 0 },
        uRainBox: { value: new Vector3(36, 24, 36) },
        uLeafBox: { value: new Vector3(0, 0, 1) },
        uUnder: { value: 0 },
      },
    });
    this.setLighting(lighting);
    this.setMaterials([SURFACE_MATERIAL]);
    this.setMode('blend');
  }

  get cardCount(): number {
    return this.count;
  }

  /**
   * Hide the sky sectors that point out of view (the dome follows the
   * camera, so only its direction matters). Saves most of the ~100k sky
   * cards every frame.
   */
  cullSky(camera: PerspectiveCamera): void {
    const fwd = camera.getWorldDirection(new Vector3());
    const half = Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.hypot(1, camera.aspect)); // to a corner
    for (const c of this.chunks) {
      if (c.sky) c.mesh.visible = fwd.angleTo(c.sky.dir) <= half + c.sky.radius + 0.05;
    }
  }

  /** Apply `budget` for this camera: set how many cards each chunk draws. */
  applyBudget(camera: PerspectiveCamera): void {
    this.thinned = 0;
    if (!Number.isFinite(this.budget)) {
      if (this.budgeted) for (const c of this.chunks) c.mesh.geometry.instanceCount = c.count;
      this.budgeted = false;
      return;
    }
    this.budgeted = true;
    this.globalDrawn = 0;
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    let left = this.budget;
    const inView: { c: Chunk; d: number }[] = [];
    for (const c of this.chunks) {
      const g = c.mesh.geometry;
      if (c.global) {
        g.instanceCount = c.count;
        if (c.mesh.visible) {
          left -= c.count;
          this.globalDrawn += c.count;
        }
      } else if (!g.boundingSphere || frustum.intersectsSphere(g.boundingSphere)) {
        inView.push({ c, d: g.boundingSphere ? g.boundingSphere.center.distanceTo(camera.position) : 0 });
      } else {
        g.instanceCount = c.count; // culled anyway
      }
    }
    inView.sort((a, b) => a.d - b.d);
    // Nearest first in full; once that no longer fits, the rest share what is left.
    let k = 0;
    for (; k < inView.length && inView[k]!.c.count <= left; k++) {
      inView[k]!.c.mesh.geometry.instanceCount = inView[k]!.c.count;
      left -= inView[k]!.c.count;
    }
    let rest = 0;
    for (let i = k; i < inView.length; i++) rest += inView[i]!.c.count;
    const f = rest > 0 ? Math.max(0, left) / rest : 1;
    for (let i = k; i < inView.length; i++) {
      const c = inView[i]!.c;
      const n = Math.floor(c.count * f);
      c.mesh.geometry.instanceCount = n;
      this.thinned += c.count - n;
    }
  }

  /**
   * How many glyphs stack on one spot of the screen: projects the centre of
   * every ground and object card in view (not sky, rain or leaves) and counts
   * them per square screen cell of `cellPx` CSS px (about one glyph).
   * Returns the number of occupied cells and the mean, 95th percentile and
   * maximum count per occupied cell. For tests and the terminal; not per frame.
   */
  stacking(camera: PerspectiveCamera, width: number, height: number, cellPx = 16): { cells: number; mean: number; p95: number; max: number } {
    camera.updateMatrixWorld();
    const vp = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(vp);
    const cols = Math.ceil(width / cellPx), rows = Math.ceil(height / cellPx);
    const counts = new Uint32Array(cols * rows);
    const e = vp.elements;
    for (const c of this.chunks) {
      if (c.global || !c.mesh.visible) continue;
      const g = c.mesh.geometry;
      if (g.boundingSphere && !frustum.intersectsSphere(g.boundingSphere)) continue;
      const attr = g.getAttribute('iCenter') as InterleavedBufferAttribute;
      const arr = attr.data.array as Float32Array, stride = attr.data.stride;
      const n = Math.min(g.instanceCount, c.count);
      for (let i = 0; i < n; i++) {
        const o = i * stride;
        const x = arr[o]!, y = arr[o + 1]!, z = arr[o + 2]!;
        const w = e[3]! * x + e[7]! * y + e[11]! * z + e[15]!;
        if (w <= 0) continue;
        const nx = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) / w;
        const ny = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) / w;
        if (nx < -1 || nx >= 1 || ny < -1 || ny >= 1) continue;
        const cx = Math.floor(((nx + 1) / 2) * width / cellPx), cy = Math.floor(((1 - ny) / 2) * height / cellPx);
        counts[cy * cols + cx]!++;
      }
    }
    const used = Array.from(counts).filter((v) => v > 0).sort((a, b) => a - b);
    if (used.length === 0) return { cells: 0, mean: 0, p95: 0, max: 0 };
    const mean = used.reduce((a, b) => a + b, 0) / used.length;
    return { cells: used.length, mean, p95: used[Math.floor(used.length * 0.95)]!, max: used[used.length - 1]! };
  }

  /** The chunk meshes (the underpaint pass draws them with its own material). */
  get meshes(): Mesh<InstancedBufferGeometry, ShaderMaterial>[] {
    return this.chunks.map((c) => c.mesh);
  }

  setAtlas(atlas: GlyphAtlas): void {
    const u = this.material.uniforms;
    u.uAtlas!.value = atlas.texture;
    (u.uGrid!.value as Vector2).set(atlas.cols, atlas.rows);
    (u.uInset!.value as Vector2).set(...atlas.inset);
  }

  /** Material table for the current scene; card material ids index into it. */
  setMaterials(defs: MaterialDef[]): void {
    if (defs.length === 0 || defs.length > MAX_MATERIALS) {
      throw new Error(`a scene needs 1 to ${MAX_MATERIALS} materials, got ${defs.length}`);
    }
    const u = this.material.uniforms;
    const A = u.uMatA!.value as Vector4[];
    const B = u.uMatB!.value as Vector4[];
    const C = u.uMatC!.value as Vector4[];
    for (let i = 0; i < MAX_MATERIALS; i++) {
      const m = defs[i] ?? SURFACE_MATERIAL;
      A[i]!.set(m.spec, m.shininess, m.trans, m.wrap);
      B[i]!.set(m.billboard, m.twist, m.alphaLit, m.haze ?? 0);
      C[i]!.set(m.flex ?? 0, m.flow ?? 0, m.fog ?? 0, 0);
    }
  }

  setLighting(l: Lighting): void {
    const u = this.material.uniforms;
    (u.uSunDir!.value as Vector3).copy(l.sunDir).normalize();
    (u.uSunColor!.value as Vector3).copy(l.sunColor);
    (u.uSkyColor!.value as Vector3).copy(l.skyColor);
    (u.uGlintColor!.value as Vector3).copy(l.glintColor);
    (u.uTone!.value as Vector4).set(l.exposure ?? 2.2, l.skyGain ?? 0.5, l.ambient ?? 0.03, l.hemi ?? 1);
  }

  setEnvironment(e: Environment): void {
    const u = this.material.uniforms;
    const len = Math.hypot(e.windDir[0], e.windDir[1]) || 1;
    (u.uWind!.value as Vector4).set(e.windDir[0] / len, e.windDir[1] / len, e.wind, 0);
    u.uRain!.value = e.rain;
    u.uLeaves!.value = e.leaves;
    (u.uFog!.value as Vector2).set(e.fogDist, e.fog);
    (u.uHazeColor!.value as Vector3).set(...e.hazeColor);
    (u.uRainBox!.value as Vector3).set(...e.rainBox);
    (u.uLeafBox!.value as Vector3).set(...e.leafBox);
  }

  /** Animation clock, seconds. */
  setTime(t: number): void {
    this.material.uniforms.uTime!.value = t;
  }

  /** See `CardMode`. `depthBias` is in card heights (0 for scenes with no body). */
  setMode(mode: CardMode, depthBias = mode === 'blend' ? 0.75 : 0): void {
    const m = this.material;
    const coverage = mode === 'coverage';
    m.transparent = !coverage;
    m.blending = NormalBlending;
    m.depthWrite = coverage;
    m.depthTest = true;
    m.alphaToCoverage = coverage;
    m.uniforms.uDepthBias!.value = depthBias;
    // Coverage turns partial alpha into fewer covered samples, which reads
    // dimmer than blending; a gain brings the density back in line.
    m.uniforms.uAlphaGain!.value = coverage ? 1.6 : 1;
    m.needsUpdate = true;
  }

  /**
   * Replace all cards. `data` holds `stride` floats per card, already grouped
   * by `chunks` (see engine/chunks.ts); without chunks it is one global chunk.
   */
  setCards(data: Float32Array, stride: number, chunks?: Float32Array): void {
    this.clear();
    this.addSet('main', data, stride, chunks);
  }

  /** Add (or replace) a named set of cards, e.g. one streamed world chunk. */
  addSet(key: string, data: Float32Array, stride: number, chunks?: Float32Array): void {
    this.removeSet(key);
    if (stride !== CARD_STRIDE) {
      throw new Error(`card stride mismatch: engine sends ${stride}, renderer expects ${CARD_STRIDE}`);
    }
    if (data.length % stride !== 0) throw new Error('card buffer length is not a multiple of the stride');
    const total = data.length / stride;
    const table = chunks ?? new Float32Array([0, total, 0, 0, 0, 0, 0, 0, 0, 1]);
    const set: Chunk[] = [];
    for (let c = 0; c + CHUNK_FLOATS <= table.length; c += CHUNK_FLOATS) {
      const [start = 0, count = 0, lx = 0, ly = 0, lz = 0, hx = 0, hy = 0, hz = 0, size = 0, global = 0] = table.subarray(c, c + CHUNK_FLOATS);
      if (count <= 0) continue;
      const geometry = emptyGeometry();
      const buf = new InstancedInterleavedBuffer(data.subarray(start * stride, (start + count) * stride), stride, 1);
      geometry.setAttribute('iCenter', new InterleavedBufferAttribute(buf, 3, 0));
      geometry.setAttribute('iU', new InterleavedBufferAttribute(buf, 3, 3));
      geometry.setAttribute('iV', new InterleavedBufferAttribute(buf, 3, 6));
      geometry.setAttribute('iColor', new InterleavedBufferAttribute(buf, 4, 9));
      geometry.setAttribute('iGlyph', new InterleavedBufferAttribute(buf, 1, 13));
      geometry.setAttribute('iLight', new InterleavedBufferAttribute(buf, 2, 14));
      geometry.instanceCount = count;
      const lo = new Vector3(lx, ly, lz);
      const hi = new Vector3(hx, hy, hz);
      // Margin: card size plus wind sway.
      const r = lo.distanceTo(hi) / 2 + size + 1;
      geometry.boundingSphere = new Sphere(lo.clone().add(hi).multiplyScalar(0.5), r);
      const mesh = new Mesh(geometry, this.material);
      const centre = lo.clone().add(hi).multiplyScalar(0.5);
      const sky = global > 1.5
        ? { dir: centre.clone().normalize(), radius: Math.atan2(lo.distanceTo(hi) / 2, Math.max(centre.length(), 1)) }
        : null;
      const chunk: Chunk = { mesh, count, global: global > 0.5, lo, hi, sky };
      // Global chunks (sky dome, rain round the camera, blown leaves) always draw.
      mesh.frustumCulled = !chunk.global;
      mesh.renderOrder = 1; // after the opaque body
      mesh.onBeforeRender = () => {
        this.drawn += Math.min(geometry.instanceCount, chunk.count);
      };
      set.push(chunk);
      this.chunks.push(chunk);
      this.group.add(mesh);
    }
    this.sets.set(key, set);
    this.count += total;
  }

  /** Remove a named set and free its GPU buffers. */
  removeSet(key: string): void {
    const set = this.sets.get(key);
    if (!set) return;
    for (const c of set) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose();
      this.count -= c.count;
    }
    this.chunks = this.chunks.filter((c) => !set.includes(c));
    this.sets.delete(key);
  }

  private clear(): void {
    for (const c of this.chunks) {
      this.group.remove(c.mesh);
      c.mesh.geometry.dispose(); // frees the GPU buffers
    }
    this.chunks = [];
    this.sets.clear();
    this.count = 0;
  }

  dispose(): void {
    this.clear();
    this.material.dispose();
  }
}

/** Unit quad centred on the origin: x, y in [-0.5, 0.5]. */
function emptyGeometry(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.instanceCount = 0;
  return g;
}
