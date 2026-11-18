// Messages between the main thread and the engine worker.

/** Card generation settings. Mirrors `CardConfig` in the Rust engine. */
export interface CardSettings {
  seed: number;
  count: number;
  /** Card height relative to the average spacing between cards (>1 overlaps). */
  sizeFactor: number;
  glyphCount: number;
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
  timings: { loadMs: number; generateMs: number };
}

export type WorkerRequest =
  | { kind: 'load'; id: number; bytes: ArrayBuffer; zUp: boolean; settings: CardSettings }
  | { kind: 'generate'; id: number; settings: CardSettings };

export type WorkerResponse =
  | ({ kind: 'result'; id: number } & EngineResult)
  | { kind: 'error'; id: number; message: string; fatal: boolean };
