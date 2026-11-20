//! The canvas: an endless flat map you paint on, built in square chunks.
//!
//! * Unpainted ground is neat, evenly spaced, parallel rows of '#'. Painted
//!   ground (grass, sand, water, rock) uses the same grid with that
//!   material's characters, so the map keeps its tidy terminal look.
//! * Every glyph sits on one world-aligned grid (points at i x step), so
//!   rows run straight across chunk borders. Glyph size follows the usual
//!   rule (~15 px tall from the eye the chunk was built for), rounded up to
//!   `FINE` x a power of two. Each coarser level keeps every other row and
//!   column of the finer one, so distant ground shows bigger glyphs that
//!   still line up.
//! * Glyphs never pile up much on screen. Ground seen at a low angle
//!   squeezes its rows together, so each 4 m cell picks its row and column
//!   steps on their own: doubled until at most `GROUND_STACK` glyphs
//!   overlap where it lands on screen. Objects keep at most `OBJECT_STACK`
//!   glyphs per glyph-sized patch of view, nearest first: what hides behind
//!   a nearer crown is what goes. Both are measured from the eye, by angle,
//!   so they hold whichever way the camera turns.
//! * What a chunk holds is passed in: its ground tiles (`TILES` x `TILES`,
//!   `TILE` m each) and the objects whose base point lies inside it. An
//!   object is skinned in full by that chunk, even where its crown hangs
//!   over the border; the renderer's bounds come from the cards themselves.
//! * The sky dome, rain and blowing leaves don't depend on the ground: they
//!   come from `sky`.

use super::asset::{unit, Asset, Placement};
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
/// Height points per chunk side: (GRID + 1)^2, 1 m apart, shared with the
/// neighbours along the borders (`ChunkData::heights`).
pub const HEIGHTS: usize = GRID + 1;
/// Ground tile side (m): what one brush dab paints at least.
pub const TILE: f32 = 0.5;
/// Ground tiles per chunk side.
pub const TILES: usize = (CHUNK / TILE) as usize;
/// Floats per placed object: kind code, seed, x, z, yaw (radians), scale,
/// then `MAX_PARAMS` generator parameter values (see `params`; a missing or
/// non-finite value means the default).
pub const OBJECT_FLOATS: usize = 6 + super::params::MAX_PARAMS;
/// Generated variants per kind; an object's seed picks one of them.
pub const VARIANTS: u32 = 8;
/// Ground glyphs allowed to overlap on one spot of the screen.
pub const GROUND_STACK: f32 = 3.0;
/// Object glyphs allowed per glyph-sized patch of view (one chunk's objects).
pub const OBJECT_STACK: usize = 6;
/// Row / column step (m) is never coarser than this.
pub const MAX_STEP: f32 = 512.0;
/// The glyph size is chosen per square cell of this side (m).
const CELL: f32 = 4.0;
/// 50 degree field of view, 1000 px tall.
const FOCAL: f32 = 1072.0;
/// One glyph (15 px) as an angle from the eye, radians.
const GLYPH_ANGLE: f32 = 15.0 / FOCAL;

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

/// Row and column steps (x, z) for the cell centred at `c`, whose glyphs
/// are `s` tall (`s * aspect` wide): each starts at the glyph size and
/// doubles while more than `GROUND_STACK` grid points fall inside one
/// glyph's footprint on the ground. Seen from the eye at a grazing angle,
/// that footprint stretches away from the eye by 1 / sin(angle), so the
/// step that points more away from the eye is the one that grows.
pub fn steps(eye: Vec3, c: Vec3, s: f32, aspect: f32) -> (f32, f32) {
    steps_on(eye, c, Vec3::Y, s, aspect)
}

/// `steps` for ground whose surface normal is `n` (a slope): the footprint
/// stretches by 1 / sin of the angle between the view and the surface, so a
/// hillside facing the eye keeps its rows close, and ground seen edge-on
/// spreads them.
pub fn steps_on(eye: Vec3, c: Vec3, n: Vec3, s: f32, aspect: f32) -> (f32, f32) {
    let (dx, dz) = (c.x - eye.x, c.z - eye.z);
    let d = dx.hypot(dz);
    let (mut sx, mut sz) = (s * aspect, s);
    if d < 1.0 {
        return (sx, sz);
    }
    let to_eye = eye - c;
    let graze = (n.dot(to_eye) / to_eye.length().max(1e-4)).abs().max(0.01); // sin of the view angle to the surface
    let footprint = s * s * aspect / graze; // ground area under one glyph, m^2
    let x_first = dx.abs() >= dz.abs(); // x points more away from the eye
    for _ in 0..24 {
        if footprint / (sx * sz) <= GROUND_STACK {
            break;
        }
        let grow_x = if x_first { sx < MAX_STEP } else { sz >= MAX_STEP };
        if grow_x && sx < MAX_STEP {
            sx *= 2.0;
        } else if sz < MAX_STEP {
            sz *= 2.0;
        } else {
            break;
        }
    }
    (sx, sz)
}

