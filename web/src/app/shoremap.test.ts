// The water map's current follows the land (run: npm run test:unit).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ShoreMap } from './shoremap.ts';

/** A stand-in for MapData: water where `isWater`, heights from `height`. */
function fakeMap(isWater: (x: number, z: number) => boolean, height: (x: number, z: number) => number) {
  return {
    info: { chunkSize: 32 },
    groundAt: (x: number, z: number) => (isWater(x, z) ? 'water' : 'grass'),
    heightAt: height,
  } as never;
}

/** The current (m/s, x and z) at world (x, z), map centred on the origin. */
function flowAt(sm: ShoreMap, x: number, z: number): [number, number] {
  const k = (Math.floor(z) + 128) * 256 + (Math.floor(x) + 128);
  return [sm.flow[k * 2]!, sm.flow[k * 2 + 1]!];
}

test('a stream on a slope runs downhill along its bed, faster where steeper', () => {
  const sm = new ShoreMap();
  // Water strip along x, 3 m wide; the ground falls toward +x.
  sm.update(fakeMap((x, z) => Math.abs(z) < 1.5 && x > -60 && x < 60, (x) => -0.08 * x), 0, 0);
  for (const x of [-40, -10, 20, 45]) {
    const [fx, fz] = flowAt(sm, x, 0);
    assert.ok(fx > 0.3, `flows toward +x at x=${x} (${fx.toFixed(2)})`);
    assert.ok(Math.abs(fz) < Math.abs(fx) * 0.3, 'along the bed, not across it');
  }
  const gentle = new ShoreMap();
  gentle.update(fakeMap((x, z) => Math.abs(z) < 1.5 && x > -60 && x < 60, (x) => -0.01 * x), 0, 0);
  assert.ok(flowAt(sm, 0, 0)[0] > flowAt(gentle, 0, 0)[0] + 0.2, 'steeper is faster');
});

test('a bend: the current turns with the channel', () => {
  const sm = new ShoreMap();
  // An L-shaped channel: down from z=-50 to z=0 at x=0, then along +x; falling along its length.
  const inL = (x: number, z: number) => (Math.abs(x) < 1.5 && z > -50 && z < 1.5) || (Math.abs(z) < 1.5 && x > -1.5 && x < 50);
  const along = (x: number, z: number) => (z < 0 ? z + 50 : 50 + x); // metres downstream
  sm.update(fakeMap(inL, (x, z) => -0.05 * along(x, z)), 0, 0);
  const [ax, az] = flowAt(sm, 0, -30);
  assert.ok(az > 0.3 && Math.abs(ax) < az * 0.3, `first leg runs +z (${ax.toFixed(2)}, ${az.toFixed(2)})`);
  const [bx, bz] = flowAt(sm, 30, 0);
  assert.ok(bx > 0.3 && Math.abs(bz) < bx * 0.3, `second leg runs +x (${bx.toFixed(2)}, ${bz.toFixed(2)})`);
});

test('a lake is still; a river feeding it runs until it opens into the lake', () => {
  const sm = new ShoreMap();
  const lake = (x: number, z: number) => Math.hypot(x, z) < 18;
  const river = (x: number, z: number) => Math.abs(x) < 1.5 && z < -16 && z > -80;
  sm.update(fakeMap((x, z) => lake(x, z) || river(x, z), (x, z) => (river(x, z) && !lake(x, z) ? 0.06 * (-16 - z) : -2)), 0, 0);
  for (const [x, z] of [[0, 0], [8, 5], [-6, -4], [10, 10]] as const) {
    const [fx, fz] = flowAt(sm, x, z);
    assert.ok(Math.hypot(fx, fz) < 0.08, `the lake is still at (${x}, ${z})`);
  }
  const [rx, rz] = flowAt(sm, 0, -50);
  assert.ok(rz > 0.3, `the river runs toward the lake (+z): ${rz.toFixed(2)}`);
  assert.ok(Math.abs(rx) < rz * 0.3);
});

test('flat water with no slope still drains one way, never in circles', () => {
  const sm = new ShoreMap();
  sm.update(fakeMap((x, z) => Math.abs(z) < 1.5 && x > -40 && x < 40, () => 0), 0, 0);
  const signs = new Set([-30, -15, 0, 15, 30].map((x) => Math.sign(flowAt(sm, x, 0)[0])));
  assert.equal(signs.size, 1, 'the whole stream runs the same way');
});
