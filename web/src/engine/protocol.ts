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
  /** Landscapes: terrain, water and colliders for the player physics. */
  walk?: WalkData;
  /** Infinite world: setup (after worldInit) or one streamed chunk. */
  world?: WorldInfo;
  chunk?: WorldChunkData;
  /** Render chunks (see engine/chunks.ts): CHUNK_FLOATS per chunk. */
  chunks?: Float32Array;
}

export interface WalkData {
  heights: Float32Array;
  n: number;
  size: number;
  water: number | null;
  waterMask: Uint8Array;
  /** x, z, radius, top y per collider. */
  colliders: Float32Array;
}

export interface WorldInfo {
  chunkSize: number;
  grid: number;
  water: number;
  /** A dry place to start, and its ground height. */
  spawn: [number, number, number];
}

export interface WorldChunkData {
  cx: number;
  cz: number;
  /** Eye the glyph sizes were chosen for. */
  eye: [number, number, number];
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

export type ScenePreset = 'meadow' | 'forest' | 'lake' | 'valley' | 'alpine';
export const SCENE_PRESETS: ScenePreset[] = ['meadow', 'forest', 'lake', 'valley', 'alpine'];

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
  | { kind: 'scene'; id: number; preset: ScenePreset; seed: number; glyphAspect: number }
  | { kind: 'worldInit'; id: number; seed: number; day: boolean; glyphAspect: number }
  | { kind: 'worldChunk'; id: number; cx: number; cz: number; eye: [number, number, number]; glyphAspect: number };

export type WorkerResponse =
  | ({ kind: 'result'; id: number } & EngineResult)
  | { kind: 'error'; id: number; message: string; fatal: boolean }
  /** A newer request made this one pointless, so it was never run. */
  | { kind: 'skipped'; id: number };
