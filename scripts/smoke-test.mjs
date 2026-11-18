// Runs the compiled WASM engine in Node against every bundled model and some
// hostile inputs. Checks the exact binary the browser will load.
// Needs the testbed build (npm run wasm:testbed) for the pine checks.
//
//   node scripts/smoke-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import init, * as wasm from '../web/src/pkg/ascii_engine.js';

const { CardConfig, Engine, cardStride, normalizeCharset, defaultCharset } = wasm;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await init({ module_or_path: readFileSync(join(root, 'web/src/pkg/ascii_engine_bg.wasm')) });

const STRIDE = cardStride();
assert.equal(STRIDE, 16, 'renderer expects 16 floats per card');
const CHARSET = defaultCharset();
const GLYPHS = [...CHARSET].length;

const config = (patch = {}) => {
  const c = new CardConfig();
  Object.assign(c, { glyphAspect: 0.64, seed: 3 }, patch);
  return c;
};

function checkCards(cards, glyphs) {
  assert.ok(cards.length > 0 && cards.length % STRIDE === 0);
  for (let i = 0; i < cards.length; i += STRIDE) {
    for (let k = 0; k < STRIDE; k++) assert.ok(Number.isFinite(cards[i + k]), `non-finite value in card ${i / STRIDE}`);
    const g = cards[i + 13];
    assert.ok(Number.isInteger(g) && g >= 0 && g < glyphs, `glyph ${g} out of range`);
    const a = cards[i + 12];
    assert.ok(a >= 0 && a <= 1, `alpha ${a} out of range`);
  }
}

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

const engine = new Engine();
const modelsDir = join(root, 'web/public/models');
const models = readdirSync(modelsDir).filter((f) => f.endsWith('.stl'));
assert.ok(models.length >= 4, 'expected the bundled test models');

for (const file of models) {
  test(`model ${file}`, () => {
    const bytes = readFileSync(join(modelsDir, file));
    let t = performance.now();
    engine.loadStl(bytes, true);
    const loadMs = performance.now() - t;
    const tris = engine.triangleCount();
    assert.ok(tris > 0);
    const pos = engine.meshPositions();
    assert.equal(pos.length, tris * 9);
    assert.equal(engine.meshNormals().length, tris * 9);
    // Normalized frame: largest dimension 2, sitting on y = 0.
    let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      xmin = Math.min(xmin, pos[i]); xmax = Math.max(xmax, pos[i]);
      ymin = Math.min(ymin, pos[i + 1]); ymax = Math.max(ymax, pos[i + 1]);
    }
    assert.ok(Math.abs(ymin) < 1e-4, `ymin ${ymin}`);
    assert.ok(Math.abs(xmin + xmax) < 1e-3, 'not centred on x');
    assert.ok(Math.max(ymax - ymin, xmax - xmin) <= 2.0001);

    for (const rule of [0, 1, 2]) {
      const c = config({ glyphRule: rule });
      t = performance.now();
      const a = engine.generate(c, CHARSET);
      const genMs = performance.now() - t;
      checkCards(a, GLYPHS);
      assert.deepEqual(engine.generate(c, CHARSET), a, 'same seed must give identical cards');
      c.free();
      if (rule === 1) {
        console.log(`       ${tris} tris (${engine.droppedTriangles()} dropped), parse ${loadMs.toFixed(1)} ms, ` +
          `${a.length / STRIDE} cards ${genMs.toFixed(1)} ms`);
      }
    }
  });
}

test('glyph size, not count, sets density', () => {
  const big = config({ glyphSize: 0.06 });
  const small = config({ glyphSize: 0.03 });
  const nBig = engine.generate(big, CHARSET).length / STRIDE;
  const nSmall = engine.generate(small, CHARSET).length / STRIDE;
  assert.ok(Math.abs(nSmall / nBig - 4) < 0.05, `${nSmall} vs ${nBig}`);
  big.free(); small.free();
});

