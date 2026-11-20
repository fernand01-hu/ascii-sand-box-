// Unit tests for the height brush maths and the map's heights:
// `npm run test:unit` (node --test runs this TypeScript directly).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { falloff, heightDab } from './heightbrush.ts';
import { mapHistory } from './history.ts';
import { MapData } from './map.ts';

const info = () => ({ chunkSize: 32, tile: 0.5, tiles: 64, groundKinds: ['canvas', 'grass'], objectKinds: ['tree:oak'] });
const flat = () => 0;

test('falloff is 1 in the middle, 0 at the rim, smooth between', () => {
  assert.equal(falloff(0), 1);
  assert.equal(falloff(1), 0);
  assert.equal(falloff(2), 0);
  assert.ok(Math.abs(falloff(0.5) - 0.5) < 1e-9);
  for (let d = 0; d < 1; d += 0.05) assert.ok(falloff(d) >= falloff(d + 0.05) - 1e-12, 'never rises outward');
});

test('raise lifts the middle by the strength and nothing past the radius', () => {
  const pts = heightDab(10, 10, { radius: 4, mode: 'raise', strength: 2 }, flat);
  const at = new Map(pts.map((p) => [`${p.vi},${p.vj}`, p.h]));
  assert.equal(at.get('10,10'), 2);
  assert.ok(pts.every((p) => Math.hypot(p.vi - 10, p.vj - 10) < 4));
  assert.ok((at.get('12,10') ?? 0) > 0 && (at.get('12,10') ?? 0) < 2, 'lower toward the rim');
  const down = heightDab(10, 10, { radius: 4, mode: 'lower', strength: 1 }, flat);
  assert.equal(down.find((p) => p.vi === 10 && p.vj === 10)!.h, -1);
});

test('smooth flattens a spike; flatten moves toward the level', () => {
  const spike = (vi: number, vj: number) => (vi === 0 && vj === 0 ? 9 : 0);
  const s = heightDab(0, 0, { radius: 2, mode: 'smooth', strength: 1 }, spike).find((p) => p.vi === 0 && p.vj === 0)!;
  assert.ok(Math.abs(s.h - 1) < 1e-9, `the spike drops to the 3 x 3 average (${s.h})`);
  const f = heightDab(0, 0, { radius: 3, mode: 'flatten', strength: 0.5, level: 4 }, flat).find((p) => p.vi === 0 && p.vj === 0)!;
  assert.equal(f.h, 2, 'half way to the level');
  assert.equal(heightDab(0, 0, { radius: 3, mode: 'smooth', strength: 1 }, flat).length, 0, 'smoothing flat ground changes nothing');
});

test('the map shares border points between chunks and reads heights in between', () => {
  const m = new MapData(info());
  m.setHeights([{ vi: 32, vj: 10, h: 3 }]); // on the border of chunks 0 and 1
  assert.equal(m.pointHeight(32, 10), 3);
  assert.equal(m.editedChunks, 2, 'both chunks holding the point store it');
  assert.equal(m.payload(0, 0).heights![10 * 33 + 32], 3, 'chunk 0 at its far edge');
  assert.equal(m.payload(1, 0).heights![10 * 33 + 0], 3, 'chunk 1 at its near edge');
  assert.ok(Math.abs(m.heightAt(31.5, 10) - 1.5) < 1e-9, 'bilinear between points');
  m.setHeights([{ vi: 64, vj: 64, h: 1 }]); // a corner: four chunks
  assert.equal(['w1,1', 'w2,1', 'w1,2', 'w2,2'].filter((k) => { const [cx, cz] = k.slice(1).split(',').map(Number); return m.hasHeightsIn(cx!, cz!); }).length, 4);
  m.setHeights([{ vi: 32, vj: 10, h: 0 }, { vi: 64, vj: 64, h: 0 }]);
  assert.equal(m.editedChunks, 0, 'back to flat: nothing stored');
  assert.equal(m.hasHeights, false);
});

test('height edits undo and redo; clear and load handle heights', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  h.begin('raise');
  m.setHeights(heightDab(30, 5, { radius: 5, mode: 'raise', strength: 2 }, (i, j) => m.pointHeight(i, j)));
  h.end();
  const peak = m.heightAt(30, 5);
  assert.equal(peak, 2);
  h.undo();
  assert.equal(m.heightAt(30, 5), 0);
  assert.equal(m.editedChunks, 0);
  h.redo();
  assert.equal(m.heightAt(30, 5), 2);
  const saved = m.exportData();
  m.clear();
  assert.equal(m.heightAt(30, 5), 0);
  h.undo();
  assert.equal(m.heightAt(30, 5), 2, 'undoing the clear brings the hill back');
  const other = new MapData(info());
  other.replaceWith(saved.chunks, saved.objects);
  for (const [x, z] of [[30, 5], [32, 5], [33.5, 6.2], [27, 2]]) assert.ok(Math.abs(other.heightAt(x!, z!) - m.heightAt(x!, z!)) < 1e-6, `loaded the same hill at ${x},${z}`);
});
