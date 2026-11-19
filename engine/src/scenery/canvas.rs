//! The blank canvas: an endless flat map covered in neat, evenly spaced,
//! parallel rows of '#', built in square chunks. It is what you paint on.
//!
//! * Every '#' sits on one world-aligned grid, so rows run straight across
//!   chunk borders.
//! * Glyph size follows the usual rule (~15 px tall from the eye the chunk
//!   was built for), rounded up to `FINE` x a power of two. Each coarser
//!   level keeps every other row and column of the finer one, so distant
//!   ground shows bigger '#'s that still line up with the near ones.
//! * The sky dome, rain and blowing leaves don't depend on the ground: they
//!   come from `sky` exactly as before.

use super::sky::{self, Sky, DAY, DUSK};
use super::skin::{CardMode, Glyphs, Skinner, View};
use super::style::Mat;
use crate::math::Vec3;

/// Chunk side, metres.
pub const CHUNK: f32 = 32.0;
/// Physics heights per chunk: (GRID + 1)^2 samples, 1 m apart.
pub const GRID: usize = 32;
/// Height of the canvas everywhere.
pub const GROUND: f32 = 0.0;
/// Row spacing (m) right at the eye. Coarser levels double it.
pub const FINE: f32 = 0.25;
/// Row spacing (m) is never coarser than this.
pub const COARSE: f32 = 4.0;
/// The glyph size is chosen per square cell of this side (m).
const CELL: f32 = 4.0;
/// 50 degree field of view, 1000 px tall.
const FOCAL: f32 = 1072.0;

/// Row spacing (m) for ground at `p`: the glyph-size rule rounded up to
/// `FINE` x 2^k, at most `COARSE`.
pub fn spacing(view: &View, p: Vec3) -> f32 {
    let g = view.glyph_at(p);
    let mut s = FINE;
    while s < g && s < COARSE {
        s *= 2.0;
    }
    s
}

pub struct ChunkOut {
    pub cards: Vec<f32>,
    /// Opaque ground: hides whatever lies below the canvas.
    pub body: Vec<[Vec3; 3]>,
    /// (GRID + 1)^2 heights, 1 m apart, from the chunk corner.
    pub heights: Vec<f32>,
    /// x, z, radius, top y per collider (none on a blank canvas).
    pub colliders: Vec<[f32; 4]>,
}

/// The canvas: a seed for the sky, the time of day, and glyph pickers.
pub struct Canvas {
    pub seed: u32,
    pub day: bool,
    glyphs: Glyphs,
}

impl Canvas {
    pub fn new(seed: u32, day: bool) -> Canvas {
        Canvas { seed, day, glyphs: Glyphs::new() }
    }

    fn view(eye: Vec3) -> View {
        View { eye, focus: eye, focal: FOCAL, near: 5.0 }
    }

