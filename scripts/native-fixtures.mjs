// Generates native/core/tests/fixtures/parity.json from the webapp's own
// TypeScript (physics.ts, chunks.ts), so the Rust core can be checked against
// it bit for bit. Run: node scripts/native-fixtures.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(join(tmpdir(), 'ascii-ref-'));
execFileSync('npx', ['tsc', 'web/src/app/physics.ts', 'web/src/engine/chunks.ts', '--ignoreConfig', '--outDir', out,
  '--target', 'es2022', '--module', 'es2022', '--skipLibCheck'], { cwd: root, stdio: 'ignore' });
// ES modules need a package.json type to load from the temp dir.
writeFileSync(join(out, 'package.json'), '{"type":"module"}');
const phys = await import(pathToFileURL(join(out, 'app/physics.js')).href);
const chunks = await import(pathToFileURL(join(out, 'engine/chunks.js')).href);

// ---- physics ----------------------------------------------------------------
const n = 65, size = 64;
const heights = new Float32Array(n * n);
const mask = new Uint8Array(n * n);
for (let j = 0; j < n; j++) {
  for (let i = 0; i < n; i++) {
    heights[j * n + i] = ((i * 7 + j * 13) % 11) * 0.04 + i * 0.02;
    if (i >= 40 && i < 48 && j >= 10 && j < 30) mask[j * n + i] = 1;
  }
}
const colliders = new Float32Array([5, 5, 0.5, 3, -10, 8, 0.8, 0.5, 0, -6, 0.6, 5, -3, -3, 0.4, 0.2]);
const world = { heights, n, size, water: 0.5, waterMask: mask, colliders };

function scenario(spawn, yaw, schedule, total, dt) {
  const ground = new phys.GridGround(world);
  const p = new phys.Physics(ground);
  const s = p.spawn(spawn[0], spawn[1], yaw);
  const samples = [];
  const first = { ...s };
  let t = 0, next = 0.5;
  while (t < total - 1e-9) {
    const seg = schedule.find((q) => t >= q.t0 && t < q.t1);
    const input = seg ? seg.input : { forward: 0, right: 0, run: false, jump: false };
    p.update(s, { forward: input.forward ?? 0, right: input.right ?? 0, run: !!input.run, jump: !!input.jump }, dt);
    t += dt;
    if (t >= next - 1e-9) {
      samples.push([s.x, s.y, s.z, s.vx, s.vy, s.vz, s.onGround ? 1 : 0, s.yaw]);
      next += 0.5;
    }
  }
  return { spawn, yaw, schedule, total, dt, first: [first.x, first.y, first.z], samples };
}
const scenarios = [
  scenario([-20, -20], 0.3, [{ t0: 0, t1: 6, input: { forward: 1 } }], 6, 1 / 60),
  scenario([-15, 0], -1.2, [{ t0: 0, t1: 8, input: { forward: 1, right: 0.5, run: true } }, { t0: 1, t1: 1.3, input: { forward: 1, jump: true, run: true } }, { t0: 3, t1: 3.2, input: { forward: 1, jump: true, run: true } }], 8, 1 / 75),
  scenario([5, 12], 3.14159, [{ t0: 0, t1: 6, input: { forward: 1 } }], 6, 1 / 60),
  scenario([20, 20], 1.57, [{ t0: 0, t1: 8, input: { forward: 1, run: true } }], 8, 1 / 30),
  scenario([-8, 4], 2.2, [{ t0: 0, t1: 6, input: { forward: 1, right: -1 } }], 6, 1 / 144),
];

// ---- chunk grouping ------------------------------------------------------------
const N = 3000;
const cards = new Float32Array(N * 16);
for (let i = 0; i < N; i++) {
  const o = i * 16;
  cards[o] = ((i * 37) % 1000) / 10 - 50;
  cards[o + 1] = (i % 13) * 0.25;
  cards[o + 2] = ((i * 91) % 1000) / 10 - 50;
  cards[o + 6] = 0.01 * (i % 5);
  cards[o + 7] = 0.1 + 0.01 * (i % 7);
  cards[o + 8] = 0.002 * (i % 3);
  cards[o + 9] = i; // identity, to read the shuffle back
  const mode = i % 11 < 8 ? 0 : 4 + (i % 11) - 8; // mostly plain, some sky/rain/leaf
  cards[o + 13] = (i % 16) + 1024 * ((i % 5) + 64 * mode);
}
const run = (allGlobal) => {
  const r = chunks.chunkCards(cards, 16, allGlobal);
  const ids = Array.from({ length: N }, (_, k) => r.cards[k * 16 + 9]);
  return { allGlobal, table: Array.from(r.chunks), ids };
};

const mul = (seed) => {
  let a = seed >>> 0;
  return Array.from({ length: 6 }, () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
};

const dest = join(root, 'native/core/tests/fixtures/parity.json');
writeFileSync(dest, JSON.stringify({ scenarios, chunking: [run(false), run(true)], mulberry: { 13: mul(13), 2: mul(2) } }) + '\n');
console.log('wrote', dest);
