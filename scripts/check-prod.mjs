// Checks the production build (dist/) after `npm run build`:
// the engine and app are there, and nothing from the testbed or the dev tools
// leaked in (no pine code in the JS or the WASM, no debug hooks).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');
const files = readdirSync(dist);
const problems = [];

const wasm = files.filter((f) => f.endsWith('.wasm'));
const js = files.filter((f) => f.endsWith('.js'));
if (wasm.length !== 1) problems.push(`expected exactly one .wasm file, found ${wasm.length}`);
if (!js.some((f) => f.startsWith('worker'))) problems.push('engine worker bundle is missing');

const forbidden = ['generatePine', 'pineCharset', 'pineSunDir', 'procedural-pine', '__ascii', 'installDevtools', 'runTestbed'];
for (const f of [...wasm, ...js]) {
  const text = readFileSync(join(dist, f)).toString('latin1');
  for (const word of forbidden) {
    if (text.includes(word)) problems.push(`${f} contains "${word}" (testbed/devtools leaked into production)`);
  }
}
const engineJs = js.map((f) => readFileSync(join(dist, f), 'utf8')).join('\n');
for (const needed of ['loadStl', 'normalizeCharset', 'buildGallery', 'skyCards', 'buildChunk', 'sceneryMaterials']) {
  if (!engineJs.includes(needed)) problems.push(`production bundle is missing engine export "${needed}"`);
}

if (problems.length) {
  console.log(problems.map((p) => `  FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log(`  ok   production build is clean (${js.length} js, ${wasm.length} wasm, no testbed or devtools)`);
