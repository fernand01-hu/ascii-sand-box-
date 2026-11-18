// Draws every character once into a single texture. Each card samples its
// glyph from this atlas, so all cards render in one draw call.

import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace } from 'three';

export interface GlyphAtlas {
  texture: CanvasTexture;
  chars: string[];
  cols: number;
  rows: number;
  /** Cell width / height. Cards use the same ratio so glyphs aren't stretched. */
  aspect: number;
  /** Padding inside each cell as a fraction of the cell (keeps mipmaps from bleeding). */
  inset: [number, number];
  dispose(): void;
}

const FONT_STACK = '"DejaVu Sans Mono", Menlo, Consolas, "Liberation Mono", monospace';

export const GLYPH_HEIGHT = 128;

function cellSize(glyphHeight: number): { pad: number; cellW: number; cellH: number } {
  const pad = Math.ceil(glyphHeight * 0.1);
  return { pad, cellW: Math.round(glyphHeight * 0.6) + 2 * pad, cellH: glyphHeight + 2 * pad };
}

/** Width / height of an atlas cell; the engine sizes cards with it. */
export function glyphAspect(glyphHeight = GLYPH_HEIGHT): number {
  const { cellW, cellH } = cellSize(glyphHeight);
  return cellW / cellH;
}

/**
 * Build the atlas from a charset the engine has already normalized (the
 * engine is the single source of truth for which index is which character).
 */
export function createGlyphAtlas(charset: string, glyphHeight = GLYPH_HEIGHT): GlyphAtlas {
  const chars = Array.from(charset);
  if (chars.length === 0) throw new Error('glyph atlas needs at least one character');
  if (new Set(chars).size !== chars.length || chars.some((c) => c.trim() === '')) {
    throw new Error('charset must be normalized by the engine (unique, visible characters)');
  }

  const { cellW, cellH } = cellSize(glyphHeight);
  const cols = Math.ceil(Math.sqrt(chars.length));
  const rows = Math.ceil(chars.length / cols);

  const canvas = document.createElement('canvas');
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('2D canvas is not available');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(glyphHeight * 0.82)}px ${FONT_STACK}`;
  chars.forEach((c, i) => {
    const x = (i % cols) * cellW + cellW / 2;
    const y = Math.floor(i / cols) * cellH + cellH / 2;
    g.fillText(c, x, y);
  });

  const texture = new CanvasTexture(canvas);
  texture.flipY = false; // row 0 of the canvas is row 0 of the atlas
  texture.colorSpace = NoColorSpace; // only the alpha channel is used
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  return {
    texture,
    chars,
    cols,
    rows,
    aspect: cellW / cellH,
    inset: [0.5 / cellW, 0.5 / cellH],
    dispose: () => texture.dispose(),
  };
}
