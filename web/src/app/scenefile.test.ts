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
    chunkSize: 32, tiles: 64, grounds: GROUNDS, heightPoints: 33, chunks: d.chunks, objects: d.objects,
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

test('object parameters are saved by name, only those off their default', async () => {
  const { paramsByName, paramsFromNames } = await import('./scenefile.ts');
  const descs = [{ name: 'height', default: 1 }, { name: 'leaves', default: 3 }, { name: 'lean', default: 0.1 }];
  assert.equal(paramsByName([1, 3, 0.1], descs), undefined, 'all defaults: nothing saved');
  assert.deepEqual(paramsByName([2, 3, 0.1], descs), { height: 2 });
  assert.deepEqual(paramsFromNames({ height: 2 }, descs), [2, 3, 0.1]);
  // A newer app with a parameter inserted before "leaves" still reads it right.
  const newer = [{ name: 'height', default: 1 }, { name: 'crown', default: 1 }, { name: 'leaves', default: 3 }, { name: 'lean', default: 0.1 }];
  assert.deepEqual(paramsFromNames({ height: 2, leaves: 5 }, newer), [2, 1, 5, 0.1]);
  assert.equal(paramsFromNames({ gone: 4 }, newer), undefined, 'unknown names are ignored');
  // Through a whole file.
  const f = JSON.parse(JSON.stringify(buildScene('p', {
    canvas: { seed: 1, day: false }, weather: { wind: 0, rain: 0, leaves: 0 }, chunkSize: 32, tiles: 64, grounds: GROUNDS, chunks: [],
    objects: [{ id: 1, kind: 'tree:oak', x: 0, z: 0, yaw: 0, scale: 1, seed: 1, params: { height: 2 } }],
  })));
  assert.deepEqual(parseScene(f).objects[0]!.params, { height: 2 });
  assert.throws(() => parseScene({ ...f, objects: [{ ...f.objects[0], params: { height: 'x' } }] }), /broken parameters/);
});

test('version 2: ground heights round-trip through a file (centimetres), alone or with paint', async () => {
  const { heightDab } = await import('./heightbrush.ts');
  const a = new MapData(info());
  a.setHeights(heightDab(40, -20, { radius: 6, mode: 'raise', strength: 3.21 }, (i, j) => a.pointHeight(i, j)));
  a.paintTileList([[0, 0]], 'grass');
  const f = JSON.parse(JSON.stringify(scene(a)));
  assert.equal(f.version, 2);
  assert.ok(f.chunks.some((k: { heights?: string; tiles?: string }) => k.heights && !k.tiles), 'a chunk with only heights stores no paint');
  const read = parseScene(f);
  const b = new MapData(info());
  b.replaceWith(remapGrounds(read.chunks, read.grounds, GROUNDS), read.objects);
  for (const [x, z] of [[40, -20], [43.3, -18.7], [35, -25]]) assert.ok(Math.abs(b.heightAt(x!, z!) - a.heightAt(x!, z!)) < 0.006, `same height at ${x},${z} (to the centimetre)`);
  assert.equal(b.groundAt(0.2, 0.2), 'grass');
});

test('version 1 files (paint only) still load', () => {
  const v1 = {
    format: 'ascii-sandbox-scene', version: 1, name: 'old', saved: '2026-11-20T00:00:00Z',
    canvas: { seed: 3, day: false }, weather: { wind: 0.3, rain: 0, leaves: 0.5 },
    chunkSize: 32, tiles: 64, grounds: GROUNDS,
    chunks: [{ cx: 0, cz: 0, tiles: encodeTiles(new Uint8Array(4096).fill(2)) }],
    objects: [{ id: 1, kind: 'tree:oak', x: 1, z: 1, yaw: 0, scale: 1, seed: 1 }],
  };
  const read = parseScene(v1);
  assert.equal(read.chunks[0]!.heights, null);
  assert.equal(read.heightPoints, 33);
  const m = new MapData(info());
  m.replaceWith(remapGrounds(read.chunks, read.grounds, GROUNDS), read.objects);
  assert.equal(m.groundAt(5, 5), 'sand');
  assert.throws(() => parseScene({ ...v1, chunks: [{ cx: 0, cz: 0 }] }), /chunk 0 is broken/, 'a version 1 chunk needs its paint');
});
