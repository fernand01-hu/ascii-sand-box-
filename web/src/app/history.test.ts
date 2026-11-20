// Unit tests for undo / redo on the map: `npm run test:unit`
// (node --test runs this TypeScript directly; map.ts and history.ts have
// no runtime imports).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { History, mapHistory } from './history.ts';
import { MapData } from './map.ts';

const info = () => ({ chunkSize: 32, tile: 0.5, tiles: 64, groundKinds: ['canvas', 'grass', 'sand', 'water', 'rock'], objectKinds: ['tree:oak', 'rock:boulder'] });

/** Everything the map holds, comparable with deepEqual. */
function snapshot(m: MapData) {
  const tiles: string[] = [];
  for (let gj = -80; gj < 80; gj++) for (let gi = -80; gi < 80; gi++) { const c = m.tileCode(gi, gj); if (c) tiles.push(`${gi},${gj}:${c}`); }
  const objects = m.allObjects().map((o) => ({ ...o })).sort((a, b) => a.id - b.id);
  return { tiles, objects, edited: m.editedChunks };
}

test('a stroke is one action: undo restores every tile, redo repaints them', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  m.paintTileList([[0, 0], [1, 0]], 'grass'); // an earlier, separate action
  const before = snapshot(m);
  h.begin('stroke');
  m.paintTileList([[1, 0], [2, 0], [70, 3]], 'sand'); // crosses into the next chunk (tile 70)
  m.paintTileList([[3, 0]], 'sand');
  h.end();
  const after = snapshot(m);
  assert.equal(h.list().undo.length, 2);
  assert.equal(h.undo()?.label, 'stroke');
  assert.deepEqual(snapshot(m), before, 'undo gives back the map as it was, grass under the sand included');
  h.redo();
  assert.deepEqual(snapshot(m), after);
});

test('placing, removing, scattering and clearing can all be undone, ids included', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  const a = m.addObject({ kind: 'tree:oak', x: 5, z: 5, seed: 1 });
  h.begin('scatter');
  for (let k = 0; k < 10; k++) m.addObject({ kind: 'rock:boulder', x: k * 7, z: -k * 3, seed: k });
  h.end();
  m.removeObject(a.id);
  m.paintTileList([[-5, -5], [-6, -5]], 'water');
  const full = snapshot(m);
  m.clear();
  assert.equal(m.editedChunks, 0);
  h.undo();
  assert.deepEqual(snapshot(m), full, 'clearmap undone: paint and objects back');
  h.undo(); // water
  h.undo(); // the removal
  assert.ok(m.object(a.id), 'the removed oak is back with its id');
  h.undo(); // the scatter, all ten at once
  assert.equal(m.objectCount, 1);
  h.undo();
  assert.equal(m.objectCount, 0);
  assert.equal(h.canUndo, false);
  for (let k = 0; k < 4; k++) h.redo();
  assert.deepEqual(snapshot(m), full, 'redo four: everything back, just before the clear');
  h.redo();
  assert.equal(m.editedChunks, 0, 'the fifth redo clears it again');
  assert.equal(h.canRedo, false);
  const next = m.addObject({ kind: 'tree:oak', x: 1, z: 1 });
  assert.ok(next.id > 11, 'new ids never reuse an undone id');
});

test('a new action after an undo drops what could have been redone', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  m.paintTileList([[0, 0]], 'grass');
  m.paintTileList([[1, 1]], 'sand');
  h.undo();
  assert.equal(h.canRedo, true);
  m.paintTileList([[2, 2]], 'rock');
  assert.equal(h.canRedo, false);
  assert.deepEqual(h.list().undo.length, 2);
});

test('undoing does not record new edits; empty groups leave no action; groups nest', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  h.begin('nothing');
  h.end();
  assert.equal(h.canUndo, false, 'an empty group is not an action');
  h.begin('outer');
  m.paintTileList([[0, 0]], 'grass');
  h.begin('inner');
  m.paintTileList([[1, 0]], 'grass');
  h.end();
  m.paintTileList([[2, 0]], 'grass');
  h.end();
  assert.deepEqual(h.list().undo, ['outer'], 'nested groups make one action');
  h.undo();
  assert.equal(h.canUndo, false, 'the undo itself was not recorded');
  assert.equal(h.list().redo[0], 'outer');
});

test('the history forgets the oldest actions past its limits', () => {
  const m = new MapData(info());
  const h = mapHistory(m, { maxActions: 3 });
  for (let k = 0; k < 5; k++) m.paintTileList([[k, 0]], 'grass');
  assert.equal(h.list().undo.length, 3);
  const m2 = new MapData(info());
  const h2 = mapHistory(m2, { maxSize: 10 });
  m2.paintTileList(Array.from({ length: 6 }, (_, k) => [k, 0] as [number, number]), 'grass');
  m2.paintTileList(Array.from({ length: 6 }, (_, k) => [k, 1] as [number, number]), 'grass');
  assert.equal(h2.list().undo.length, 1, '12 tiles > 10: the older action is dropped');
});

test('labels say what an action did', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  m.addObject({ kind: 'tree:oak', x: 0, z: 0 });
  m.paintTileList([[0, 0], [1, 0], [2, 0]], 'sand');
  assert.deepEqual(h.list().undo, ['place tree:oak', '3 tiles']);
  const g = new History<number>({ undo() {}, redo() {} });
  g.record(1);
  assert.deepEqual(g.list().undo, ['edit']);
});