/// Keep at most `OBJECT_STACK` of the cards from `start` on per
/// glyph-sized patch of view from `eye`, nearest first.
fn cap_stacking(cards: &mut Vec<f32>, start: usize, eye: Vec3) {
    use crate::cards::STRIDE;
    let n = cards.len() / STRIDE;
    if n <= start {
        return;
    }
    let mut keyed: Vec<(i64, f32, usize)> = (start..n)
        .map(|i| {
            let c = &cards[i * STRIDE..i * STRIDE + 3];
            let (dx, dy, dz) = (c[0] - eye.x, c[1] - eye.y, c[2] - eye.z);
            let dist = (dx * dx + dy * dy + dz * dz).sqrt().max(1e-4);
            let pitch = (dy / dist).clamp(-1.0, 1.0).asin();
            // Columns of equal width on the view sphere: fewer round the poles.
            let yaw_cell = GLYPH_ANGLE / pitch.cos().max(0.05);
            let (a, b) = ((dz.atan2(dx) / yaw_cell).floor() as i64, (pitch / GLYPH_ANGLE).floor() as i64);
            ((a << 24) ^ (b & 0xff_ffff), dist, i)
        })
        .collect();
    keyed.sort_unstable_by(|p, q| p.0.cmp(&q.0).then(p.1.total_cmp(&q.1)));
    let mut keep: Vec<usize> = Vec::with_capacity(keyed.len());
    let mut run = (i64::MIN, 0usize);
    for &(key, _, i) in &keyed {
        if key != run.0 {
            run = (key, 0);
        }
        if run.1 < OBJECT_STACK {
            keep.push(i);
        }
        run.1 += 1;
    }
    if keep.len() == n - start {
        return;
    }
    keep.sort_unstable(); // keep the original order (it carries no meaning, but stays deterministic)
    let mut out = Vec::with_capacity((start + keep.len()) * STRIDE);
    out.extend_from_slice(&cards[..start * STRIDE]);
    for i in keep {
        out.extend_from_slice(&cards[i * STRIDE..(i + 1) * STRIDE]);
    }
    *cards = out;
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
    /// Ground heights: empty (flat at GROUND) or HEIGHTS x HEIGHTS values,
    /// 1 m apart from the chunk corner, row-major (z rows).
    pub heights: &'a [f32],
}

/// A chunk's ground height field (flat when there are no heights).
#[derive(Clone, Copy)]
struct Field<'a> {
    h: &'a [f32],
    x0: f32,
    z0: f32,
}

