// TESTBED (dev/test builds only). The procedural pine from pine_ascii.py as a
// stress test for the engine: 80k+ cards, baked shadows, six materials,
// billboards and order-independent transparency. Not part of the product.

import { Vector3 } from 'three';
import type { App } from '../app/app';
import { glyphAspect } from '../render/atlas';
import { DEFAULT_LIGHTING, SURFACE_MATERIAL, type MaterialDef } from '../render/cards';

export const PINE_SCENE = 'procedural-pine';
export const PINE_SEED = 23; // the script's default seed

/** Indexed by the material ids in engine/src/testbed/pine.rs. */
const PINE_MATERIALS: MaterialDef[] = [
  /* 0 unused */ SURFACE_MATERIAL,
  /* 1 needle */ { spec: 0.45, shininess: 28, trans: 0.45, wrap: 0.25, billboard: 1, twist: 0.55, alphaLit: 0.8 },
  /* 2 tip    */ { spec: 0.4, shininess: 20, trans: 0.5, wrap: 0.25, billboard: 1, twist: 0.8, alphaLit: 0 },
  /* 3 wood   */ { spec: 0.12, shininess: 10, trans: 0, wrap: 0.25, billboard: 2, twist: 0.9, alphaLit: 0 },
  /* 4 bark   */ { spec: 0.08, shininess: 12, trans: 0, wrap: 0.1, billboard: 0, twist: 0, alphaLit: 0 },
  /* 5 grass  */ { spec: 0.2, shininess: 14, trans: 0.3, wrap: 0.25, billboard: 1, twist: 0.7, alphaLit: 0, haze: 1 },
  /* 6 soil   */ { spec: 0.1, shininess: 14, trans: 0, wrap: 0.25, billboard: 0, twist: 0, alphaLit: 0, haze: 1 },
];

export function showPine(app: App, seed = PINE_SEED): Promise<void> {
  return app.run(PINE_SCENE, () => app.engine.testbed({ scene: 'pine', seed, glyphAspect: glyphAspect() }), (res) => {
    if (!res.sunDir) throw new Error('pine scene came back without its sun direction');
    app.resetEnvironment(false);
    const v = app.viewer;
    v.cards.setAtlas(app.atlasFor(res.charset));
    v.cards.setMaterials(PINE_MATERIALS);
    v.cards.setLighting({ ...DEFAULT_LIGHTING, sunDir: new Vector3(...res.sunDir) });
    v.setCards(res.cards, res.stride, res.chunks);
    // Roughly the script's camera: eye low, ~21 units out, framing a 10-unit tree.
    v.setFreeScene(new Vector3(0, 4.6, 0), new Vector3(4, 3.2, 21));
    Object.assign(app.state, { triangles: 0, dropped: 0, glyphPx: 0 });
    console.info(`[ascii] ${PINE_SCENE} seed ${seed}: ${res.count} cards in ${res.timings.generateMs.toFixed(1)} ms`);
  });
}
