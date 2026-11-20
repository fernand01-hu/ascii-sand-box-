// Messages between the main thread and the engine worker.

export type GlyphRule = 'random' | 'cells' | 'noise';
export const GLYPH_RULES: Record<GlyphRule, number> = { random: 0, cells: 1, noise: 2 };

/** Card generation settings. Mirrors `CardConfig` in the Rust engine. */
export interface CardSettings {
  seed: number;
  /** Card height in normalized model units (the model's largest dimension is 2). */
  glyphSize: number;
  /** Card height relative to the average spacing between cards (>1 overlaps). */
  sizeFactor: number;
  /** Characters ordered light to dense; the engine normalizes it. */
  charset: string;
  glyphRule: GlyphRule;
  /** Size of the rule's pattern features, in normalized model units. */
  patternScale: number;
  glyphAspect: number;
  /** Albedo, 0..1 per channel. */
  color: [number, number, number];
  colorJitter: number;
  twist: number;
  tilt: number;
  alphaMin: number;
  alphaMax: number;
}

export interface MeshPayload {
  /** Normalized, Y-up, non-indexed xyz positions (9 floats per triangle). */
  positions: Float32Array;
  normals: Float32Array;
  triangles: number;
  /** Input triangles discarded as degenerate or non-finite. */
  dropped: number;
}

export interface EngineResult {
  /** Present only after a `load`. */
  mesh: MeshPayload | null;
  cards: Float32Array;
  stride: number;
  count: number;
  /** The characters the glyph indices refer to, as normalized by the engine. */
  charset: string;
  timings: { loadMs: number; generateMs: number };
  /** Scenes with baked shadows: the sun direction they were baked with. */
  sunDir?: [number, number, number];
  /** Procedural scenes: suggested camera (vertical fov in degrees). */
  camera?: { target: [number, number, number]; eye: [number, number, number]; fov: number };
  /** Procedural scenes: shader material table, `materialFloats` per material id. */
  materials?: Float32Array;
  materialFloats?: number;
  /** Procedural scenes: time of day, wind direction, particle boxes. */
  env?: SceneEnv;
  /** The canvas world: setup (after worldInit) or one streamed chunk. */
  world?: WorldInfo;
  chunk?: WorldChunkData;
  /** Render chunks (see engine/chunks.ts): CHUNK_FLOATS per chunk. */
  chunks?: Float32Array;
}

export interface WorldInfo {
  chunkSize: number;
  grid: number;
  /** Height of the flat canvas. */
  ground: number;
  /** Where the camera starts, on the ground. */
  spawn: [number, number, number];
  /** Ground tile side (m) and tiles per chunk side. */
  tile: number;
  tiles: number;
  /** Ground paints (index = tile byte) and object kinds (index = kind code). */
  groundKinds: string[];
  objectKinds: string[];
  /** Material names by material id (glyph inspector). */
  materialNames: string[];
  /** Generator parameters per object kind, in kind-code order. */
  objectParams: ParamDesc[][];
  /** Floats per placed object in chunk requests (6 + the parameter slots). */
  objectFloats: number;
}

/** One generator parameter of an object kind (from the engine). */
export interface ParamDesc {
  name: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}

export interface WorldChunkData {
  cx: number;
  cz: number;
  /** Eye the glyph sizes were chosen for. */
  eye: [number, number, number];
  /** Revision of the chunk's map data this was built from. */
  rev: number;
  /** Objects drawn. */
  placed: number;
  /** Per object drawn: record index, then its world box (min xyz, max xyz). */
  bounds: Float32Array;
  /** (grid + 1)^2 heights, 1 m apart, from the chunk corner. */
  heights: Float32Array;
  /** x, z, radius, top y per collider. */
  colliders: Float32Array;
}

export interface SceneEnv {
  day: boolean;
  windDir: [number, number];
  /** Blown leaves: min x, min z, size. */
  leafBox: [number, number, number];
  /** Rain box sizes x, y, z (follows the camera). */
  rainBox: [number, number, number];
}

export type GalleryCategory = 'rocks' | 'plants' | 'bushes' | 'trees';
export const GALLERY_CATEGORIES: GalleryCategory[] = ['rocks', 'plants', 'bushes', 'trees'];

/** Test scenes, only available in dev/test builds (see web/src/testbed). */
export interface TestbedRequest {
  scene: 'pine';
  seed: number;
  glyphAspect: number;
}

export type WorkerRequest =
  | { kind: 'load'; id: number; bytes: ArrayBuffer; zUp: boolean; settings: CardSettings }
  | { kind: 'generate'; id: number; settings: CardSettings }
  | ({ kind: 'testbed'; id: number } & TestbedRequest)
  | { kind: 'gallery'; id: number; category: GalleryCategory; seed: number; glyphAspect: number }
  /** One object with parameter values, for the object brush's preview. */
  | { kind: 'preview'; id: number; kindCode: number; seed: number; params: Float32Array; glyphAspect: number; framePx: number }
  | { kind: 'worldInit'; id: number; seed: number; day: boolean; glyphAspect: number }
  /** Chunk workers: create the canvas world (seed) or free it (null). No reply. */
  | { kind: 'worldSetup'; id: number; seed: number | null; day: boolean }
  | {
    kind: 'worldChunk'; id: number; cx: number; cz: number; eye: [number, number, number]; glyphAspect: number;
    /** Finest ground rows reach this many times farther than the glyph rule (1 = plain). */
    nearDetail?: number;
    /** The chunk's map data (see app/map.ts): ground tiles or null, objects, revision. */
    tiles: Uint8Array | null; heights: Float32Array | null; objects: Float32Array; rev: number;
  };

export type WorkerResponse =
  | ({ kind: 'result'; id: number } & EngineResult)
  | { kind: 'error'; id: number; message: string; fatal: boolean }
  /** A newer request made this one pointless, so it was never run. */
  | { kind: 'skipped'; id: number };