    /// Sky dome (centred on the camera by the shader), rain and blown leaves.
    pub fn sky_cards(&self, aspect: f32) -> Vec<f32> {
        let eye = Vec3::new(0.0, 2.0, 0.0);
        let view = Self::view(eye);
        let s = Sky::new(self.seed, if self.day { &DAY } else { &DUSK });
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, self.seed as u64);
        sky::sky_dome(&mut sk, &s, Vec3::ZERO, 900.0, &view, self.seed);
        sky::rain(&mut sk, 7000, self.seed);
        sky::drifting_leaves(&mut sk, 900, 90.0, &view, self.seed);
        sk.cards
    }

    /// Chunk (cx, cz) with glyphs sized for an eye at `eye`.
    pub fn build_chunk(&self, cx: i32, cz: i32, eye: Vec3, aspect: f32) -> ChunkOut {
        let (x0, z0) = (cx as f32 * CHUNK, cz as f32 * CHUNK);
        let view = Self::view(eye);
        let seed = self.seed as u64 ^ ((cx as u64) << 32) ^ (cz as u32 as u64);
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, seed);
        let def = Mat::Canvas.def();
        let glyph = sk.glyph(Mat::Canvas);
        let cells = (CHUNK / CELL) as usize;
        for cj in 0..cells {
            for ci in 0..cells {
                let (ax, az) = (x0 + ci as f32 * CELL, z0 + cj as f32 * CELL);
                let s = spacing(&view, Vec3::new(ax + CELL / 2.0, GROUND, az + CELL / 2.0));
                let sx = s * aspect;
                // Grid points whose centre falls inside this cell: (i + 0.5) * sx.
                let (i0, i1) = (((ax / sx) - 0.5).ceil() as i64, (((ax + CELL) / sx) - 0.5).ceil() as i64);
                let (j0, j1) = (((az / s) - 0.5).ceil() as i64, (((az + CELL) / s) - 0.5).ceil() as i64);
                for j in j0..j1 {
                    for i in i0..i1 {
                        let c = Vec3::new((i as f32 + 0.5) * sx, GROUND + 0.01 * s, (j as f32 + 0.5) * s);
                        // Flat on the ground (U x V = up), upright when seen from +z;
                        // the shader leans it toward the camera.
                        sk.push(c, Vec3::X * sx, Vec3::new(0.0, 0.0, -s), def.albedo, def.alpha.0, glyph, Mat::Canvas, CardMode::GroundLean);
                    }
                }
            }
        }
        let y = GROUND - 0.08;
        let (a, b) = (Vec3::new(x0, y, z0), Vec3::new(x0 + CHUNK, y, z0));
        let (c, d) = (Vec3::new(x0 + CHUNK, y, z0 + CHUNK), Vec3::new(x0, y, z0 + CHUNK));
        ChunkOut {
            cards: std::mem::take(&mut sk.cards),
            body: vec![[a, d, c], [a, c, b]],
            heights: vec![GROUND; (GRID + 1) * (GRID + 1)],
            colliders: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{layout, MATERIAL_SHIFT, STRIDE};
    use crate::scenery::skin::MAX_MATERIALS;

    const ASPECT: f32 = 0.64;

    fn eye() -> Vec3 {
        Vec3::new(16.0, 1.7, 16.0)
    }

    #[test]
    fn chunks_are_neat_rows_of_hash_on_flat_ground() {
        let canvas = Canvas::new(1, false);
        let c = canvas.build_chunk(0, 0, eye(), ASPECT);
        let n = c.cards.len() / STRIDE;
        assert!(n > 1000, "{n} cards");
        let hash = canvas.glyphs.charset.chars().position(|ch| ch == '#').unwrap() as u32;
        for card in c.cards.chunks_exact(STRIDE) {
            assert!(card.iter().all(|v| v.is_finite()));
            let slot = card[layout::GLYPH] as u32;
            let high = slot / MATERIAL_SHIFT;
            assert_eq!(slot % MATERIAL_SHIFT, hash, "only '#'");
            assert_eq!(high % MAX_MATERIALS, Mat::Canvas as u32);
            assert_eq!(high / MAX_MATERIALS, CardMode::GroundLean as u32);
            // On the grid for its own spacing, flat and axis-aligned.
            let s = -card[layout::V + 2];
            let sx = s * ASPECT;
            assert!((FINE..=COARSE).contains(&s));
            assert!((card[layout::U] - sx).abs() < 1e-6 && card[layout::U + 1] == 0.0 && card[layout::V + 1] == 0.0);
            let (fi, fj) = (card[0] / sx - 0.5, card[2] / s - 0.5);
            assert!((fi - fi.round()).abs() < 1e-3 && (fj - fj.round()).abs() < 1e-3, "off the grid at {} {}", card[0], card[2]);
            assert!((card[1] - GROUND).abs() < 0.05);
        }
        assert_eq!(c.heights.len(), (GRID + 1) * (GRID + 1));
        assert!(c.heights.iter().all(|&h| h == GROUND));
        assert!(c.colliders.is_empty());
        assert_eq!(c.body.len(), 2);
    }

    #[test]
    fn rows_continue_across_chunk_borders() {
        let canvas = Canvas::new(1, false);
        // Eye on the border, so both sides use the same spacing near it.
        let e = Vec3::new(32.0, 1.7, 16.0);
        let rows = |cx| {
            let c = canvas.build_chunk(cx, 0, e, ASPECT);
            let mut z: Vec<i64> = c.cards.chunks_exact(STRIDE).filter(|k| (k[0] - 32.0).abs() < 1.0).map(|k| (k[2] * 1000.0).round() as i64).collect();
            z.sort_unstable();
            z.dedup();
            z
        };
        let (a, b) = (rows(0), rows(1));
        assert!(!a.is_empty());
        assert_eq!(a, b, "the same rows on both sides of the border");
    }

    #[test]
    fn far_ground_uses_fewer_bigger_glyphs() {
        let canvas = Canvas::new(1, false);
        let near = canvas.build_chunk(0, 0, eye(), ASPECT).cards.len();
        let far = canvas.build_chunk(8, 0, eye(), ASPECT).cards.len();
        assert!(near > far * 8, "near {near}, far {far}");
        let v = Canvas::view(eye());
        assert_eq!(spacing(&v, eye()), FINE);
        assert_eq!(spacing(&v, Vec3::new(5000.0, 0.0, 0.0)), COARSE);
    }

    #[test]
    fn deterministic() {
        let canvas = Canvas::new(5, true);
        assert_eq!(canvas.build_chunk(-3, 2, eye(), ASPECT).cards, canvas.build_chunk(-3, 2, eye(), ASPECT).cards);
    }

    #[test]
    fn the_sky_and_weather_are_kept() {
        let cards = Canvas::new(1, false).sky_cards(ASPECT);
        let mut modes = [0usize; 9];
        for c in cards.chunks_exact(STRIDE) {
            modes[((c[layout::GLYPH] as u32 / MATERIAL_SHIFT) / MAX_MATERIALS) as usize] += 1;
        }
        assert!(modes[CardMode::Emissive as usize] > 20_000, "sky dome");
        assert_eq!(modes[CardMode::Rain as usize], 7000, "rain");
        assert_eq!(modes[CardMode::Drift as usize], 900, "blowing leaves");
    }
}
