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
}

/** Test scenes, only available in dev/test builds (see web/src/testbed). */
export interface TestbedRequest {
  scene: 'pine';
  seed: number;
  glyphAspect: number;
}

export type WorkerRequest =
  | { kind: 'load'; id: number; bytes: ArrayBuffer; zUp: boolean; settings: CardSettings }
  | { kind: 'generate'; id: number; settings: CardSettings }
  | ({ kind: 'testbed'; id: number } & TestbedRequest);

export type WorkerResponse =
  | ({ kind: 'result'; id: number } & EngineResult)
  | { kind: 'error'; id: number; message: string; fatal: boolean }
  /** A newer request made this one pointless, so it was never run. */
  | { kind: 'skipped'; id: number };
