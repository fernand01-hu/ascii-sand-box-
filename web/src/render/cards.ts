// All cards are one InstancedMesh-style draw: a unit quad instanced once per
// card, with the card data read straight from the engine's Float32Array.
// Lighting runs per card in the vertex shader, so moving the camera or the
// sun is free; only changing the cards themselves touches the CPU.

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
} from 'three';
import type { GlyphAtlas } from './atlas';

/** Must match `cards::STRIDE` / `cards::layout` in the Rust engine. */
export const CARD_STRIDE = 14;

export interface Lighting {
  sunDir: Vector3;
  sunColor: Vector3;
  skyColor: Vector3;
  glintColor: Vector3;
  /** Specular glint strength and sharpness. */
  spec: number;
  shininess: number;
  /** Light passing through cards lit from behind. */
  translucency: number;
  /** Wrapped diffuse: how far light bends past the terminator. */
  wrap: number;
}

export const DEFAULT_LIGHTING: Lighting = {
  sunDir: new Vector3(-0.6, 0.55, 0.6).normalize(),
  sunColor: new Vector3(1.3, 0.92, 0.58),
  skyColor: new Vector3(0.46, 0.52, 0.8),
  glintColor: new Vector3(1.0, 0.86, 0.62),
  spec: 0.25,
  shininess: 18,
  translucency: 0.15,
  wrap: 0.25,
};

const vertexShader = /* glsl */ `
uniform vec2 uGrid;
uniform vec2 uInset;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGlintColor;
uniform float uSpec;
uniform float uShininess;
uniform float uTrans;
uniform float uWrap;
uniform float uDepthBias;

attribute vec3 iCenter;
attribute vec3 iU;
attribute vec3 iV;
attribute vec4 iColor;
attribute float iGlyph;

varying vec2 vUv;
varying vec3 vColor;
varying float vAlpha;

void main() {
  vec3 world = iCenter + iU * position.x + iV * position.y;
  vec3 toCam = normalize(cameraPosition - iCenter);
  vec3 N = normalize(cross(iU, iV));
  float facing = dot(N, toCam);

  // Light the side we can see. Seen from behind (e.g. an STL with flipped
  // winding) the glyph is also un-mirrored below, so text always reads right.
  float flip = facing < 0.0 ? -1.0 : 1.0;
  N *= flip;

  float ndl = dot(N, uSunDir);
  float diff = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  float back = clamp(-ndl, 0.0, 1.0);
  float spec = pow(clamp(dot(N, normalize(uSunDir + toCam)), 0.0, 1.0), uShininess) * step(0.0, ndl);
  float sky = 0.55 + 0.45 * N.y;
  vec3 rad = iColor.rgb * (uSunColor * (1.25 * diff + uTrans * back) + 0.5 * sky * uSkyColor + 0.03)
           + uSpec * spec * uGlintColor;
  vColor = 1.0 - exp(-2.2 * rad);

  // Cards seen almost edge-on become slivers: fade them out instead of streaking.
  vAlpha = iColor.a * smoothstep(0.02, 0.25, abs(facing));

  float row = floor((iGlyph + 0.5) / uGrid.x);
  float col = iGlyph - row * uGrid.x;
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
        uSunDir: { value: lighting.sunDir.clone().normalize() },
        uSunColor: { value: lighting.sunColor.clone() },
        uSkyColor: { value: lighting.skyColor.clone() },
        uGlintColor: { value: lighting.glintColor.clone() },
        uSpec: { value: lighting.spec },
        uShininess: { value: lighting.shininess },
        uTrans: { value: lighting.translucency },
        uWrap: { value: lighting.wrap },
        uDepthBias: { value: 0.75 },
      },
      transparent: true,
      blending: NormalBlending,
      depthTest: true,
      depthWrite: false,
    });
    this.mesh = new Mesh(emptyGeometry(), material);
    this.mesh.frustumCulled = false; // positions come from instance data, not the base quad
    this.mesh.renderOrder = 1; // after the opaque body
  }

  get cardCount(): number {
    return this.count;
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
