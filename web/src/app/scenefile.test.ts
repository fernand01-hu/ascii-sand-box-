// Unit tests for the scene file and a save -> load round trip:
// `npm run test:unit` (node --test runs this TypeScript directly).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapHistory } from './history.ts';
import { MapData } from './map.ts';
import { buildScene, decodeTiles, encodeTiles, parseScene, remapGrounds, SCENE_VERSION, SceneError } from './scenefile.ts';

const GROUNDS = ['canvas', 'grass', 'sand', 'water', 'rock'];
const info = () => ({ chunkSize: 32, tile: 0.5, tiles: 64, groundKinds: GROUNDS, objectKinds: ['tree:oak', 'rock:boulder'] });

function snapshot(m: MapData) {
  const d = m.exportData();
  return {
    chunks: d.chunks.map((c) => ({ cx: c.cx, cz: c.cz, tiles: Array.from(c.tiles) })).sort((a, b) => a.cx - b.cx || a.cz - b.cz),
    objects: d.objects.sort((a, b) => a.id - b.id),
  };
}

function scene(m: MapData) {
  const d = m.exportData();
  return buildScene('test', {
    canvas: { seed: 7, day: true }, weather: { wind: 0.4, rain: 0, leaves: 0.5 },
    camera: { position: [1, 2, 3], target: [4, 5, 6] },
    chunkSize: 32, tiles: 64, grounds: GROUNDS, chunks: d.chunks, objects: d.objects,
  });
}

test('tile coding round-trips: empty, uniform, noisy, long runs', () => {
  const cases = [new Uint8Array(4096), new Uint8Array(4096).fill(3), Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) % 5), Uint8Array.from({ length: 4096 }, (_, i) => (i < 1000 ? 1 : i < 3000 ? 2 : 0))];
  for (const t of cases) assert.deepEqual(decodeTiles(encodeTiles(t), 4096), t);
  assert.ok(encodeTiles(new Uint8Array(4096).fill(1)).length < 60, 'a uniform chunk codes small');
  assert.throws(() => decodeTiles(encodeTiles(new Uint8Array(10)), 4096), SceneError);
  assert.throws(() => decodeTiles('***', 4096), SceneError);
});

test('save -> JSON -> load gives back the same map, settings and camera', () => {
  const a = new MapData(info());
  a.paintTileList([[0, 0], [1, 0], [70, -3], [-5, -5]], 'sand');
  a.paintTileList([[2, 2]], 'water');
  a.addObject({ kind: 'tree:oak', x: 4, z: -28, seed: 3, yaw: 1.5, scale: 1.2 });
  a.addObject({ kind: 'rock:boulder', x: -40, z: 70, seed: 9 });
  const text = JSON.stringify(scene(a));
  const read = parseScene(JSON.parse(text));
  assert.equal(read.version, SCENE_VERSION);
  assert.deepEqual(read.canvas, { seed: 7, day: true });
  assert.deepEqual(read.weather, { wind: 0.4, rain: 0, leaves: 0.5 });
  assert.deepEqual(read.camera, { position: [1, 2, 3], target: [4, 5, 6] });
  const b = new MapData(info());
  b.replaceWith(remapGrounds(read.chunks, read.grounds, GROUNDS), read.objects);
  assert.deepEqual(snapshot(b), snapshot(a));
  assert.equal(b.groundAt(0.7, 0.2), 'sand'); // tile 1, 0
  assert.equal(b.groundAt(1.2, 1.2), 'water'); // tile 2, 2
  assert.equal(b.object(1)?.kind, 'tree:oak');
});

test('only chunks holding paint are stored', () => {
  const a = new MapData(info());
  a.paintTileList([[0, 0]], 'grass');
  a.addObject({ kind: 'tree:oak', x: 500, z: 500 }); // an object alone in a far chunk
  const f = scene(a);
  assert.equal(f.chunks.length, 1);
  assert.equal(f.objects.length, 1);
});

test('paints are matched by name, so a file still loads if the list changed', () => {
  const a = new MapData(info());
  a.paintTileList([[0, 0]], 'water');
  const f = JSON.parse(JSON.stringify(scene(a)));
  // A future app with a new paint inserted before water:
  const newer = ['canvas', 'grass', 'snow', 'sand', 'water', 'rock'];
  const read = parseScene(f);
  const tiles = remapGrounds(read.chunks, read.grounds, newer)[0]!.tiles;
  assert.equal(newer[tiles[0]!], 'water');
  assert.throws(() => remapGrounds(read.chunks, read.grounds, ['canvas', 'grass']), /doesn't have: water/, 'a used paint must exist');
  assert.doesNotThrow(() => remapGrounds(read.chunks, read.grounds, ['canvas', 'water']), 'unused paints (sand, rock) may be missing');
});

test('broken or newer files are refused with a message', () => {
  const ok = JSON.parse(JSON.stringify(scene(new MapData(info()))));
  assert.throws(() => parseScene(null), /not a scene file/);
  assert.throws(() => parseScene({ ...ok, format: 'other' }), /not an ASCII Sandbox scene/);
  assert.throws(() => parseScene({ ...ok, version: SCENE_VERSION + 1 }), /newer version/);
  assert.throws(() => parseScene({ ...ok, weather: { wind: 'x' } }), /weather/);
  assert.throws(() => parseScene({ ...ok, objects: [{ kind: 'tree:oak' }] }), /object 0 is broken/);
  assert.throws(() => parseScene({ ...ok, chunks: [{ cx: 0, cz: 0, tiles: encodeTiles(new Uint8Array(4096).fill(9)) }] }), /paint the file doesn't name/);
  assert.doesNotThrow(() => parseScene({ ...ok, camera: undefined }), 'the camera is optional');
});

test('loading is one undoable change', () => {
  const m = new MapData(info());
  const h = mapHistory(m);
  m.paintTileList([[3, 3]], 'rock');
  m.addObject({ kind: 'tree:oak', x: 1, z: 1 });
  const before = snapshot(m);
  const other = new MapData(info());
  other.paintTileList([[0, 0]], 'grass');
  other.addObject({ kind: 'rock:boulder', x: 9, z: 9 });
  const read = parseScene(JSON.parse(JSON.stringify(scene(other))));
  h.begin('load');
  m.replaceWith(read.chunks, read.objects);
  h.end();
  assert.deepEqual(snapshot(m), snapshot(other));
  h.undo();
  assert.deepEqual(snapshot(m), before, 'undo brings back what was there before loading');
});
