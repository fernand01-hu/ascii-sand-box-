//! Glyph atlas geometry, shared by the card generator (which sizes cards with
//! the cell aspect) and the renderer (which rasterizes the atlas).
//! Mirrors `web/src/render/atlas.ts`.

/// Glyph height in atlas pixels.
pub const GLYPH_HEIGHT: u32 = 128;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellSize {
    pub pad: u32,
    pub w: u32,
    pub h: u32,
}

pub fn cell_size(glyph_height: u32) -> CellSize {
    let gh = glyph_height as f64;
    let pad = (gh * 0.1).ceil() as u32;
    // JS Math.round: halves go up.
    let w = (gh * 0.6 + 0.5).floor() as u32 + 2 * pad;
    CellSize { pad, w, h: glyph_height + 2 * pad }
}

/// Width / height of an atlas cell.
pub fn glyph_aspect(glyph_height: u32) -> f32 {
    let c = cell_size(glyph_height);
    (c.w as f64 / c.h as f64) as f32
}

/// Atlas grid (columns, rows) for `n` characters.
pub fn grid_for(n: usize) -> (u32, u32) {
    let cols = (n as f64).sqrt().ceil() as u32;
    let rows = (n as u32).div_ceil(cols);
    (cols, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_web_atlas() {
        assert_eq!(cell_size(128), CellSize { pad: 13, w: 103, h: 154 });
        assert_eq!(grid_for(16), (4, 4));
        assert_eq!(grid_for(97), (10, 10));
    }
}
