// Unit tests for the object brush maths: `npm run test:unit`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickKind, seeded, spacingFor, sprayDab, type Neighbour } from './spray.ts';

const minGap = (pts: { x: number; z: number }[]) => {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) m = Math.min(m, Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z));
  return m;
};

test('a dab places about density x area, all inside the brush, none closer than the spacing', () => {
  const pts = sprayDab(0, 0, { radius: 10, shape: 'circle', density: 5, spacing: 2 }, [], seeded(1));
  const expected = (5 * Math.PI * 100) / 100;
  assert.ok(Math.abs(pts.length - expected) <= 2, `${pts.length} vs ~${expected.toFixed(1)}`);
  assert.ok(pts.every((p) => Math.hypot(p.x, p.z) <= 10 + 1e-9), 'inside the circle');
  assert.ok(minGap(pts) >= 2, `min gap ${minGap(pts).toFixed(2)}`);
});

test('existing neighbours (from any chunk) keep their room, using the larger spacing', () => {
  const near: Neighbour[] = [{ x: 0, z: 0, spacing: 4 }, { x: 3, z: 3, spacing: 1 }];
  const pts = sprayDab(0, 0, { radius: 6, shape: 'circle', density: 40, spacing: 1 }, near, seeded(2));
  assert.ok(pts.length > 5);
  for (const p of pts) {
    assert.ok(Math.hypot(p.x, p.z) >= 4, 'the tree at the centre keeps 4 m');
    assert.ok(Math.hypot(p.x - 3, p.z - 3) >= 1);
  }
});

test('painting the same spot again fills the gaps, then stops', () => {
  const o = { radius: 5, shape: 'circle' as const, density: 30, spacing: 1.5 };
  const all: Neighbour[] = [];
  const rnd = seeded(3);
  const counts: number[] = [];
  for (let k = 0; k < 12; k++) {
    const pts = sprayDab(0, 0, o, all, rnd);
    all.push(...pts.map((p) => ({ ...p, spacing: o.spacing })));
    counts.push(all.length);
  }
  assert.ok(minGap(all) >= 1.5, 'still evenly spaced');
  assert.ok(counts[11]! - counts[8]! <= 2, `saturates (${counts.join(' ')})`);
  assert.ok(all.length < (Math.PI * 25) / (1.5 * 1.5), 'never more than the area allows');
});

test('a square dab stays in the square; zero density places nothing', () => {
  const pts = sprayDab(10, 10, { radius: 2, shape: 'square', density: 100, spacing: 0.3 }, [], seeded(4));
  assert.ok(pts.length > 5 && pts.every((p) => Math.abs(p.x - 10) <= 2 && Math.abs(p.z - 10) <= 2));
  assert.equal(sprayDab(0, 0, { radius: 5, shape: 'circle', density: 0, spacing: 1 }, [], seeded(5)).length, 0);
});

test('spacing by family, and "any tree" picks among the trees', () => {
  assert.equal(spacingFor('tree:oak'), 4);
  assert.equal(spacingFor('plant:fern', 2), 1.2);
  const kinds = ['tree:oak', 'tree:pine', 'bush:juniper', 'rock:slab'];
  const rnd = seeded(6);
  const picked = new Set(Array.from({ length: 40 }, () => pickKind('tree:*', kinds, rnd)));
  assert.deepEqual([...picked].sort(), ['tree:oak', 'tree:pine']);
  assert.equal(pickKind('rock:slab', kinds, rnd), 'rock:slab');
});