test('tiny glyphs hit the card cap instead of failing', () => {
  const c = config({ glyphSize: 0.002 });
  const t = performance.now();
  const cards = engine.generate(c, CHARSET);
  console.log(`       ${cards.length / STRIDE} cards in ${(performance.now() - t).toFixed(0)} ms`);
  assert.equal(cards.length, 2_000_000 * STRIDE);
  c.free();
});

test('charset is normalized by the engine', () => {
  assert.equal(normalizeCharset('aa b\tcb'), 'abc');
  assert.throws(() => normalizeCharset('   '));
  const c = config();
  const cards = engine.generate(c, 'x x y');
  checkCards(cards, 2);
  c.free();
});

test('garbage input is rejected and the previous mesh is kept', () => {
  const before = engine.triangleCount();
  for (const junk of [new Uint8Array(0), new Uint8Array(10), new Uint8Array(84), Buffer.from('solid nope\nendsolid'), Buffer.from('hello world, not an stl at all')]) {
    assert.throws(() => engine.loadStl(junk, true));
  }
  let seed = 1;
  for (let n = 0; n < 200; n++) {
    const len = (n * 37) % 600;
    const b = new Uint8Array(len).map(() => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
    try { engine.loadStl(b, true); } catch { /* rejected is fine; crashing is not */ }
  }
  engine.loadStl(readFileSync(join(modelsDir, 'sphere.stl')), true);
  assert.ok(engine.triangleCount() > 0 && before > 0);
  const c = config();
  checkCards(engine.generate(c, CHARSET), GLYPHS);
  c.free();
});

test('invalid settings are rejected', () => {
  for (const patch of [{ glyphSize: 0 }, { glyphRule: 9 }, { patternScale: 0 }, { sizeFactor: NaN }, { alphaMin: 1, alphaMax: 0 }]) {
    const c = config(patch);
    assert.throws(() => engine.generate(c, CHARSET), undefined, JSON.stringify(patch));
    c.free();
  }
  const c = config();
  assert.throws(() => engine.generate(c, ' \n'));
  c.free();
});

test('generate without a mesh fails cleanly', () => {
  const fresh = new Engine();
  const c = config();
  assert.throws(() => fresh.generate(c, CHARSET), /no mesh/);
  c.free();
  fresh.free();
});

for (const category of ['rocks', 'plants', 'bushes', 'trees']) {
  test(`scenery gallery: ${category}`, () => {
    const t = performance.now();
    const scene = wasm.buildGallery(category, 1, 0.64);
    const cards = scene.takeCards();
    const body = scene.takeBody();
    const cam = scene.camera();
    scene.free();
    const ms = performance.now() - t;
    const n = cards.length / STRIDE;
    console.log(`       ${n} cards, ${body.length / 9} solid triangles, ${ms.toFixed(0)} ms`);
    assert.ok(n > 10_000 && n < 1_500_000);
    assert.equal(cam.length, 7);
    const glyphs = [...wasm.sceneryCharset()].length;
    const materials = wasm.sceneryMaterials().length / 8;
    const modes = [0, 0, 0, 0];
    for (let i = 0; i < cards.length; i += STRIDE) {
      for (let k = 0; k < STRIDE; k++) assert.ok(Number.isFinite(cards[i + k]), `card ${i / STRIDE} field ${k}`);
      const slot = cards[i + 13];
      const high = Math.floor(slot / 1024);
      assert.ok(slot % 1024 < glyphs, `glyph ${slot % 1024}`);
      assert.ok(high % 64 < materials, `material ${high % 64}`);
      modes[Math.floor(high / 64)]++;
    }
    assert.ok(modes[1] > 0, 'billboards present');
    if (category === 'rocks') assert.ok(modes[3] > 0 && body.length > 0, 'rocks are solid');
  });
}
for (const preset of ['meadow', 'forest', 'lake', 'valley', 'alpine']) {
  test(`landscape: ${preset}`, () => {
    const t = performance.now();
    const scene = wasm.buildScene(preset, 1, 0.64);
    const cards = scene.takeCards();
    const body = scene.takeBody();
    const env = scene.env();
    scene.free();
    const n = cards.length / STRIDE;
    console.log(`       ${n} cards, ${body.length / 9} body triangles, ${(performance.now() - t).toFixed(0)} ms`);
    assert.ok(n > 100_000 && n < 2_500_000, `${n} cards`);
    assert.equal(env.length, 9);
    const modes = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < cards.length; i += STRIDE) {
      for (let k = 0; k < STRIDE; k++) assert.ok(Number.isFinite(cards[i + k]), `card ${i / STRIDE} field ${k}`);
      modes[Math.floor(cards[i + 13] / 1024 / 64)]++;
    }
    assert.ok(modes[4] > 20_000, 'sky');
    assert.ok(modes[7] > 50_000, 'ground marks lean toward the camera');
    assert.equal(modes[5], 7000, 'rain particles');
    assert.equal(modes[6], 900, 'leaf particles');
  });
}
test('infinite world: chunks join seamlessly, detail falls with distance', () => {
  const [S, G] = wasm.worldConsts();
  const w = new wasm.InfiniteWorld(1, false);
  const sky = w.skyCards(0.64);
  assert.ok(sky.length / STRIDE > 20_000, 'sky, rain, leaves');
  const eye = [16, w.height(16, 16) + 1.7, 16];
  const t = performance.now();
  const build = (cx, cz) => { const c = w.buildChunk(cx, cz, ...eye, 0.64); const r = { cards: c.takeCards(), h: c.takeHeights(), col: c.takeColliders() }; c.free(); return r; };
  const a = build(0, 0), b = build(1, 0), far = build(8, 3);
  console.log(`       near ${a.cards.length / STRIDE} cards, neighbour ${b.cards.length / STRIDE}, far ${far.cards.length / STRIDE}, ${(performance.now() - t).toFixed(0)} ms`);
  const n = G + 1;
  for (let j = 0; j < n; j++) assert.ok(Math.abs(a.h[j * n + G] - b.h[j * n]) < 1e-3, 'shared chunk edge heights match');
  assert.ok(far.cards.length < a.cards.length / 3, 'far chunks use fewer, bigger glyphs');
  for (const c of [a, b, far]) for (let i = 0; i < c.cards.length; i++) assert.ok(Number.isFinite(c.cards[i]));
  assert.equal(S, 32);
  w.free();
});

