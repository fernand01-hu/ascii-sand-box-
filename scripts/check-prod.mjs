// Checks the production build (dist/) after `npm run build`: the app module
// and its worker are there, and the test hooks (web/src/hooks.ts) and the
// engine's testbed scenes did not leak in.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');
const files = readdirSync(dist);
const problems = [];

const wasm = files.filter((f) => f.endsWith('.wasm'));
const js = files.filter((f) => f.endsWith('.js'));
if (wasm.length !== 1) problems.push(`expected exactly one .wasm file, found ${wasm.length}`);
if (!js.some((f) => f.startsWith('worker'))) problems.push('worker bundle is missing');

const forbidden = ['procedural-pine', '__ascii', 'installHooks'];
for (const f of [...wasm, ...js]) {
  const text = readFileSync(join(dist, f)).toString('latin1');
  for (const word of forbidden) {
    if (text.includes(word)) problems.push(`${f} contains "${word}" (testbed/devtools leaked into production)`);
  }
}
const appJs = js.map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
for (const needed of ['start', 'worker_run', 'load_stl']) {
  if (!appJs.includes(needed)) problems.push(`production bundle is missing app export "${needed}"`);
}

if (problems.length) {
  console.log(problems.map((p) => `  FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log(`  ok   production build is clean (${js.length} js, ${wasm.length} wasm, no test hooks)`);
