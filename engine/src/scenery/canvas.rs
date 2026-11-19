//! The canvas: an endless flat map you paint on, built in square chunks.
//!
//! * Unpainted ground is neat, evenly spaced, parallel rows of '#'. Painted
//!   ground (grass, sand, water, rock) uses the same grid with that
//!   material's characters, so the map keeps its tidy terminal look.
//! * Every glyph sits on one world-aligned grid, so rows run straight across
//!   chunk borders. Glyph size follows the usual rule (~15 px tall from the
//!   eye the chunk was built for), rounded up to `FINE` x a power of two.
//!   Each coarser level keeps every other row and column of the finer one,
//!   so distant ground shows bigger glyphs that still line up.
//! * What a chunk holds is passed in: its ground tiles (`TILES` x `TILES`,
//!   `TILE` m each) and the objects whose base point lies inside it. An
//!   object is skinned in full by that chunk, even where its crown hangs
//!   over the border; the renderer's bounds come from the cards themselves.
//! * The sky dome, rain and blowing leaves don't depend on the ground: they
//!   come from `sky`.

use super::asset::{Asset, Placement};
use super::library::{Kind, Library};
use super::light::Occlusion;
use super::sky::{self, Sky, DAY, DUSK};
use super::skin::{skin_placed, CardMode, Glyphs, Skinner, View};
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
/// Ground tile side (m): what one brush dab paints at least.
pub const TILE: f32 = 0.5;
/// Ground tiles per chunk side.
pub const TILES: usize = (CHUNK / TILE) as usize;
/// Floats per placed object: kind code, seed, x, z, yaw (radians), scale.
pub const OBJECT_FLOATS: usize = 6;
/// Generated variants per kind; an object's seed picks one of them.
pub const VARIANTS: u32 = 8;
/// The glyph size is chosen per square cell of this side (m).
const CELL: f32 = 4.0;
/// 50 degree field of view, 1000 px tall.
const FOCAL: f32 = 1072.0;

/// What a ground tile is painted with. The code is the byte stored per tile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Ground {
    Canvas = 0,
    Grass = 1,
    Sand = 2,
    Water = 3,
    Rock = 4,
}

impl Ground {
    pub const ALL: [Ground; 5] = [Ground::Canvas, Ground::Grass, Ground::Sand, Ground::Water, Ground::Rock];

    pub fn from_code(c: u8) -> Ground {
        Ground::ALL.get(c as usize).copied().unwrap_or(Ground::Canvas)
    }

    pub fn name(self) -> &'static str {
        ["canvas", "grass", "sand", "water", "rock"][self as usize]
    }

    fn mat(self) -> Mat {
        match self {
            Ground::Canvas => Mat::Canvas,
            Ground::Grass => Mat::GroundGrass,
            Ground::Sand => Mat::Sand,
            Ground::Water => Mat::Water,
            Ground::Rock => Mat::GroundRock,
        }
    }
}

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