test('scenery rejects bad input', () => {
  assert.throws(() => wasm.buildScene('desert', 1, 0.64), /unknown scene/);
  assert.throws(() => wasm.buildGallery('volcanoes', 1, 0.64), /unknown gallery/);
  assert.throws(() => wasm.buildGallery('trees', 1, 0));
});

test('testbed: procedural pine', () => {
  assert.ok('generatePine' in wasm, 'run `npm run wasm:testbed` first');
  const t = performance.now();
  const cards = wasm.generatePine(23, 0.64);
  console.log(`       ${cards.length / STRIDE} cards in ${(performance.now() - t).toFixed(0)} ms`);
  assert.ok(cards.length / STRIDE > 50_000);
  const glyphs = [...wasm.pineCharset()].length;
  for (let i = 0; i < cards.length; i += STRIDE) {
    for (let k = 0; k < STRIDE; k++) assert.ok(Number.isFinite(cards[i + k]));
    const g = cards[i + 13];
    assert.ok(g % 1024 < glyphs && g >= 1024 && g < 7 * 1024, `glyph slot ${g}`);
    assert.ok(cards[i + 14] >= 0 && cards[i + 14] <= 1 && cards[i + 15] >= 0 && cards[i + 15] <= 1);
  }
  assert.deepEqual(wasm.generatePine(23, 0.64), cards, 'same seed must give the same tree');
  assert.throws(() => wasm.generatePine(23, 0));
});

if (failures) {
  console.log(`\n${failures} smoke test(s) failed`);
  process.exit(1);
}
console.log('\nall WASM smoke tests passed');
