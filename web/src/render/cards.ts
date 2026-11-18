// All cards are one instanced draw: a unit quad instanced once per card, with
// the card data read straight from the engine's Float32Array. Lighting runs
// per card in the vertex shader, so moving the camera or the sun is free;
// only changing the cards themselves touches the CPU.

import {
  BufferAttribute,
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

/** Must match `cards::STRIDE` / `cards::layout` in the Rust engine. */
export const CARD_STRIDE = 16;
/**
 * Glyph slot = atlas index + 1024 * (material + 64 * mode). Must match
 * `cards::MATERIAL_SHIFT` and `scenery::skin::pack` in the Rust engine.
 * mode 0 uses the material's own billboard setting; 1 billboard round V,
 * 2 billboard round U, 3 solid (fixed, back faces not drawn).
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
 *   haze             fade toward the haze colour with distance (ground)
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
}

/** Material 0: cards lying on a model's surface. */
export const SURFACE_MATERIAL: MaterialDef = {
  spec: 0.25, shininess: 18, trans: 0.15, wrap: 0.25, billboard: 0, twist: 0, alphaLit: 0,
};

/**
 * blend:    classic alpha blending, no depth writes. Right for cards lying on
 *           an opaque body that hides everything behind it.
 * coverage: alpha-to-coverage with depth writes. Order-independent, so free
 *           standing scenes (foliage) look right from every angle unsorted.
 */
export type CardMode = 'blend' | 'coverage';

const vertexShader = /* glsl */ `
uniform vec2 uGrid;
uniform vec2 uInset;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGlintColor;
uniform float uDepthBias;
uniform vec4 uMatA[${MAX_MATERIALS}]; // spec, shininess, trans, wrap
uniform vec4 uMatB[${MAX_MATERIALS}]; // billboard, twist, alphaLit, haze
uniform vec4 uTone; // exposure, sky gain, ambient, hemi
uniform float uAlphaGain;
uniform vec3 uHazeColor;
uniform float uHazeDist;

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

void main() {
  float high = floor((iGlyph + 0.5) / ${MATERIAL_SHIFT.toFixed(1)});
  float glyph = iGlyph - high * ${MATERIAL_SHIFT.toFixed(1)};
  float cardMode = floor((high + 0.5) / ${MAX_MATERIALS.toFixed(1)});
  float mat = high - cardMode * ${MAX_MATERIALS.toFixed(1)};
  int m = int(min(mat, ${(MAX_MATERIALS - 1).toFixed(1)}));
  vec4 A = uMatA[m];
  vec4 B = uMatB[m];
  bool solid = cardMode > 2.5;
  float billboard = solid ? 0.0 : (cardMode > 0.5 ? cardMode : B.x);

  vec3 toCam = normalize(cameraPosition - iCenter);
  vec3 U = iU;
  vec3 V = iV;
  // Billboards keep their axis but turn round it to face the viewer, then
  // twist away by a fixed per-card amount so they don't all line up.
  float tw = (hash(iCenter) - 0.5) * 2.0 * B.y;
  if (billboard > 0.5 && billboard < 1.5) {
    vec3 axis = normalize(iV);
    vec3 side = cross(axis, toCam);
    if (dot(side, side) > 1e-8) {
      side = normalize(side);
      U = (side * cos(tw) + cross(side, axis) * sin(tw)) * length(iU);
    }
  } else if (billboard > 1.5) {
    vec3 axis = normalize(iU);
    vec3 side = cross(toCam, axis);
    if (dot(side, side) > 1e-8) {
      side = normalize(side);
      V = (side * cos(tw) + cross(axis, side) * sin(tw)) * length(iV);
    }
  }

  vec3 world = iCenter + U * position.x + V * position.y;
  vec3 N = normalize(cross(U, V));
  float facing = dot(N, toCam);
  if (solid && facing < 0.0) {
    // Back face of an opaque surface (far side of a rock or trunk): skip it.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  // Light the side we can see. Seen from behind (e.g. an STL with flipped
  // winding) the glyph is also un-mirrored below, so text always reads right.
  float flip = facing < 0.0 ? -1.0 : 1.0;
  N *= flip;

  float ts = iLight.x;
  float tk = iLight.y;
  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + A.w) / (1.0 + A.w), 0.0, 1.0);
  float back = clamp(-ndl, 0.0, 1.0);
  float spec = pow(clamp(dot(N, normalize(uSunDir + toCam)), 0.0, 1.0), A.y) * step(0.0, ndl);
  float hemi = mix(1.0, 0.55 + 0.45 * N.y, uTone.w);
  vec3 rad = iColor.rgb * (ts * uSunColor * (1.25 * diff + A.z * back) + uTone.y * tk * hemi * uSkyColor + uTone.z)
           + A.x * spec * ts * uGlintColor;
  vColor = 1.0 - exp(-uTone.x * rad);
  // Distance haze (ground), as in the script: far ground melts into the dusk.
  float hz = B.w * pow(clamp(length(cameraPosition - iCenter) / uHazeDist, 0.0, 1.0), 0.65);
  vColor = mix(vColor, uHazeColor, hz);

  // Cards seen almost edge-on become slivers: fade them out instead of streaking.
  vAlpha = min(1.0, (iColor.a + B.z * ts * diff) * uAlphaGain) * smoothstep(0.02, 0.25, abs(facing));

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

export class CardLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private count = 0;

  constructor(atlas: GlyphAtlas, lighting: Lighting = DEFAULT_LIGHTING) {
    const material = new ShaderMaterial({
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
        uMatA: { value: Array.from({ length: MAX_MATERIALS }, () => new Vector4()) },
        uMatB: { value: Array.from({ length: MAX_MATERIALS }, () => new Vector4()) },
        uTone: { value: new Vector4(2.2, 0.5, 0.03, 1) },
        uAlphaGain: { value: 1 },
        uHazeColor: { value: new Vector3(120 / 255, 112 / 255, 140 / 255) },
        uHazeDist: { value: 110 }, // same falloff as the script
      },
    });
    this.mesh = new Mesh(emptyGeometry(), material);
    this.mesh.frustumCulled = false; // positions come from instance data, not the base quad
    this.mesh.renderOrder = 1; // after the opaque body
    this.setLighting(lighting);
    this.setMaterials([SURFACE_MATERIAL]);
    this.setMode('blend');
  }

  get cardCount(): number {
    return this.count;
  }

  setAtlas(atlas: GlyphAtlas): void {
    const u = this.mesh.material.uniforms;
    u.uAtlas!.value = atlas.texture;
    (u.uGrid!.value as Vector2).set(atlas.cols, atlas.rows);
    (u.uInset!.value as Vector2).set(...atlas.inset);
  }

  /** Material table for the current scene; card material ids index into it. */
  setMaterials(defs: MaterialDef[]): void {
    if (defs.length === 0 || defs.length > MAX_MATERIALS) {
      throw new Error(`a scene needs 1 to ${MAX_MATERIALS} materials, got ${defs.length}`);
    }
    const u = this.mesh.material.uniforms;
    const A = u.uMatA!.value as Vector4[];
    const B = u.uMatB!.value as Vector4[];
    for (let i = 0; i < MAX_MATERIALS; i++) {
      const m = defs[i] ?? SURFACE_MATERIAL;
      A[i]!.set(m.spec, m.shininess, m.trans, m.wrap);
      B[i]!.set(m.billboard, m.twist, m.alphaLit, m.haze ?? 0);
    }
  }

  setLighting(l: Lighting): void {
    const u = this.mesh.material.uniforms;
    (u.uSunDir!.value as Vector3).copy(l.sunDir).normalize();
    (u.uSunColor!.value as Vector3).copy(l.sunColor);
    (u.uSkyColor!.value as Vector3).copy(l.skyColor);
    (u.uGlintColor!.value as Vector3).copy(l.glintColor);
    (u.uTone!.value as Vector4).set(l.exposure ?? 2.2, l.skyGain ?? 0.5, l.ambient ?? 0.03, l.hemi ?? 1);
  }

  /** See `CardMode`. `depthBias` is in card heights (0 for scenes with no body). */
  setMode(mode: CardMode, depthBias = mode === 'blend' ? 0.75 : 0): void {
    const m = this.mesh.material;
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

  /** Replace all cards. `data` holds `stride` floats per card. */
  setCards(data: Float32Array, stride: number): void {
    if (stride !== CARD_STRIDE) {
      throw new Error(`card stride mismatch: engine sends ${stride}, renderer expects ${CARD_STRIDE}`);
    }
    if (data.length % stride !== 0) throw new Error('card buffer length is not a multiple of the stride');
    const geometry = emptyGeometry();
    const count = data.length / stride;
    if (count > 0) {
      const buf = new InstancedInterleavedBuffer(data, stride, 1);
      geometry.setAttribute('iCenter', new InterleavedBufferAttribute(buf, 3, 0));
      geometry.setAttribute('iU', new InterleavedBufferAttribute(buf, 3, 3));
      geometry.setAttribute('iV', new InterleavedBufferAttribute(buf, 3, 6));
      geometry.setAttribute('iColor', new InterleavedBufferAttribute(buf, 4, 9));
      geometry.setAttribute('iGlyph', new InterleavedBufferAttribute(buf, 1, 13));
      geometry.setAttribute('iLight', new InterleavedBufferAttribute(buf, 2, 14));
    }
    geometry.instanceCount = count;
    this.mesh.geometry.dispose(); // frees the previous GPU buffers
    this.mesh.geometry = geometry;
    this.mesh.visible = count > 0;
    this.count = count;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
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
