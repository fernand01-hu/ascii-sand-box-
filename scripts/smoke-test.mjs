// Runs the compiled WASM engine in Node against every bundled model and some
// hostile inputs. Checks the exact binary the browser will load.
//
//   npm run wasm && node scripts/smoke-test.mjs

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import init, { CardConfig, Engine, cardStride } from '../web/src/pkg/ascii_engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await init({ module_or_path: readFileSync(join(root, 'web/src/pkg/ascii_engine_bg.wasm')) });

const STRIDE = cardStride();
assert.equal(STRIDE, 14, 'renderer expects 14 floats per card');

const config = (patch = {}) => {
  const c = new CardConfig();
  Object.assign(c, { count: 50_000, glyphCount: 16, glyphAspect: 0.6, seed: 3 }, patch);
  return c;
};

function checkCards(cards, count, glyphs) {
  assert.equal(cards.length, count * STRIDE);
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

    const c = config();
    t = performance.now();
    const a = engine.generate(c);
    const genMs = performance.now() - t;
    checkCards(a, 50_000, 16);
    assert.deepEqual(engine.generate(c), a, 'same seed must give identical cards');
    c.free();
    console.log(`       ${tris} tris (${engine.droppedTriangles()} dropped), parse ${loadMs.toFixed(1)} ms, 50k cards ${genMs.toFixed(1)} ms`);
  });
}

test('one million cards', () => {
  const c = config({ count: 1_000_000 });
  const t = performance.now();
  const cards = engine.generate(c);
  console.log(`       1M cards in ${(performance.now() - t).toFixed(0)} ms`);
  assert.equal(cards.length, 1_000_000 * STRIDE);
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
  const c = config({ count: 100 });
  checkCards(engine.generate(c), 100, 16);
  c.free();
});

test('invalid settings are rejected', () => {
  for (const patch of [{ count: 0 }, { count: 3_000_000 }, { glyphCount: 0 }, { sizeFactor: NaN }, { alphaMin: 1, alphaMax: 0 }]) {
    const c = config(patch);
    assert.throws(() => engine.generate(c), undefined, JSON.stringify(patch));
    c.free();
  }
});

test('generate without a mesh fails cleanly', () => {
  const fresh = new Engine();
  const c = config();
  assert.throws(() => fresh.generate(c), /no mesh/);
  c.free();
  fresh.free();
});

if (failures) {
  console.log(`\n${failures} smoke test(s) failed`);
  process.exit(1);
}
console.log('\nall WASM smoke tests passed');
