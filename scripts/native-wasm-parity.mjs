// Records what the WASM engine produces for a few fixed inputs, so a Rust test
// can check the native build of the same engine against it (float math in
// native libm and in WASM can differ). Needs `npm run wasm` first.
//   node scripts/native-wasm-parity.mjs [--dump dir]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import init, * as wasm from '../web/src/pkg/ascii_engine.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await init({ module_or_path: readFileSync(join(root, 'web/src/pkg/ascii_engine_bg.wasm')) });
const dump = process.argv.includes('--dump') ? process.argv[process.argv.indexOf('--dump') + 1] : null;

const fnv = (f32) => {
  const u = new Uint32Array(f32.buffer, f32.byteOffset, f32.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
};
const rec = (name, f32) => {
  if (dump) writeFileSync(join(dump, `${name}.f32`), Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  let sum = 0, abs = 0;
  for (let i = 0; i < f32.length; i++) { sum += f32[i]; abs += Math.abs(f32[i]); }
  return { name, len: f32.length, hash: fnv(f32), sum, abs };
};
const ASPECT = 103 / 154;
const out = { aspect: ASPECT, items: [] };

const w = new wasm.InfiniteWorld(1, false);
out.items.push(rec('sky', w.skyCards(ASPECT)));
for (const [cx, cz, ex, ey, ez] of [[0, 0, 10, 8, 12], [3, -2, 10, 8, 12], [-5, 4, 0, 5, 0]]) {
  const c = w.buildChunk(cx, cz, ex, ey, ez, ASPECT);
  out.items.push(rec(`chunk_${cx}_${cz}_cards`, c.takeCards()));
  out.items.push(rec(`chunk_${cx}_${cz}_heights`, c.takeHeights()));
  out.items.push(rec(`chunk_${cx}_${cz}_body`, c.takeBody()));
  c.free();
}
const e = new wasm.Engine();
e.loadStl(readFileSync(join(root, 'web/public/models/sphere.stl')), true);
const cfg = new wasm.CardConfig();
Object.assign(cfg, { seed: 7, glyphSize: 0.045, sizeFactor: 1.6, glyphRule: 1, patternScale: 0.22, glyphAspect: ASPECT, r: 0.78, g: 0.62, b: 0.45, colorJitter: 0.12, twist: 0.25, tilt: 0.15, alphaMin: 0.8, alphaMax: 1.0 });
out.items.push(rec('sphere_cards', e.generate(cfg, wasm.defaultCharset())));
const g = wasm.buildGallery('rocks', 1, ASPECT);
out.items.push(rec('gallery_rocks_cards', g.takeCards()));

writeFileSync(join(root, 'native/core/tests/fixtures/wasm_engine.json'), JSON.stringify(out, null, 1) + '\n');
console.log(out.items.map((i) => `${i.name} ${i.len} ${i.hash.toString(16)}`).join('\n'));