/// A small, stable hash of a grid point (colour variation that doesn't
/// depend on build order or level of detail).
fn hash2(i: i64, j: i64) -> f32 {
    let h = (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (j as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    let h = (h ^ (h >> 31)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    ((h >> 40) as f32) / (1u64 << 24) as f32
}

/// What a chunk holds: its ground tiles (empty = all canvas, else
/// `TILES * TILES` codes, row-major from the chunk corner, z rows) and its
/// placed objects (`OBJECT_FLOATS` each).
#[derive(Clone, Copy, Debug, Default)]
pub struct ChunkData<'a> {
    pub tiles: &'a [u8],
    pub objects: &'a [f32],
}

pub struct ChunkOut {
    pub cards: Vec<f32>,
    /// Opaque ground and near solids (rocks, trunks): hide what lies behind.
    pub body: Vec<[Vec3; 3]>,
    /// (GRID + 1)^2 heights, 1 m apart, from the chunk corner.
    pub heights: Vec<f32>,
    /// x, z, radius, top y per collider (filled in with play mode).
    pub colliders: Vec<[f32; 4]>,
    /// Objects skinned (records with an unknown kind are skipped).
    pub placed: usize,
}

/// The canvas: a seed for the sky, the time of day, glyph pickers and the
/// cache of generated asset variants.
pub struct Canvas {
    pub seed: u32,
    pub day: bool,
    glyphs: Glyphs,
    lib: Library,
    kinds: Vec<Kind>,
}

impl Canvas {
    pub fn new(seed: u32, day: bool) -> Canvas {
        Canvas { seed, day, glyphs: Glyphs::new(), lib: Library::new(seed), kinds: Kind::all() }
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

    /// Chunk (cx, cz) holding `data`, with glyphs sized for an eye at `eye`.
    pub fn build_chunk(&mut self, cx: i32, cz: i32, eye: Vec3, aspect: f32, data: ChunkData) -> ChunkOut {
        let (x0, z0) = (cx as f32 * CHUNK, cz as f32 * CHUNK);
        let view = Self::view(eye);

        // Objects first: generate (or fetch) their assets while `lib` may change.
        let mut objects: Vec<(usize, Kind, Placement)> = Vec::new();
        for o in data.objects.chunks_exact(OBJECT_FLOATS) {
            let Some(&kind) = self.kinds.get(o[0] as usize) else { continue };
            if o.iter().any(|v| !v.is_finite()) {
                continue;
            }
            let seed = o[1] as u32;
            let (x, z) = (o[2], o[3]);
            let d = (x - eye.x).hypot(z - eye.z);
            let lod = if d < 32.0 { 0 } else if d < 90.0 { 1 } else { 2 };
            let asset = self.lib.get(kind, seed % VARIANTS, lod);
            let sink = if let Kind::Tree(_) = kind { 0.12 } else { 0.03 };
            let tint = 0.85 + 0.3 * hash2(seed as i64, 7);
            let pl = Placement { pos: Vec3::new(x, GROUND - sink, z), yaw: o[4], scale: o[5].clamp(0.05, 20.0), tint };
            objects.push((asset, kind, pl));
        }

        let seed = self.seed as u64 ^ ((cx as u64) << 32) ^ (cz as u32 as u64);
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, seed);
        ground(&mut sk, &view, x0, z0, aspect, data.tiles);
        for &(asset, _, pl) in &objects {
            let a: &Asset = &self.lib.assets[asset];
            skin_placed(&mut sk, a, pl, &view);
        }
        if !objects.is_empty() {
            // Baked shadows from this chunk's own objects (onto the ground too).
            let occ = Occlusion::with_max_cells(&sk.occluders, 6.0e5);
            sk.light(&occ, sky::sun_for(self.day), &|_| 1.0, Some(eye));
        }

        let y = GROUND - 0.08;
        let (a, b) = (Vec3::new(x0, y, z0), Vec3::new(x0 + CHUNK, y, z0));
        let (c, d) = (Vec3::new(x0 + CHUNK, y, z0 + CHUNK), Vec3::new(x0, y, z0 + CHUNK));
        let mut body = vec![[a, d, c], [a, c, b]];
        body.append(&mut sk.solids);
        ChunkOut {
            cards: std::mem::take(&mut sk.cards),
            body,
            heights: vec![GROUND; (GRID + 1) * (GRID + 1)],
            colliders: Vec::new(),
            placed: objects.len(),
        }
    }
}

/// Ground glyphs over the chunk at (x0, z0): one per grid point, each from
/// the material its tile is painted with.
fn ground(sk: &mut Skinner, view: &View, x0: f32, z0: f32, aspect: f32, tiles: &[u8]) {
    let painted = tiles.len() == TILES * TILES;
    let cells = (CHUNK / CELL) as usize;
    for cj in 0..cells {
        for ci in 0..cells {
            let (ax, az) = (x0 + ci as f32 * CELL, z0 + cj as f32 * CELL);
            let s = spacing(view, Vec3::new(ax + CELL / 2.0, GROUND, az + CELL / 2.0));
            let sx = s * aspect;
            // Grid points whose centre falls inside this cell: (i + 0.5) * sx.
            let (i0, i1) = (((ax / sx) - 0.5).ceil() as i64, (((ax + CELL) / sx) - 0.5).ceil() as i64);
            let (j0, j1) = (((az / s) - 0.5).ceil() as i64, (((az + CELL) / s) - 0.5).ceil() as i64);
            for j in j0..j1 {
                for i in i0..i1 {
                    let (x, z) = ((i as f32 + 0.5) * sx, (j as f32 + 0.5) * s);
                    let g = if painted {
                        let ti = (((x - x0) / TILE) as usize).min(TILES - 1);
                        let tj = (((z - z0) / TILE) as usize).min(TILES - 1);
                        Ground::from_code(tiles[tj * TILES + ti])
                    } else {
                        Ground::Canvas
                    };
                    let mat = g.mat();
                    let def = mat.def();
                    let glyph = sk.glyph(mat);
                    let f = 1.0 + def.var * (2.0 * hash2(i, j) - 1.0);
                    let col = def.albedo.map(|c| c * f);
                    let c = Vec3::new(x, GROUND + 0.01 * s, z);
                    // Flat on the ground (U x V = up), upright when seen from +z;
                    // the shader leans it toward the camera.
                    let mode = if g == Ground::Water { CardMode::WaterLean } else { CardMode::GroundLean };
                    sk.push(c, Vec3::X * sx, Vec3::new(0.0, 0.0, -s), col, def.alpha.0, glyph, mat, mode);
                }
            }
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

    fn blank() -> ChunkData<'static> {
        ChunkData::default()
    }

    fn mat_mode(card: &[f32]) -> (u32, u32) {
        let high = card[layout::GLYPH] as u32 / MATERIAL_SHIFT;
        (high % MAX_MATERIALS, high / MAX_MATERIALS)
    }

    fn code(name: &str) -> f32 {
        Kind::all().iter().position(|k| k.name() == name).unwrap() as f32
    }

    #[test]
    fn blank_chunks_are_neat_rows_of_hash_on_flat_ground() {
        let mut canvas = Canvas::new(1, false);
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, blank());
        let n = c.cards.len() / STRIDE;
        assert!(n > 1000, "{n} cards");
        let hash = canvas.glyphs.charset.chars().position(|ch| ch == '#').unwrap() as u32;
        for card in c.cards.chunks_exact(STRIDE) {
            assert!(card.iter().all(|v| v.is_finite()));
            assert_eq!(card[layout::GLYPH] as u32 % MATERIAL_SHIFT, hash, "only '#'");
            assert_eq!(mat_mode(card), (Mat::Canvas as u32, CardMode::GroundLean as u32));
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
        assert_eq!(c.placed, 0);
    }

    #[test]
    fn rows_continue_across_chunk_borders() {
        let mut canvas = Canvas::new(1, false);
        // Eye on the border, so both sides use the same spacing near it.
        let e = Vec3::new(32.0, 1.7, 16.0);
        let mut rows = |cx| {
            let c = canvas.build_chunk(cx, 0, e, ASPECT, blank());
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
        let mut canvas = Canvas::new(1, false);
        let near = canvas.build_chunk(0, 0, eye(), ASPECT, blank()).cards.len();
        let far = canvas.build_chunk(8, 0, eye(), ASPECT, blank()).cards.len();
        assert!(near > far * 8, "near {near}, far {far}");
        let v = Canvas::view(eye());
        assert_eq!(spacing(&v, eye()), FINE);
        assert_eq!(spacing(&v, Vec3::new(5000.0, 0.0, 0.0)), COARSE);
    }

    #[test]
    fn painted_tiles_show_their_material_where_painted() {
        let mut canvas = Canvas::new(1, false);
        // Left half of the chunk water, a sand strip along z = 8..10 m, rest canvas.
        let mut tiles = vec![Ground::Canvas as u8; TILES * TILES];
        for tj in 0..TILES {
            for ti in 0..TILES {
                let (x, z) = ((ti as f32 + 0.5) * TILE, (tj as f32 + 0.5) * TILE);
                if x < 16.0 {
                    tiles[tj * TILES + ti] = Ground::Water as u8;
                } else if (8.0..10.0).contains(&z) {
                    tiles[tj * TILES + ti] = Ground::Sand as u8;
                }
            }
        }
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &tiles, objects: &[] });
        let mut seen = [0usize; 3];
        for card in c.cards.chunks_exact(STRIDE) {
            let (x, z) = (card[0], card[2]);
            let (mat, mode) = mat_mode(card);
            if x < 16.0 {
                assert_eq!((mat, mode), (Mat::Water as u32, CardMode::WaterLean as u32), "water at {x} {z}");
                seen[0] += 1;
            } else if (8.0..10.0).contains(&z) {
                assert_eq!(mat, Mat::Sand as u32, "sand at {x} {z}");
                seen[1] += 1;
            } else {
                assert_eq!(mat, Mat::Canvas as u32, "canvas at {x} {z}");
                seen[2] += 1;
            }
        }
        assert!(seen.iter().all(|&n| n > 100), "{seen:?}");
    }

    #[test]
    fn objects_are_skinned_whole_by_the_chunk_that_holds_their_base() {
        let mut canvas = Canvas::new(1, false);
        // An oak right next to the border with chunk (1, 0): its crown spills over.
        let oak = [code("tree:oak"), 3.0, 31.5, 16.0, 0.0, 1.0];
        let rock = [code("rock:boulder"), 1.0, 10.0, 10.0, 1.0, 1.0];
        let objects: Vec<f32> = oak.iter().chain(&rock).copied().collect();
        let blank_n = canvas.build_chunk(0, 0, eye(), ASPECT, blank()).cards.len();
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &[], objects: &objects });
        assert_eq!(c.placed, 2);
        assert!(c.cards.len() > blank_n + 2000 * STRIDE, "objects add cards");
        assert!(c.body.len() > 2, "near rock and trunk add solid bodies");
        let over = c.cards.chunks_exact(STRIDE).filter(|k| k[0] > CHUNK + 0.5 && k[1] > 1.0).count();
        assert!(over > 100, "the crown hanging over the border is part of this chunk ({over} cards)");
        let high = c.cards.chunks_exact(STRIDE).filter(|k| k[1] > 4.0).count();
        assert!(high > 500, "a tree stands up");
        // The neighbour doesn't draw it.
        let n = canvas.build_chunk(1, 0, eye(), ASPECT, blank());
        assert!(n.cards.chunks_exact(STRIDE).all(|k| k[1] < 0.5));
        // Shadows: some ground glyphs near the oak are shaded.
        let shaded = c.cards.chunks_exact(STRIDE).filter(|k| k[1] < 0.2 && k[layout::LIGHT] < 0.5).count();
        assert!(shaded > 50, "the oak shades the ground ({shaded})");
    }

    #[test]
    fn unknown_or_broken_objects_are_skipped() {
        let mut canvas = Canvas::new(1, false);
        let objects = [999.0, 1.0, 5.0, 5.0, 0.0, 1.0, code("rock:slab"), 1.0, f32::NAN, 5.0, 0.0, 1.0];
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &[], objects: &objects });
        assert_eq!(c.placed, 0);
    }

    #[test]
    fn deterministic() {
        let objects = [code("bush:juniper"), 9.0, -80.0, 70.0, 0.4, 1.2];
        let data = ChunkData { tiles: &[], objects: &objects };
        let a = Canvas::new(5, true).build_chunk(-3, 2, eye(), ASPECT, data).cards;
        let mut canvas = Canvas::new(5, true);
        canvas.build_chunk(0, 0, eye(), ASPECT, blank()); // build order must not matter
        assert_eq!(canvas.build_chunk(-3, 2, eye(), ASPECT, data).cards, a);
    }

    #[test]
    fn the_sky_and_weather_are_kept() {
        let cards = Canvas::new(1, false).sky_cards(ASPECT);
        let mut modes = [0usize; 9];
        for c in cards.chunks_exact(STRIDE) {
            modes[mat_mode(c).1 as usize] += 1;
        }
        assert!(modes[CardMode::Emissive as usize] > 20_000, "sky dome");
        assert_eq!(modes[CardMode::Rain as usize], 7000, "rain");
        assert_eq!(modes[CardMode::Drift as usize], 900, "blowing leaves");
    }
}
