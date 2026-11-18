// TESTBED (dev/test builds only). Worker-side builders for test scenes.
// Loaded on demand by the engine worker; never part of the production bundle.

import type { EngineResult, TestbedRequest } from '../engine/protocol';

/** Exports the WASM module has only when built with `--features testbed`. */
interface TestbedExports {
  cardStride(): number;
  generatePine(seed: number, glyphAspect: number): Float32Array;
  pineCharset(): string;
  pineSunDir(): Float32Array;
}

function testbedExports(wasm: object): TestbedExports {
  if (!('generatePine' in wasm)) {
    throw new Error('the engine was built without test scenes (run `npm run wasm:testbed`)');
  }
  return wasm as TestbedExports;
}

export function runTestbed(wasm: object, req: TestbedRequest): Omit<EngineResult, 'mesh'> & { mesh: null } {
  const w = testbedExports(wasm);
  switch (req.scene) {
    case 'pine': {
      const t0 = performance.now();
      const cards = w.generatePine(req.seed >>> 0, req.glyphAspect);
      const generateMs = performance.now() - t0;
      const stride = w.cardStride();
      const [x = 0, y = 1, z = 0] = w.pineSunDir();
      return {
        mesh: null,
        cards,
        stride,
        count: cards.length / stride,
        charset: w.pineCharset(),
        timings: { loadMs: 0, generateMs },
        sunDir: [x, y, z],
      };
    }
  }
}
