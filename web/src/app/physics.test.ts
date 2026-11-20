// The walking player's physics on painted ground (run: npm run test:unit).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, PLAYER, WADE_DEPTH, type Ground } from './physics.ts';

/** Flat ground; water where x > 10; sand where x < -10; colliders as given. */
function ground(colliders: [number, number, number, number][] = [], wade = true): Ground {
  return {
    height: () => 0,
    isWater: (x) => x > 10,
    inBounds: () => true,
    collidersNear: (_x, _z, f) => colliders.forEach(([cx, cz, r, top]) => f(cx, cz, r, top)),
    wade,
    surface: (x) => (x > 10 ? 'water' : x < -10 ? 'sand' : 'grass'),
  };
}

/** Walk toward +x (yaw -90 degrees) for `seconds`; returns the state. */
function walk(g: Ground, x0: number, seconds: number, input = { forward: 1, right: 0, run: false, jump: false }) {
  const p = new Physics(g);
  const s = { x: x0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, onGround: true, yaw: -Math.PI / 2, pitch: 0 };
  for (let t = 0; t < seconds; t += 1 / 60) p.update(s, input, 1 / 60);
  return s;
}

test('walking on grass covers about the walking speed', () => {
  const s = walk(ground(), -5, 2);
  assert.ok(Math.abs(s.x - (-5 + 2 * PLAYER.walk)) < 1.5, `x ${s.x.toFixed(2)}`);
});

test('water is waded: slower, knee deep, no running or jumping', () => {
  const dry = walk(ground(), -5, 2, { forward: 1, right: 0, run: true, jump: false });
  const wet = walk(ground(), 20, 2, { forward: 1, right: 0, run: true, jump: false });
  assert.ok(wet.x - 20 < (dry.x + 5) * 0.35, `wading is much slower than running: ${(wet.x - 20).toFixed(2)} vs ${(dry.x + 5).toFixed(2)}`);
  assert.ok(Math.abs(wet.y + WADE_DEPTH) < 1e-6, `standing in the water (y ${wet.y})`);
  const jump = walk(ground(), 20, 0.3, { forward: 0, right: 0, run: false, jump: true });
  assert.ok(jump.y <= -WADE_DEPTH + 1e-6, 'no jumping out of the water');
});

test('sand is a little slower than grass', () => {
  const grass = walk(ground(), -5, 2), sand = walk(ground(), -40, 2);
  assert.ok(sand.x + 40 < (grass.x + 5) * 0.92, `${(sand.x + 40).toFixed(2)} vs ${(grass.x + 5).toFixed(2)}`);
});

test('a tree trunk stops the player at its edge', () => {
  const s = walk(ground([[0, 0, 0.3, 8]]), -5, 3);
  assert.ok(s.x < -(0.3 + PLAYER.radius) + 0.05 && s.x > -1.2, `stopped at the trunk (x ${s.x.toFixed(2)})`);
});

test('where water is not for wading (the old worlds) it still blocks the way', () => {
  const s = walk(ground([], false), 5, 3);
  assert.ok(s.x <= 10.01, `stopped at the shore (x ${s.x.toFixed(2)})`);
});