impl Field<'_> {
    fn at_vertex(&self, i: usize, j: usize) -> f32 {
        GROUND + self.h[j.min(HEIGHTS - 1) * HEIGHTS + i.min(HEIGHTS - 1)]
    }

    /// Height at (x, z), bilinear between the 1 m points (clamped to the chunk).
    fn at(&self, x: f32, z: f32) -> f32 {
        if self.h.is_empty() {
            return GROUND;
        }
        let m = (HEIGHTS - 1) as f32;
        let fx = (x - self.x0).clamp(0.0, m - 1e-4);
        let fz = (z - self.z0).clamp(0.0, m - 1e-4);
        let (i, j) = (fx as usize, fz as usize);
        let (tx, tz) = (fx - i as f32, fz - j as f32);
        let a = self.at_vertex(i, j) * (1.0 - tx) + self.at_vertex(i + 1, j) * tx;
        let b = self.at_vertex(i, j + 1) * (1.0 - tx) + self.at_vertex(i + 1, j + 1) * tx;
        a * (1.0 - tz) + b * tz
    }

    /// Slope (dh/dx, dh/dz) at (x, z).
    fn slope(&self, x: f32, z: f32) -> (f32, f32) {
        if self.h.is_empty() {
            return (0.0, 0.0);
        }
        // Sample half a metre each way, but never outside the chunk: divide by
        // the distance really covered, or slopes halve near the border.
        let m = (HEIGHTS - 1) as f32;
        let (xa, xb) = ((x - 0.5).max(self.x0), (x + 0.5).min(self.x0 + m));
        let (za, zb) = ((z - 0.5).max(self.z0), (z + 0.5).min(self.z0 + m));
        let dx = if xb > xa { (self.at(xb, z) - self.at(xa, z)) / (xb - xa) } else { 0.0 };
        let dz = if zb > za { (self.at(x, zb) - self.at(x, za)) / (zb - za) } else { 0.0 };
        (dx, dz)
    }
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
    /// Per object drawn: its record index in the input, then the world box
    /// it fills (min x, y, z, max x, y, z; turned boxes are enclosed).
    pub bounds: Vec<[f32; 7]>,
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
        let field = Field { h: if data.heights.len() == HEIGHTS * HEIGHTS { data.heights } else { &[] }, x0, z0 };

        // Objects first: generate (or fetch) their assets while `lib` may change.
        let mut objects: Vec<(usize, Kind, Placement)> = Vec::new();
        let mut bounds: Vec<[f32; 7]> = Vec::new();
        self.lib.trim(); // between builds: drop the cache if it grew too big
        for (index, o) in data.objects.chunks_exact(OBJECT_FLOATS).enumerate() {
            let Some(&kind) = self.kinds.get(o[0] as usize) else { continue };
            if o[..6].iter().any(|v| !v.is_finite()) {
                continue;
            }
            let params = &o[6..6 + super::params::param_descs(kind).len()];
            let seed = o[1] as u32;
            let (x, z) = (o[2], o[3]);
            let d = (x - eye.x).hypot(z - eye.z);
            let lod = if d < 32.0 { 0 } else if d < 90.0 { 1 } else { 2 };
            let asset = self.lib.get_with(kind, params, seed % VARIANTS, lod);
            let sink = if let Kind::Tree(_) = kind { 0.12 } else { 0.03 };
            let tint = 0.85 + 0.3 * hash2(seed as i64, 7);
            let pl = Placement { pos: Vec3::new(x, field.at(x, z) - sink, z), yaw: o[4], scale: o[5].clamp(0.05, 20.0), tint };
            let (lo, hi) = self.lib.assets[asset].bounds();
            let r = [lo.x, hi.x, lo.z, hi.z].iter().fold(0.0f32, |m, v| m.max(v.abs())) * pl.scale;
            bounds.push([index as f32, x - r, pl.pos.y + lo.y * pl.scale, z - r, x + r, pl.pos.y + hi.y * pl.scale, z + r]);
            objects.push((asset, kind, pl));
        }

        let seed = self.seed as u64 ^ ((cx as u64) << 32) ^ (cz as u32 as u64);
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, seed);
        ground(&mut sk, &view, x0, z0, aspect, data.tiles, field);
        let ground_cards = sk.card_count();
        for &(asset, _, pl) in &objects {
            let a: &Asset = &self.lib.assets[asset];
            skin_placed(&mut sk, a, pl, &view);
        }
        if !objects.is_empty() {
            // Baked shadows from this chunk's own objects (onto the ground too).
            let occ = Occlusion::with_max_cells(&sk.occluders, 6.0e5);
            sk.light(&occ, sky::sun_for(self.day), &|_| 1.0, Some(eye));
            // After lighting: it refers to cards by index.
            cap_stacking(&mut sk.cards, ground_cards, eye);
        }

        // Opaque ground, sunk a little: two triangles when flat, a 1 m mesh otherwise.
        let mut body = Vec::new();
        if field.h.is_empty() {
            let y = GROUND - 0.08;
            let (a, b) = (Vec3::new(x0, y, z0), Vec3::new(x0 + CHUNK, y, z0));
            let (c, d) = (Vec3::new(x0 + CHUNK, y, z0 + CHUNK), Vec3::new(x0, y, z0 + CHUNK));
            body.extend([[a, d, c], [a, c, b]]);
        } else {
            let v = |i: usize, j: usize| Vec3::new(x0 + i as f32, field.at_vertex(i, j) - 0.08, z0 + j as f32);
            for j in 0..HEIGHTS - 1 {
                for i in 0..HEIGHTS - 1 {
                    let (a, b, c, d) = (v(i, j), v(i + 1, j), v(i + 1, j + 1), v(i, j + 1));
                    body.extend([[a, d, c], [a, c, b]]);
                }
            }
        }
        body.append(&mut sk.solids);
        ChunkOut {
            cards: std::mem::take(&mut sk.cards),
            body,
            heights: if field.h.is_empty() { vec![GROUND; HEIGHTS * HEIGHTS] } else { field.h.iter().map(|h| GROUND + h).collect() },
            colliders: Vec::new(),
            placed: objects.len(),
            bounds,
        }
    }
}

