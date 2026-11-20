// Unit tests for the brush maths: `npm run test:unit` (node --test runs this
// TypeScript file directly; brush.ts has no other imports).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRUSH_SIZES, dabSpacing, dabTiles, edgeWeight, strokePoints, tileDice, type BrushOptions } from './brush.ts';

const TILE = 0.5;
const solid = (radius: number, shape: BrushOptions['shape'] = 'circle'): BrushOptions => ({ radius, shape, strength: 1, soft: 0 });
const key = ([i, j]: [number, number]) => `${i},${j}`;

test('a solid circle paints every tile whose centre is inside it, and nothing else', () => {
  const r = 3;
  const tiles = dabTiles(0, 0, solid(r), TILE, 1);
  const set = new Set(tiles.map(key));
  assert.equal(set.size, tiles.length, 'no tile twice');
  for (let gj = -10; gj < 10; gj++) {
    for (let gi = -10; gi < 10; gi++) {
      const inside = Math.hypot((gi + 0.5) * TILE, (gj + 0.5) * TILE) <= r;
      assert.equal(set.has(`${gi},${gj}`), inside, `tile ${gi},${gj}`);
    }
  }
  const area = (tiles.length * TILE * TILE) / (Math.PI * r * r);
  assert.ok(Math.abs(area - 1) < 0.08, `covers about pi r^2 (${area.toFixed(3)})`);
});

test('a solid square paints a full square of tiles', () => {
  const tiles = dabTiles(0.25, 0.25, solid(1, 'square'), TILE, 1);
  assert.equal(tiles.length, 25, '2 m square of 0.5 m tiles centred on a tile: 5 x 5');
});

test('the smallest brush still paints the tile under it', () => {
  assert.deepEqual(dabTiles(3.1, -1.9, solid(0.01), TILE, 7), [[6, -4]]);
  assert.deepEqual(dabTiles(3.1, -1.9, solid(0), TILE, 7), [[6, -4]]);
});

test('strength paints about that share of the tiles', () => {
  const all = dabTiles(0, 0, solid(8), TILE, 3).length;
  const half = dabTiles(0, 0, { ...solid(8), strength: 0.5 }, TILE, 3).length;
  assert.ok(Math.abs(half / all - 0.5) < 0.06, `${half} of ${all}`);
  assert.equal(dabTiles(0, 0, { ...solid(8), strength: 0 }, TILE, 3).length, 0);
});

test('a soft edge keeps the middle solid and thins out toward the rim', () => {
  const r = 8;
  const tiles = dabTiles(0, 0, { radius: r, shape: 'circle', strength: 1, soft: 0.5 }, TILE, 11);
  const ring = (a: number, b: number) => {
    let painted = 0, total = 0;
    const set = new Set(tiles.map(key));
    for (let gj = -20; gj < 20; gj++) {
      for (let gi = -20; gi < 20; gi++) {
        const d = Math.hypot((gi + 0.5) * TILE, (gj + 0.5) * TILE) / r;
        if (d < a || d >= b) continue;
        total++;
        if (set.has(`${gi},${gj}`)) painted++;
      }
    }
    return painted / total;
  };
  assert.equal(ring(0, 0.45), 1, 'the inner half is solid');
  const mid = ring(0.6, 0.8), rim = ring(0.85, 1);
  assert.ok(mid > 0.4 && mid < 1, `between: some painted (${mid.toFixed(2)})`);
  assert.ok(rim < mid, `the rim thinner than further in (${rim.toFixed(2)} < ${mid.toFixed(2)})`);
  assert.equal(edgeWeight(1.01, 0.5), 0, 'nothing beyond the rim');
});

test('the same stroke seed paints the same tiles; another seed different ones', () => {
  const o: BrushOptions = { radius: 4, shape: 'circle', strength: 0.5, soft: 0.3 };
  assert.deepEqual(dabTiles(1, 2, o, TILE, 42), dabTiles(1, 2, o, TILE, 42));
  assert.notDeepEqual(dabTiles(1, 2, o, TILE, 42), dabTiles(1, 2, o, TILE, 43));
  const d = tileDice(5, -3, 9);
  assert.ok(d >= 0 && d < 1);
});

test('stroke points are evenly spaced and end exactly at the target', () => {
  const pts = strokePoints({ x: 0, z: 0 }, { x: 10, z: 0 }, 1);
  assert.equal(pts.length, 10);
  assert.deepEqual(pts[pts.length - 1], { x: 10, z: 0 });
  for (let k = 1; k < pts.length; k++) assert.ok(Math.abs(pts[k]!.x - pts[k - 1]!.x - 1) < 1e-9);
  assert.equal(strokePoints({ x: 1, z: 1 }, { x: 1, z: 1 }, 1).length, 1, 'no movement: one dab');
  assert.equal(dabSpacing(solid(0.25), TILE), TILE, 'never closer than a tile');
  assert.equal(dabSpacing(solid(9), TILE), 3);
});

test('brush sizes go up and include a tile-sized brush', () => {
  for (let k = 1; k < BRUSH_SIZES.length; k++) assert.ok(BRUSH_SIZES[k]! > BRUSH_SIZES[k - 1]!);
  assert.ok(BRUSH_SIZES.includes(0.25) && BRUSH_SIZES[BRUSH_SIZES.length - 1]! >= 32);
});
