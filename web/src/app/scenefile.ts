// The scene file: what a saved scene holds, as JSON. A recipe, not glyphs:
// the canvas seed and time of day, the weather, the camera, the paint of the
// chunks that hold any (run-length coded, base64), and the placed objects.
// Ground paints are stored by name, so files keep working if paints are
// added or reordered later. `version` says how to read the rest: a newer
// file than this code understands is refused with a clear message.
//
// No runtime imports, so it can be unit-tested with node --test.

export const SCENE_FORMAT = 'ascii-sandbox-scene';
export const SCENE_VERSION = 1;

export interface SceneObject {
  id: number;
  kind: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  seed: number;
}

export interface SceneFile {
  format: typeof SCENE_FORMAT;
  version: number;
  name: string;
  /** When it was saved (ISO 8601). */
  saved: string;
  canvas: { seed: number; day: boolean };
  weather: { wind: number; rain: number; leaves: number };
  camera?: { position: [number, number, number]; target: [number, number, number] };
  /** Chunk side (m) and tiles per side the paint was saved with. */
  chunkSize: number;
  tiles: number;
  /** Ground paint names; the tile bytes index into this list. */
  grounds: string[];
  chunks: { cx: number; cz: number; tiles: string }[];
  objects: SceneObject[];
}

/** A file that can't be read; the message says why, for the user. */
export class SceneError extends Error {}

// ---- tile coding: run-length pairs (count 1-255, value), then base64 ----------

export function encodeTiles(t: Uint8Array): string {
  const out: number[] = [];
  for (let i = 0; i < t.length;) {
    const v = t[i]!;
    let n = 1;
    while (i + n < t.length && t[i + n] === v && n < 255) n++;
    out.push(n, v);
    i += n;
  }
  let bin = '';
  for (const b of out) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeTiles(s: string, length: number): Uint8Array {
  let bin: string;
  try {
    bin = atob(s);
  } catch {
    throw new SceneError('a chunk\'s paint is not valid base64');
  }
  if (bin.length % 2) throw new SceneError('a chunk\'s paint is cut short');
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i < bin.length; i += 2) {
    const n = bin.charCodeAt(i), v = bin.charCodeAt(i + 1);
    if (n === 0 || at + n > length) throw new SceneError('a chunk\'s paint has the wrong size');
    out.fill(v, at, at + n);
    at += n;
  }
  if (at !== length) throw new SceneError('a chunk\'s paint has the wrong size');
  return out;
}

// ---- building and reading -----------------------------------------------------

export interface SceneContent {
  canvas: SceneFile['canvas'];
  weather: SceneFile['weather'];
  camera?: SceneFile['camera'];
  chunkSize: number;
  tiles: number;
  grounds: string[];
  chunks: { cx: number; cz: number; tiles: Uint8Array }[];
  objects: SceneObject[];
}

export function buildScene(name: string, c: SceneContent, saved = new Date()): SceneFile {
  return {
    format: SCENE_FORMAT,
    version: SCENE_VERSION,
    name,
    saved: saved.toISOString(),
    canvas: { ...c.canvas },
    weather: { ...c.weather },
    ...(c.camera ? { camera: { position: [...c.camera.position], target: [...c.camera.target] } } : {}),
    chunkSize: c.chunkSize,
    tiles: c.tiles,
    grounds: [...c.grounds],
    chunks: c.chunks.map((k) => ({ cx: k.cx, cz: k.cz, tiles: encodeTiles(k.tiles) })),
    objects: c.objects.map((o) => ({ id: o.id, kind: o.kind, x: o.x, z: o.z, yaw: o.yaw, scale: o.scale, seed: o.seed })),
  };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);

/**
 * Read a scene file (already JSON-parsed): check everything, decode the
 * paint. Throws SceneError with a message meant for the user.
 */
export function parseScene(raw: unknown): SceneContent & { name: string; saved: string; version: number } {
  if (!raw || typeof raw !== 'object') throw new SceneError('not a scene file');
  const f = raw as Partial<SceneFile>;
  if (f.format !== SCENE_FORMAT) throw new SceneError('not an ASCII Sandbox scene file');
  if (!isInt(f.version) || f.version < 1) throw new SceneError('the file has no valid version');
  if (f.version > SCENE_VERSION) throw new SceneError(`the file is from a newer version (${f.version}); this one reads up to ${SCENE_VERSION}`);
  if (!isInt(f.tiles) || f.tiles < 1 || f.tiles > 1024 || !isNum(f.chunkSize)) throw new SceneError('the file has no valid chunk size');
  if (!Array.isArray(f.grounds) || !f.grounds.every((g) => typeof g === 'string')) throw new SceneError('the file has no ground list');
  if (!Array.isArray(f.chunks) || !Array.isArray(f.objects)) throw new SceneError('the file has no chunks or objects');
  const c = f.canvas, w = f.weather;
  if (!c || !isInt(c.seed) || typeof c.day !== 'boolean') throw new SceneError('the file has no valid canvas settings');
  if (!w || !isNum(w.wind) || !isNum(w.rain) || !isNum(w.leaves)) throw new SceneError('the file has no valid weather');
  const n = f.tiles;
  const chunks = f.chunks.map((k, i) => {
    if (!k || !isInt(k.cx) || !isInt(k.cz) || typeof k.tiles !== 'string') throw new SceneError(`chunk ${i} is broken`);
    const tiles = decodeTiles(k.tiles, n * n);
    for (const v of tiles) if (v >= f.grounds!.length) throw new SceneError(`chunk ${k.cx},${k.cz} uses a paint the file doesn't name`);
    return { cx: k.cx, cz: k.cz, tiles };
  });
  const objects = f.objects.map((o, i) => {
    if (!o || typeof o.kind !== 'string' || !isNum(o.x) || !isNum(o.z) || !isNum(o.yaw) || !isNum(o.scale) || !isInt(o.seed) || !isInt(o.id)) {
      throw new SceneError(`object ${i} is broken`);
    }
    return { id: o.id, kind: o.kind, x: o.x, z: o.z, yaw: o.yaw, scale: o.scale, seed: o.seed };
  });
  const cam = f.camera;
  const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(isNum);
  return {
    name: typeof f.name === 'string' ? f.name : 'scene',
    saved: typeof f.saved === 'string' ? f.saved : '',
    version: f.version,
    canvas: { seed: c.seed, day: c.day },
    weather: { wind: w.wind, rain: w.rain, leaves: w.leaves },
    ...(cam && vec(cam.position) && vec(cam.target) ? { camera: { position: cam.position, target: cam.target } } : {}),
    chunkSize: f.chunkSize,
    tiles: n,
    grounds: f.grounds,
    chunks,
    objects,
  };
}

/**
 * Tile codes from the file's ground list to this app's. Only paints the
 * chunks really use must exist here; one that doesn't is refused by name.
 */
export function remapGrounds(chunks: SceneContent['chunks'], from: readonly string[], to: readonly string[]): SceneContent['chunks'] {
  const used = new Set<number>();
  for (const k of chunks) for (const v of k.tiles) used.add(v);
  const map = from.map((g, code) => {
    const i = to.indexOf(g);
    if (i < 0 && used.has(code)) throw new SceneError(`the file uses a paint this version doesn't have: ${g}`);
    return Math.max(0, i);
  });
  return chunks.map((k) => ({ cx: k.cx, cz: k.cz, tiles: k.tiles.map((v) => map[v]!) }));
}
