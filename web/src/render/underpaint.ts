// Underpaint: a faint, blurred colour wash behind the glyphs, taken from the
// scene itself, so the gaps between characters aren't flat black but still
// read as a terminal.
//
//   1. Draw every card as a solid patch of its own colour into a small
//      offscreen image (half resolution, depth tested against the same
//      opaque bodies, so whatever is in front wins: a green tree in front of
//      red leaves paints green). Cards count as partly see-through there, so
//      a little of what is behind shows through foliage, then blends in.
//      Rain and blown leaves stay out of it.
//   2. Blur it (separable Gaussian) so it becomes a soft glow, not shapes.
//   3. Add it, faintly, on top of the background before the glyphs are drawn.

import {
  Color,
  HalfFloatType,
  LinearFilter,
  Mesh,
  type Material,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Camera,
  type WebGLRenderer,
} from 'three';
import type { CardLayer } from './cards';
import { vertexShader } from './cards';

const solidFragment = /* glsl */ `
uniform float uUnderAlpha;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float a = vAlpha * uUnderAlpha;
  if (a < 0.05) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

const quadVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const blurFragment = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  // 9-tap Gaussian (sigma ~2 texels) along uStep.
  float w[5];
  w[0] = 0.2270; w[1] = 0.1946; w[2] = 0.1216; w[3] = 0.0541; w[4] = 0.0162;
  vec4 c = texture2D(tSrc, vUv) * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 o = uStep * float(i) * 1.5;
    c += (texture2D(tSrc, vUv + o) + texture2D(tSrc, vUv - o)) * w[i];
  }
  gl_FragColor = c;
}
`;

const compositeFragment = /* glsl */ `
uniform sampler2D tUnder;
uniform vec3 uBg;
uniform float uStrength;
varying vec2 vUv;
void main() {
  // The wash is coverage-weighted colour: add a little of it to the background.
  vec3 u = texture2D(tUnder, vUv).rgb;
  gl_FragColor = vec4(uBg + u * uStrength, 1.0);
}
`;

export class Underpaint {
  /** How much of the scene colour shows behind the glyphs (0 = flat background). */
  strength = 0.2;
  /** How opaque cards are in the wash (lower lets more of what is behind through). */
  cardAlpha = 0.7;
  enabled = true;

  private rtScene: WebGLRenderTarget;
  private rtA: WebGLRenderTarget;
  private rtB: WebGLRenderTarget;
  private quadScene = new Scene();
  private quadCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: Mesh<PlaneGeometry, ShaderMaterial>;
  private blurMat: ShaderMaterial;
  private compositeMat: ShaderMaterial;
  private material: ShaderMaterial;

  constructor(cards: CardLayer) {
    const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: true };
    this.rtScene = new WebGLRenderTarget(1, 1, { ...opts, samples: 4 });
    this.rtA = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });
    this.rtB = new WebGLRenderTarget(1, 1, { ...opts, depthBuffer: false });

    // Same vertex shader and (shared) uniforms as the glyph cards, so every
    // card sits exactly where its glyph is, wind and all.
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader: solidFragment,
      uniforms: { ...cards.material.uniforms, uUnder: { value: 1 }, uUnderAlpha: { value: this.cardAlpha } },
      depthTest: true,
      depthWrite: true,
      alphaToCoverage: true,
    });

    this.blurMat = new ShaderMaterial({
      vertexShader: quadVertex,
      fragmentShader: blurFragment,
      uniforms: { tSrc: { value: null }, uStep: { value: new Vector2() } },
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMat = new ShaderMaterial({
      vertexShader: quadVertex,
      fragmentShader: compositeFragment,
      uniforms: { tUnder: { value: null }, uBg: { value: new Color() }, uStrength: { value: this.strength } },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new Mesh(new PlaneGeometry(2, 2), this.blurMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(width: number, height: number): void {
    // Half resolution is plenty for a blurred wash.
    const w = Math.max(1, Math.floor(width / 2));
    const h = Math.max(1, Math.floor(height / 2));
    this.rtScene.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
  }

  /**
   * Render the wash and put it on screen as the background. The caller then
   * draws the glyph scene on top without clearing.
   */
  render(renderer: WebGLRenderer, scene: Scene, camera: Camera, cards: CardLayer, background: Color): void {
    this.material.uniforms.uUnderAlpha!.value = this.cardAlpha;
    const clear = renderer.getClearColor(new Color());
    const clearAlpha = renderer.getClearAlpha();

    // 1. Solid card colours (same chunks, same culling and LOD), depth
    //    tested against the opaque bodies.
    const meshes = cards.meshes;
    const saved: Material[] = meshes.map((m) => m.material);
    for (const m of meshes) m.material = this.material;
    renderer.setRenderTarget(this.rtScene);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    meshes.forEach((m, i) => (m.material = saved[i] as ShaderMaterial));

    // 2. Blur horizontally then vertically.
    const { width, height } = this.rtA;
    this.quad.material = this.blurMat;
    this.blurMat.uniforms.tSrc!.value = this.rtScene.texture;
    (this.blurMat.uniforms.uStep!.value as Vector2).set(1 / width, 0);
    renderer.setRenderTarget(this.rtA);
    renderer.render(this.quadScene, this.quadCam);
    this.blurMat.uniforms.tSrc!.value = this.rtA.texture;
    (this.blurMat.uniforms.uStep!.value as Vector2).set(0, 1 / height);
    renderer.setRenderTarget(this.rtB);
    renderer.render(this.quadScene, this.quadCam);

    // 3. Background + faint wash on screen.
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, clearAlpha);
    renderer.clear();
    this.quad.material = this.compositeMat;
    this.compositeMat.uniforms.tUnder!.value = this.rtB.texture;
    (this.compositeMat.uniforms.uBg!.value as Color).copy(background).convertLinearToSRGB();
    this.compositeMat.uniforms.uStrength!.value = this.strength;
    renderer.render(this.quadScene, this.quadCam);
  }

  dispose(): void {
    this.rtScene.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.blurMat.dispose();
    this.compositeMat.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
