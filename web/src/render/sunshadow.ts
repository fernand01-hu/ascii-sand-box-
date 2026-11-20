// Sun shadow map (look lab, lighting variant "sun shadows"): the scene drawn
// from the sun into a depth texture every frame it is needed, covering a
// square round the part of the world in front of the camera. Each card then
// looks up its centre in it (cards.ts, sunMap): shadows that cross chunk
// borders, fall from hills (the opaque ground body is in the map), follow a
// moving sun and update the moment something is placed. Glyphs cast
// glyph-shaped shadows: the depth pass drops the transparent part of each one.

import {
  DepthTexture,
  Matrix4,
  NearestFilter,
  OrthographicCamera,
  ShaderMaterial,
  UnsignedIntType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Material,
  type Object3D,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { vertexShader, type CardLayer } from './cards';

const depthFragment = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;
varying float vAlpha;
void main() {
  if (texture2D(uAtlas, vUv).a * max(vAlpha, 0.6) < 0.3) discard;
  gl_FragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0); // (colour unused; handy to inspect)
}
`;

export class SunShadow {
  /** Half the side of the square it covers (m). */
  readonly half = 70;
  readonly size = 2048;
  readonly rt: WebGLRenderTarget;
  private cam: OrthographicCamera;
  private material: ShaderMaterial;
  private readonly depth = 600;

  constructor(cards: CardLayer) {
    this.rt = new WebGLRenderTarget(this.size, this.size, { depthBuffer: true });
    this.rt.depthTexture = new DepthTexture(this.size, this.size, UnsignedIntType);
    this.rt.depthTexture.minFilter = NearestFilter;
    this.rt.depthTexture.magFilter = NearestFilter;
    this.cam = new OrthographicCamera(-this.half, this.half, this.half, -this.half, 1, this.depth);
    this.material = new ShaderMaterial({
      vertexShader,
      fragmentShader: depthFragment,
      // Shared uniforms (wind, time, atlas...), except the shadow map itself,
      // which can't be read while it is being drawn.
      uniforms: { ...cards.material.uniforms, uDepthPass: { value: 1 }, uShadowMap: { value: null }, uDepthBias: { value: 0 } },
      depthTest: true,
      depthWrite: true,
    });
  }

  /** Draw the map for this view and sun, and hand it to the cards. */
  render(renderer: WebGLRenderer, scene: Scene, view: PerspectiveCamera, cards: CardLayer, sunDir: Vector3, hide: Object3D[]): void {
    // Centre: ahead of the camera, snapped to whole texels so shadows don't shimmer as it moves.
    const fwd = view.getWorldDirection(new Vector3()).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    const c = view.position.clone().addScaledVector(fwd.normalize(), this.half * 0.55);
    c.y = 0;
    const sun = sunDir.clone().normalize();
    if (sun.y < 0.05) sun.y = 0.05;
    sun.normalize();
    this.cam.position.copy(c).addScaledVector(sun, this.depth / 2);
    this.cam.up.set(0, 1, 0);
    if (Math.abs(sun.y) > 0.99) this.cam.up.set(0, 0, -1);
    this.cam.lookAt(c);
    this.cam.updateMatrixWorld();
    // Snap in the sun camera's own plane.
    const texel = (2 * this.half) / this.size;
    const inv = this.cam.matrixWorldInverse;
    const p = c.clone().applyMatrix4(inv);
    const dx = Math.round(p.x / texel) * texel - p.x, dy = Math.round(p.y / texel) * texel - p.y;
    const right = new Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0), up = new Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.cam.position.addScaledVector(right, -dx).addScaledVector(up, -dy);
    this.cam.updateMatrixWorld();
    this.cam.updateProjectionMatrix();

    const meshes = cards.chunkMeshes;
    const saved: Material[] = meshes.map((m) => m.material);
    for (const m of meshes) m.material = this.material;
    const vis = hide.map((o) => o.visible);
    for (const o of hide) o.visible = false;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    renderer.setRenderTarget(null);
    meshes.forEach((m, i) => (m.material = saved[i] as ShaderMaterial));
    hide.forEach((o, i) => (o.visible = vis[i]!));

    const mat = new Matrix4().multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
    cards.setShadowMap(this.rt.depthTexture, mat, new Vector2(1 / this.size, 1 / (this.depth - 1)));
  }

  dispose(): void {
    this.rt.dispose();
    this.material.dispose();
  }
}
