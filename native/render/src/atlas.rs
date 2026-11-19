//! Glyph atlas rasterized on the CPU: same layout as `web/src/render/atlas.ts`
//! (cell = 0.6 x height + 2 x 10% padding, near-square grid, bold monospace,
//! glyphs centred on the cell), with a full mip chain.

use ascii_core::glyphs::{cell_size, grid_for, GLYPH_HEIGHT};

static FONT: &[u8] = include_bytes!("../assets/DejaVuSansMono-Bold.ttf");

pub struct AtlasImage {
    pub cols: u32,
    pub rows: u32,
    pub cell_w: u32,
    pub cell_h: u32,
    pub width: u32,
    pub height: u32,
    /// One alpha-coverage image per mip level, largest first.
    pub mips: Vec<(u32, u32, Vec<u8>)>,
}

impl AtlasImage {
    /// Half-texel inset of a cell, as a fraction of the cell.
    pub fn inset(&self) -> [f32; 2] {
        [0.5 / self.cell_w as f32, 0.5 / self.cell_h as f32]
    }
}

pub fn build_atlas(charset: &str) -> Result<AtlasImage, String> {
    let chars: Vec<char> = charset.chars().collect();
    if chars.is_empty() {
        return Err("glyph atlas needs at least one character".into());
    }
    let cell = cell_size(GLYPH_HEIGHT);
    let (cols, rows) = grid_for(chars.len());
    let (width, height) = (cols * cell.w, rows * cell.h);
    let font = fontdue::Font::from_bytes(FONT, fontdue::FontSettings::default()).map_err(|e| e.to_string())?;
    let px = (f64::from(GLYPH_HEIGHT) * 0.82).round() as f32;
    let lm = font.horizontal_line_metrics(px).ok_or("font has no line metrics")?;
    let mut img = vec![0u8; (width * height) as usize];
    for (i, &c) in chars.iter().enumerate() {
        let (m, bitmap) = font.rasterize(c, px);
        let cx = (i as u32 % cols) as f32 * cell.w as f32 + cell.w as f32 / 2.0;
        let cy = (i as u32 / cols) as f32 * cell.h as f32 + cell.h as f32 / 2.0;
        // textAlign center, textBaseline middle (middle of the em box).
        let left = (cx - m.advance_width / 2.0 + m.xmin as f32).round() as i64;
        let baseline = cy + (lm.ascent + lm.descent) / 2.0;
        let top = (baseline - (m.ymin as f32 + m.height as f32)).round() as i64;
        for y in 0..m.height {
            for x in 0..m.width {
                let (dx, dy) = (left + x as i64, top + y as i64);
                if dx < 0 || dy < 0 || dx >= i64::from(width) || dy >= i64::from(height) {
                    continue;
                }
                let v = bitmap[y * m.width + x];
                let o = (dy as u32 * width + dx as u32) as usize;
                img[o] = img[o].max(v);
            }
        }
    }
    let mut mips = vec![(width, height, img)];
    while mips.last().map(|m| (m.0, m.1)) != Some((1, 1)) {
        let (w, h, src) = mips.last().expect("non-empty");
        let (nw, nh) = ((*w / 2).max(1), (*h / 2).max(1));
        let mut dst = vec![0u8; (nw * nh) as usize];
        for y in 0..nh {
            for x in 0..nw {
                let at = |xx: u32, yy: u32| u32::from(src[(yy.min(h - 1) * w + xx.min(w - 1)) as usize]);
                let (x2, y2) = (x * 2, y * 2);
                dst[(y * nw + x) as usize] = ((at(x2, y2) + at(x2 + 1, y2) + at(x2, y2 + 1) + at(x2 + 1, y2 + 1) + 2) / 4) as u8;
            }
        }
        mips.push((nw, nh, dst));
    }
    Ok(AtlasImage { cols, rows, cell_w: cell.w, cell_h: cell.h, width, height, mips })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atlas_layout_and_ink() {
        let a = build_atlas(":-=+*xoO#%&8@BMW").unwrap();
        assert_eq!((a.cols, a.rows, a.width, a.height), (4, 4, 412, 616));
        assert_eq!(a.mips.last().map(|m| (m.0, m.1)), Some((1, 1)));
        // Every cell has ink, and none touches the cell's padding edge.
        let base = &a.mips[0].2;
        for i in 0..16u32 {
            let (cx, cy) = ((i % 4) * a.cell_w, (i / 4) * a.cell_h);
            let mut ink = 0u32;
            for y in 0..a.cell_h {
                for x in 0..a.cell_w {
                    let v = base[((cy + y) * a.width + cx + x) as usize];
                    if v > 0 {
                        ink += 1;
                        assert!(x > 0 && y > 0 && x < a.cell_w - 1 && y < a.cell_h - 1, "glyph {i} touches the cell edge");
                    }
                }
            }
            assert!(ink > 100, "glyph {i} is empty");
        }
    }
}