/// Ground glyphs over the chunk at (x0, z0): one per grid point, each from
/// the material its tile is painted with.
fn ground(sk: &mut Skinner, view: &View, x0: f32, z0: f32, aspect: f32, tiles: &[u8], field: Field) {
    let painted = tiles.len() == TILES * TILES;
    let cells = (CHUNK / CELL) as usize;
    for cj in 0..cells {
        for ci in 0..cells {
            let (ax, az) = (x0 + ci as f32 * CELL, z0 + cj as f32 * CELL);
            let centre = Vec3::new(ax + CELL / 2.0, field.at(ax + CELL / 2.0, az + CELL / 2.0), az + CELL / 2.0);
            let s = spacing(view, centre);
            let sx = s * aspect;
            let (hx, hz) = field.slope(centre.x, centre.z);
            let (step_x, step_z) = steps_on(view.eye, centre, unit(Vec3::new(-hx, 1.0, -hz)), s, aspect);
            // Grid points (i * step) inside this cell.
            let (i0, i1) = ((ax / step_x).ceil() as i64, ((ax + CELL) / step_x).ceil() as i64);
            let (j0, j1) = ((az / step_z).ceil() as i64, ((az + CELL) / step_z).ceil() as i64);
            for j in j0..j1 {
                for i in i0..i1 {
                    let (x, z) = (i as f32 * step_x, j as f32 * step_z);
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
                    let f = 1.0 + def.var * (2.0 * hash2((x / sx).round() as i64, (z / s).round() as i64) - 1.0);
                    let col = def.albedo.map(|c| c * f);
                    // Flat on the ground and tilted with its slope (U x V = surface
                    // normal), upright when seen from +z; the shader leans it toward
                    // the camera.
                    let (sx_, sz_) = field.slope(x, z);
                    let u = unit(Vec3::new(1.0, sx_, 0.0)) * sx;
                    let v = unit(Vec3::new(0.0, -sz_, -1.0)) * s;
                    let c = Vec3::new(x, field.at(x, z) + 0.01 * s, z);
                    let mode = if g == Ground::Water { CardMode::WaterLean } else { CardMode::GroundLean };
                    sk.push(c, u, v, col, def.alpha.0, glyph, mat, mode);
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

    /// One object record: kind, seed, x, z, yaw, scale, then default (blank) parameters.
    fn rec(v: [f32; 6]) -> Vec<f32> {
        let mut r = v.to_vec();
        r.resize(OBJECT_FLOATS, f32::NAN);
        r
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
            let (fi, fj) = (card[0] / sx, card[2] / s);
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
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &tiles, objects: &[], heights: &[] });
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
        let mut objects = rec([code("tree:oak"), 3.0, 31.5, 16.0, 0.0, 1.0]);
        objects.extend(rec([code("rock:boulder"), 1.0, 10.0, 10.0, 1.0, 1.0]));
        let blank_n = canvas.build_chunk(0, 0, eye(), ASPECT, blank()).cards.len();
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &[], objects: &objects, heights: &[] });
        assert_eq!(c.placed, 2);
        assert_eq!(c.bounds.len(), 2);
        let oak_box = c.bounds[0];
        assert_eq!(oak_box[0], 0.0, "record index");
        assert!(oak_box[1] < 31.5 && oak_box[4] > 31.5 && oak_box[5] > 5.0, "the box holds the oak: {oak_box:?}");
        assert_eq!(c.bounds[1][0], 1.0);
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
    fn objects_grow_with_their_parameters() {
        let mut canvas = Canvas::new(1, false);
        let oak = code("tree:oak");
        let usual = rec([oak, 3.0, 16.0, 16.0, 0.0, 1.0]);
        let mut tall = usual.clone();
        let i = super::super::params::param_descs(Kind::all()[oak as usize]).iter().position(|d| d.name == "height").unwrap();
        tall[6 + i] = 2.0;
        let mut top = |objects: &[f32]| canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &[], objects, heights: &[] }).bounds[0][5];
        let (a, b) = (top(&usual), top(&tall));
        assert!(b > a * 1.6, "height 2 makes a taller oak: {a} -> {b}");
    }

    /// Heights for chunk (cx, cz) from a function of world (x, z).
    fn heights_of(cx: i32, cz: i32, f: impl Fn(f32, f32) -> f32) -> Vec<f32> {
        let (x0, z0) = (cx as f32 * CHUNK, cz as f32 * CHUNK);
        (0..HEIGHTS * HEIGHTS).map(|k| f(x0 + (k % HEIGHTS) as f32, z0 + (k / HEIGHTS) as f32)).collect()
    }

    #[test]
    fn the_ground_follows_its_heights_and_objects_stand_on_it() {
        let mut canvas = Canvas::new(1, false);
        // A plane rising 0.1 m per metre east: bilinear is exact on it.
        let slope = |x: f32, _z: f32| 0.1 * x + 2.0;
        let e = Vec3::new(32.0, 12.0, 16.0);
        let mut objects = rec([code("rock:boulder"), 1.0, 10.0, 10.0, 0.0, 1.0]);
        objects.extend(rec([code("tree:pine"), 2.0, 20.0, 5.0, 0.0, 1.0]));
        for cx in [0, 1] {
            let h = heights_of(cx, 0, slope);
            let c = canvas.build_chunk(cx, 0, e, ASPECT, ChunkData { tiles: &[], objects: if cx == 0 { &objects } else { &[] }, heights: &h });
            let mut n = 0;
            for card in c.cards.chunks_exact(STRIDE).filter(|k| mat_mode(k).0 == Mat::Canvas as u32) {
                let s = -card[layout::V + 2].clamp(-100.0, -1e-6);
                let lift = 0.01 * (card[layout::V] * card[layout::V] + card[layout::V + 1] * card[layout::V + 1] + card[layout::V + 2] * card[layout::V + 2]).sqrt();
                assert!((card[1] - slope(card[0], card[2]) - lift).abs() < 2e-3 * s.max(1.0), "glyph at ({}, {}) is at {} not {}", card[0], card[2], card[1], slope(card[0], card[2]));
                // Tilted with the slope: U x V points up and a little west.
                let u = Vec3::new(card[layout::U], card[layout::U + 1], card[layout::U + 2]);
                let v = Vec3::new(card[layout::V], card[layout::V + 1], card[layout::V + 2]);
                let nrm = unit(u.cross(v));
                assert!((nrm.x - unit(Vec3::new(-0.1, 1.0, 0.0)).x).abs() < 1e-3 && nrm.y > 0.99, "normal {nrm:?}");
                n += 1;
            }
            assert!(n > 100);
            assert_eq!(c.heights.len(), HEIGHTS * HEIGHTS);
            assert!((c.heights[HEIGHTS - 1] - slope(cx as f32 * CHUNK + 32.0, 0.0)).abs() < 1e-4, "physics heights follow");
            assert!(c.body.len() >= 2 * 32 * 32, "a ground mesh, not a flat quad");
            if cx == 0 {
                // Objects stand on the ground under them (rocks sink 3 cm, trees 12).
                let rock_bottom = c.bounds[0][2];
                assert!(rock_bottom > slope(10.0, 10.0) - 0.6 && rock_bottom < slope(10.0, 10.0) + 0.2, "rock at {rock_bottom}");
                let pine_bottom = c.bounds[1][2];
                assert!((pine_bottom - slope(20.0, 5.0)).abs() < 0.6, "pine at {pine_bottom}");
            }
        }
    }

    #[test]
    fn unknown_or_broken_objects_are_skipped() {
        let mut canvas = Canvas::new(1, false);
        let mut objects = rec([999.0, 1.0, 5.0, 5.0, 0.0, 1.0]);
        objects.extend(rec([code("rock:slab"), 1.0, f32::NAN, 5.0, 0.0, 1.0]));
        let c = canvas.build_chunk(0, 0, eye(), ASPECT, ChunkData { tiles: &[], objects: &objects, heights: &[] });
        assert_eq!(c.placed, 0);
    }

    #[test]
    fn deterministic() {
        let objects = rec([code("bush:juniper"), 9.0, -80.0, 70.0, 0.4, 1.2]);
        let data = ChunkData { tiles: &[], objects: &objects, heights: &[] };
        let a = Canvas::new(5, true).build_chunk(-3, 2, eye(), ASPECT, data).cards;
        let mut canvas = Canvas::new(5, true);
        canvas.build_chunk(0, 0, eye(), ASPECT, blank()); // build order must not matter
        assert_eq!(canvas.build_chunk(-3, 2, eye(), ASPECT, data).cards, a);
    }

    /// Cards per glyph-sized patch of view from `eye`: (95th percentile, max).
    fn stack(cards: &[f32], eye: Vec3, only: impl Fn(&[f32]) -> bool) -> (usize, usize) {
        let mut counts = std::collections::HashMap::<(i64, i64), usize>::new();
        for c in cards.chunks_exact(STRIDE).filter(|c| only(c)) {
            let (dx, dy, dz) = (c[0] - eye.x, c[1] - eye.y, c[2] - eye.z);
            let dist = (dx * dx + dy * dy + dz * dz).sqrt();
            let pitch = (dy / dist).asin();
            let key = ((dz.atan2(dx) * pitch.cos() / GLYPH_ANGLE).floor() as i64, (pitch / GLYPH_ANGLE).floor() as i64);
            *counts.entry(key).or_default() += 1;
        }
        let mut v: Vec<usize> = counts.into_values().collect();
        v.sort_unstable();
        (v[v.len() * 95 / 100], v[v.len() - 1])
    }

    #[test]
    fn ground_glyphs_do_not_pile_up_toward_the_horizon() {
        let mut canvas = Canvas::new(1, false);
        // Eye level, looking along -z: the whole strip of chunks ahead.
        let e = Vec3::new(16.0, 1.7, 16.0);
        let mut cards = Vec::new();
        for cz in -9..=0 {
            for cx in -1..=1 {
                cards.extend(canvas.build_chunk(cx, cz, e, ASPECT, blank()).cards);
            }
        }
        let (p95, max) = stack(&cards, e, |c| c[2] < e.z - 3.0);
        eprintln!("ground stacking at eye level: p95 {p95}, max {max}, {} cards", cards.len() / STRIDE);
        // Patches don't line up with glyphs, so a glyph's worth can straddle two.
        assert!(p95 <= 2 * GROUND_STACK as usize, "p95 {p95}");
        assert!(max <= 4 * GROUND_STACK as usize, "max {max}");
        // Far ahead, rows (along the view) spread out more than columns.
        let (sx, sz) = steps(e, Vec3::new(16.0, 0.0, -150.0), 2.0, ASPECT);
        assert!(sz > sx * 4.0, "rows {sz} m apart, columns {sx} m");
        // A hillside facing the eye, even above it, keeps its rows close.
        let (eye, c) = (Vec3::new(0.0, 7.0, 0.0), Vec3::new(0.0, 20.0, -30.0));
        assert_eq!(steps_on(eye, c, unit(eye - c), 2.0, ASPECT), (2.0 * ASPECT, 2.0));
        // Seen from straight above nothing needs spreading.
        assert_eq!(steps(Vec3::new(0.0, 100.0, 0.0), Vec3::new(10.0, 0.0, 0.0), 1.0, ASPECT), (ASPECT, 1.0));
    }

    #[test]
    fn crowded_objects_keep_only_the_nearest_glyphs_per_patch_of_view() {
        let mut canvas = Canvas::new(1, false);
        let mut objects = Vec::new();
        for k in 0..30 {
            let (x, z) = (4.0 + (k % 6) as f32 * 5.0, 2.0 + (k / 6) as f32 * 6.0);
            objects.extend(rec([code(["tree:oak", "tree:spruce", "tree:birch"][k % 3]), k as f32, x, z, k as f32, 1.0]));
        }
        let e = Vec3::new(16.0, 7.0, 60.0);
        let c = canvas.build_chunk(0, 0, e, ASPECT, ChunkData { tiles: &[], objects: &objects, heights: &[] });
        assert_eq!(c.placed, 30);
        let is_object = |k: &[f32]| mat_mode(k).0 != Mat::Canvas as u32;
        let (p95, max) = stack(&c.cards, e, is_object);
        eprintln!("object stacking: p95 {p95}, max {max}, {} object cards", c.cards.chunks_exact(STRIDE).filter(|k| is_object(k)).count());
        assert!(max <= 2 * OBJECT_STACK, "max {max}");
        assert!(p95 <= OBJECT_STACK, "p95 {p95}");
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
