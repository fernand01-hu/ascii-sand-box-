//! The infinite world: terrain, water, trails, streams, biomes and scattered
//! assets as pure functions of (seed, position), built in square chunks.
//!
//! * Height: domain-warped fBm hills everywhere, ridged mountain ranges in
//!   regions picked by a low-frequency noise; lakes wherever the land dips
//!   below the water level. No edges, no "camera side".
//! * Trails and streams: zero lines of low-frequency noise fields, so they
//!   wind across the whole world; trails are worn in slightly, streams are
//!   carved and only exist in the lowlands, flowing downhill.
//! * Biomes blend by region, altitude and nearness to water.
//! * Scattering: one jittered candidate per grid cell, seeded by the cell, so
//!   a chunk always places the same things whoever builds it and chunks join
//!   seamlessly.
//! * Glyph size follows the original's rule from a reference eye (the player
//!   or camera when the chunk was built): ~15 px tall at any distance. The
//!   renderer rebuilds a chunk when the eye has moved enough for that to be
//!   off, so detail follows you around.
use crate::fm;

use super::asset::{smoothstep, unit, Asset, Placement, RngExt};
use super::landscape::{self, Land, Sky, View, DAY, DUSK};
use super::light::Occlusion;
use super::perlin::Perlin;
use super::plants::PlantKind;
use super::scatter::{layers, Biome, Kind, Layer, LayerKind, Library};
use super::scene::{skin_placed, sun_for};
use super::skin::{Glyphs, Skinner};
use super::trees::TreeKind;
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::TAU;

/// Chunk side, metres.
pub const CHUNK: f32 = 32.0;
/// Water surface height everywhere (lakes are wherever the land is lower).
pub const WATER: f32 = 0.0;
/// Physics heights per chunk: (GRID + 1)^2 samples, 1 m apart.
pub const GRID: usize = 32;
/// Cache margin round a chunk (metres), for normals and nearby lookups.
const MARGIN: usize = 4;
/// Neighbouring objects within this distance cast shadows into a chunk.
const SHADOW_MARGIN: f32 = 20.0;
const FOCAL: f32 = 1072.0; // 50 degree field of view, 1000 px tall

pub struct WorldGen {
    pub seed: u32,
    pub main: Perlin,
    region: Perlin,
    lines: Perlin,
    tables: Vec<(Biome, Vec<Layer>)>,
}

impl WorldGen {
    pub fn new(seed: u32) -> WorldGen {
        let tables = [Biome::Meadow, Biome::Forest, Biome::Lakeside, Biome::Alpine].into_iter().map(|b| (b, layers(b))).collect();
        WorldGen {
            seed,
            main: Perlin::new(seed as u64 * 7 + 3),
            region: Perlin::new(seed as u64 * 11 + 5),
            lines: Perlin::new(seed as u64 * 13 + 9),
            tables,
        }
    }

    fn warp(&self, x: f32, z: f32, s: f32, amp: f32) -> (f32, f32) {
        let n = &self.main;
        (x + amp * n.fbm(x / s, z / s, 1.3, 3), z + amp * n.fbm(x / s + 40.0, z / s - 20.0, 2.1, 3))
    }

    /// Terrain before trails and streams are worn in.
    pub fn raw_height(&self, x: f32, z: f32) -> f32 {
        let n = &self.main;
        let (wx, wz) = self.warp(x, z, 60.0, 15.0);
        let hills = 9.0 * n.fbm(wx / 85.0, wz / 85.0, 0.1, 5) + 2.5 * n.fbm(wx / 22.0, wz / 22.0, 4.0, 4);
        let region = self.region.fbm(x / 700.0, z / 700.0, 3.0, 3);
        let (mx, mz) = self.warp(x, z, 90.0, 30.0);
        let mountains = 70.0 * fm::powf(n.ridged(mx / 260.0, mz / 260.0, 6), 1.6) * smoothstep(0.05, 0.35, region);
        hills + mountains + 2.0
    }

    /// Distance (m) to the zero line of a smooth noise field: |v| / |grad v|.
    fn line_dist(&self, x: f32, z: f32, scale: f32, off: f32) -> f32 {
        let f = |x: f32, z: f32| self.lines.fbm(x / scale + off, z / scale - off, 1.7, 3);
        let v = f(x, z);
        let e = 1.0;
        let gx = (f(x + e, z) - f(x - e, z)) / (2.0 * e);
        let gz = (f(x, z + e) - f(x, z - e)) / (2.0 * e);
        v.abs() / fm::hypot(gx, gz).max(1e-6)
    }

    /// Footpath strength (0..1), ~1.2 m wide.
    pub fn trail(&self, x: f32, z: f32) -> f32 {
        1.0 - smoothstep(0.45, 1.0, self.line_dist(x, z, 160.0, 0.0))
    }

    /// Stream strength (0..1): a winding line that only exists in the lowlands.
    pub fn stream(&self, x: f32, z: f32, raw: f32) -> f32 {
        let low = smoothstep(9.0, 3.0, raw);
        if low <= 0.0 {
            return 0.0;
        }
        (1.0 - smoothstep(0.9, 2.0, self.line_dist(x, z, 230.0, 57.3))) * low
    }

    /// Height including worn-in trails and carved stream beds.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        let raw = self.raw_height(x, z);
        raw - 0.12 * self.trail(x, z) - 0.6 * self.stream(x, z, raw)
    }

    /// Direction a stream flows at (x, z): along its line, downhill.
    pub fn flow(&self, x: f32, z: f32) -> Vec3 {
        let f = |x: f32, z: f32| self.lines.fbm(x / 230.0 + 57.3, z / 230.0 - 57.3, 1.7, 3);
        let (gx, gz) = (f(x + 1.0, z) - f(x - 1.0, z), f(x, z + 1.0) - f(x, z - 1.0));
        let mut t = unit(Vec3::new(-gz, 0.0, gx));
        let down = Vec3::new(self.raw_height(x - 2.0, z) - self.raw_height(x + 2.0, z), 0.0, self.raw_height(x, z - 2.0) - self.raw_height(x, z + 2.0));
        if t.dot(down) < 0.0 {
            t = -t;
        }
        if t == Vec3::ZERO { Vec3::X } else { t }
    }

    fn table(&self, b: Biome) -> &[Layer] {
        &self.tables.iter().find(|(bb, _)| *bb == b).expect("all biomes").1
    }

    pub fn biome(&self, x: f32, z: f32, h: f32, shore: f32) -> Biome {
        if h > 26.0 {
            Biome::Alpine
        } else if shore < 18.0 {
            Biome::Lakeside
        } else if self.region.fbm(x / 450.0 + 31.0, z / 450.0, 1.1, 2) > 0.05 {
            Biome::Forest
        } else {
            Biome::Meadow
        }
    }
}

/// One chunk's view of the world, with heights, trails and streams cached on
/// a 1 m grid (plus a margin) so the ground skin can query them cheaply.
pub struct ChunkLand<'a> {
    pub w: &'a WorldGen,
    x0: f32,
    z0: f32,
    /// Grid spacing, m (1 for chunks, coarser for far tiles).
    step: f32,
    n: usize,
    h: Vec<f32>,
    trail: Vec<f32>,
    stream: Vec<f32>,
}

impl<'a> ChunkLand<'a> {
    pub fn new(w: &'a WorldGen, cx: i32, cz: i32) -> ChunkLand<'a> {
        let n = GRID + 1 + 2 * MARGIN;
        let (x0, z0) = (cx as f32 * CHUNK - MARGIN as f32, cz as f32 * CHUNK - MARGIN as f32);
        let (mut h, mut trail, mut stream) = (vec![0.0; n * n], vec![0.0; n * n], vec![0.0; n * n]);
        for j in 0..n {
            for i in 0..n {
                let (x, z) = (x0 + i as f32, z0 + j as f32);
                let raw = w.raw_height(x, z);
                let t = w.trail(x, z);
                let s = w.stream(x, z, raw);
                h[j * n + i] = raw - 0.12 * t - 0.6 * s;
                trail[j * n + i] = t;
                stream[j * n + i] = s;
            }
        }
        ChunkLand { w, x0, z0, step: 1.0, n, h, trail, stream }
    }

    /// The land of a `size` m square from (x0, z0), sampled every `step` m.
    pub fn region(w: &'a WorldGen, x0: f32, z0: f32, size: f32, step: f32) -> ChunkLand<'a> {
        let n = (size / step).ceil() as usize + 1;
        let (mut h, mut trail, mut stream) = (vec![0.0; n * n], vec![0.0; n * n], vec![0.0; n * n]);
        for j in 0..n {
            for i in 0..n {
                let (x, z) = (x0 + i as f32 * step, z0 + j as f32 * step);
                let raw = w.raw_height(x, z);
                let t = w.trail(x, z);
                let s = w.stream(x, z, raw);
                h[j * n + i] = raw - 0.12 * t - 0.6 * s;
                trail[j * n + i] = t;
                stream[j * n + i] = s;
            }
        }
        ChunkLand { w, x0, z0, step, n, h, trail, stream }
    }

    fn sample(&self, g: &[f32], x: f32, z: f32) -> Option<f32> {
        let (fx, fz) = ((x - self.x0) / self.step, (z - self.z0) / self.step);
        let m = (self.n - 1) as f32;
        if !(0.0..m).contains(&fx) || !(0.0..m).contains(&fz) {
            return None;
        }
        let (ix, iz) = (fx as usize, fz as usize);
        let (tx, tz) = (fx - ix as f32, fz - iz as f32);
        let n = self.n;
        Some((g[iz * n + ix] * (1.0 - tx) + g[iz * n + ix + 1] * tx) * (1.0 - tz) + (g[(iz + 1) * n + ix] * (1.0 - tx) + g[(iz + 1) * n + ix + 1] * tx) * tz)
    }

    /// Physics heights: (GRID + 1)^2 samples over the chunk, 1 m apart.
    pub fn physics_heights(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity((GRID + 1) * (GRID + 1));
        for j in 0..=GRID {
            for i in 0..=GRID {
                out.push(self.h[(j + MARGIN) * self.n + i + MARGIN]);
            }
        }
        out
    }
}

impl Land for ChunkLand<'_> {
    fn height(&self, x: f32, z: f32) -> f32 {
        self.sample(&self.h, x, z).unwrap_or_else(|| self.w.height(x, z))
    }
    fn normal(&self, x: f32, z: f32) -> Vec3 {
        let e = self.step;
        let hx = self.height(x + e, z) - self.height(x - e, z);
        let hz = self.height(x, z + e) - self.height(x, z - e);
        unit(Vec3::new(-hx, 2.0 * e, -hz))
    }
    fn water(&self) -> Option<f32> {
        Some(WATER)
    }
    fn is_water(&self, x: f32, z: f32) -> bool {
        self.height(x, z) < WATER
    }
    fn shore_dist(&self, x: f32, z: f32) -> f32 {
        let h = self.height(x, z) - WATER;
        if h <= 0.0 {
            return 0.0;
        }
        let slope = (1.0 - self.normal(x, z).y).max(0.0).sqrt().max(0.05);
        h / slope
    }
    fn trail_strength(&self, x: f32, z: f32) -> f32 {
        if self.is_water(x, z) {
            return 0.0;
        }
        self.sample(&self.trail, x, z).unwrap_or_else(|| self.w.trail(x, z))
    }
    fn stream_strength(&self, x: f32, z: f32) -> f32 {
        self.sample(&self.stream, x, z).unwrap_or_else(|| self.w.stream(x, z, self.w.raw_height(x, z)))
    }
    fn snow_line(&self) -> f32 {
        48.0
    }
    fn noise(&self) -> &Perlin {
        &self.w.main
    }
    fn inside(&self, _x: f32, _z: f32) -> bool {
        true
    }
}

/// A placed asset with the information colliders need.
struct Placed {
    asset: usize,
    kind: Kind,
    pl: Placement,
}

const WORLD_LAYERS: [(LayerKind, f32); 5] =
    [(LayerKind::Trees, 6.0), (LayerKind::Bushes, 4.5), (LayerKind::Rocks, 6.0), (LayerKind::Plants, 1.2), (LayerKind::Shore, 1.5)];

fn cell_rng(seed: u32, layer: usize, ix: i64, iz: i64) -> Pcg32 {
    let h = (ix as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (iz as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ ((layer as u64) << 56) ^ seed as u64;
    Pcg32::new(h, 0xce11)
}

/// Scatter the cells whose origin lies in [x0, x1) x [z0, x1). `only_big`
/// keeps trees, bushes and rocks (for shadows from neighbouring chunks).
#[allow(clippy::too_many_arguments)]
fn scatter_rect(w: &WorldGen, land: &dyn Land, lib: &mut Library, eye: Vec3, rect: [f32; 4], only_big: bool, out: &mut Vec<Placed>) {
    let tree_line = 40.0;
    for (li, &(which, cell)) in WORLD_LAYERS.iter().enumerate() {
        if only_big && matches!(which, LayerKind::Plants | LayerKind::Shore) {
            continue;
        }
        let (ix0, ix1) = ((rect[0] / cell).ceil() as i64, ((rect[2] / cell).ceil() as i64));
        let (iz0, iz1) = ((rect[1] / cell).ceil() as i64, ((rect[3] / cell).ceil() as i64));
        for iz in iz0..iz1 {
            for ix in ix0..ix1 {
                let mut rng = cell_rng(w.seed, li, ix, iz);
                let (x, z) = ((ix as f32 + rng.next_f32()) * cell, (iz as f32 + rng.next_f32()) * cell);
                let keep_roll = rng.next_f32();
                let kind_roll = rng.next_f32();
                let d_eye = fm::hypot(x - eye.x, z - eye.z);
                let y = land.height(x, z);
                let n = land.normal(x, z);
                let slope = 1.0 - n.y;
                let alt = (y / tree_line).clamp(0.0, 2.0);
                let wet = y < WATER;
                let shore = land.shore_dist(x, z);
                let stream = land.stream_strength(x, z);
                let trail = land.trail_strength(x, z);
                if wet || stream > 0.45 {
                    continue;
                }
                let biome = w.biome(x, z, y, shore);
                let Some(layer) = w.table(biome).iter().find(|l| l.which == which) else { continue };
                if d_eye > layer.max_dist * 1.2 {
                    continue;
                }
                let moist = smoothstep(25.0, 3.0, shore) + smoothstep(0.0, 0.3, stream) * 0.6 + 0.3 * w.main.fbm(x / 40.0, z / 40.0, 5.5, 2);
                let forest = w.main.fbm(x / 70.0 + 11.0, z / 70.0 - 7.0, 3.3, 3);
                let off_path = 1.0 - smoothstep(0.05, 0.4, trail);
                let suit = match which {
                    LayerKind::Shore => smoothstep(4.0, 0.5, shore).max(smoothstep(0.03, 0.2, stream)) * f32::from(slope < 0.25),
                    LayerKind::Rocks => (0.4 + 1.5 * smoothstep(0.08, 0.4, slope)) * f32::from(shore > 1.0) * f32::from(alt < 1.6),
                    _ => {
                        let fm = layer.forest.map_or(1.0, |(lo, hi)| smoothstep(lo, hi, forest));
                        let mut s = fm * smoothstep(0.32, 0.15, slope) * f32::from(shore > if which == LayerKind::Plants { 1.0 } else { 2.0 });
                        if which == LayerKind::Trees {
                            s *= smoothstep(1.15, 0.85, alt) * (1.0 - smoothstep(0.0, 0.25, stream));
                        }
                        s
                    }
                } * off_path;
                if keep_roll >= (layer.density * suit).clamp(0.0, 1.0) {
                    continue;
                }
                let weights: Vec<f32> = layer
                    .kinds
                    .iter()
                    .map(|&(k, wgt)| {
                        let mut m = wgt;
                        if k.is_conifer() {
                            m *= 0.4 + 1.6 * smoothstep(0.2, 0.8, alt);
                        } else if which == LayerKind::Trees {
                            m *= 1.3 - smoothstep(0.3, 0.9, alt);
                        }
                        if k == Kind::Tree(TreeKind::Birch) {
                            m *= 0.5 + 2.0 * moist.clamp(0.0, 1.0);
                        }
                        if matches!(k, Kind::Plant(PlantKind::Fern | PlantKind::Hosta | PlantKind::HostaVariegated | PlantKind::ElephantEar)) {
                            m *= 0.4 + 1.5 * (moist + 0.3).clamp(0.0, 1.0);
                        }
                        m.max(1e-3)
                    })
                    .collect();
                let mut r = kind_roll * weights.iter().sum::<f32>();
                let mut kind = layer.kinds[0].0;
                for (i, &wi) in weights.iter().enumerate() {
                    if r < wi {
                        kind = layer.kinds[i].0;
                        break;
                    }
                    r -= wi;
                }
                let variant = rng.below(if which == LayerKind::Trees { 3 } else { 4 });
                let lod = if d_eye < 32.0 { 0 } else if d_eye < 90.0 { 1 } else { 2 };
                let asset = lib.get(kind, variant, lod);
                let sc = rng.uniform(0.75, 1.25);
                let mut yy = y;
                if let Kind::Rock(_) = kind {
                    let (lo, hi) = lib.assets[asset].bounds();
                    let rr = (hi.x - lo.x).max(hi.z - lo.z) * sc / 2.0;
                    for k in 0..6 {
                        let a = k as f32 / 6.0 * TAU;
                        yy = yy.min(land.height(x + rr * fm::cos(a), z + rr * fm::sin(a)));
                    }
                }
                let sink = if which == LayerKind::Trees { 0.12 } else { 0.03 };
                let pl = Placement { pos: Vec3::new(x, yy - sink, z), yaw: rng.uniform(0.0, TAU), scale: sc, tint: rng.uniform(0.85, 1.15) };
                out.push(Placed { asset, kind, pl });
            }
        }
    }
}

fn collider(a: &Asset, kind: Kind, pl: Placement) -> Option<[f32; 4]> {
    let (lo, hi) = a.bounds();
    let s = pl.scale;
    let (x, z) = (pl.pos.x, pl.pos.z);
    let top = pl.pos.y + hi.y * s;
    match kind {
        Kind::Tree(_) => {
            let r = a.wood.iter().filter(|w| w.level == 0 && w.p0.y < 1.0).map(|w| w.r).fold(0.0, f32::max);
            (r > 0.0).then_some([x, z, r * s + 0.05, top])
        }
        Kind::Rock(_) => {
            let r = (hi.x - lo.x).max(hi.z - lo.z) * s * 0.4;
            (r > 0.15).then_some([x, z, r, top])
        }
        Kind::Bush(_) => {
            let w = (hi.x - lo.x).max(hi.z - lo.z) * s;
            (w > 1.2).then_some([x, z, w * 0.3, top])
        }
        Kind::Plant(_) => None,
    }
}

pub struct ChunkOut {
    pub cards: Vec<f32>,
    pub body: Vec<[Vec3; 3]>,
    pub heights: Vec<f32>,
    pub colliders: Vec<[f32; 4]>,
    pub placed: usize,
}

/// Persistent generator state: the world, the asset variant cache and glyphs.
pub struct World {
    pub gen: WorldGen,
    lib: Library,
    glyphs: Glyphs,
    pub day: bool,
}

impl World {
    pub fn new(seed: u32, day: bool) -> World {
        World { gen: WorldGen::new(seed), lib: Library::new(seed), glyphs: Glyphs::new(), day }
    }

    fn sky(&self) -> Sky {
        Sky::new(self.gen.seed, if self.day { &DAY } else { &DUSK })
    }

    /// Sky dome (centred on the camera by the shader), rain and blown leaves.
    pub fn sky_cards(&self, aspect: f32) -> Vec<f32> {
        let eye = Vec3::new(0.0, 2.0, 0.0);
        let view = View { eye, focus: eye, focal: FOCAL, near: 5.0 };
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, self.gen.seed as u64);
        landscape::sky_dome(&mut sk, &self.sky(), Vec3::ZERO, 900.0, &view, self.gen.seed);
        landscape::rain(&mut sk, 7000, self.gen.seed);
        landscape::drifting_leaves(&mut sk, 900, 90.0, &view, self.gen.seed);
        sk.cards
    }

    /// Far ground: the bare land of the `size` m tile (tx, tz), glyphs sized
    /// from `eye` (so few and large), no plants, trees or rocks. Lit by the
    /// sun and terrain shadows on a coarse grid; no physics.
    pub fn build_far_tile(&mut self, tx: i32, tz: i32, size: f32, eye: Vec3, aspect: f32) -> Vec<f32> {
        let w = &self.gen;
        let (x0, z0) = (tx as f32 * size, tz as f32 * size);
        let step = 4.0;
        let land = ChunkLand::region(w, x0 - 2.0 * step, z0 - 2.0 * step, size + 4.0 * step, step);
        let rect = [x0, z0, x0 + size, z0 + size];
        let view = View { eye, focus: eye, focal: FOCAL, near: 5.0 };
        let sun = sun_for(self.day);
        let glint = if self.day { [1.0, 0.98, 0.92] } else { [1.0, 0.86, 0.62] };
        let sky = self.sky();
        let seed = w.seed as u64 ^ 0xfa7 ^ ((tx as u64) << 32) ^ (tz as u32 as u64);
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, seed);
        let mut rng = Pcg32::new(seed, 0x960d);
        let flow = |x: f32, z: f32| w.flow(x, z);
        landscape::ground_region(&mut sk, &land, &|_, _| 0.0, &sky, &view, sun, glint, &mut rng, rect, Some(&flow));
        let gs = 16.0;
        let g = (size / gs) as usize + 1;
        let mut tvis = vec![1.0f32; g * g];
        for j in 0..g {
            for i in 0..g {
                let (x, z) = (x0 + i as f32 * gs, z0 + j as f32 * gs);
                let p = Vec3::new(x, land.height(x, z) + 0.1, z);
                let mut vis = 1.0f32;
                for t in [8.0, 18.0, 40.0, 90.0, 200.0] {
                    let q = p + sun * t;
                    vis = vis.min(smoothstep(-0.2 - 0.02 * t, 0.2 + 0.02 * t, q.y - w.height(q.x, q.z)));
                    if vis <= 0.0 {
                        break;
                    }
                }
                tvis[j * g + i] = vis;
            }
        }
        let terrain_sun = |p: Vec3| {
            let fx = ((p.x - x0) / gs).clamp(0.0, (g - 1) as f32 - 0.001);
            let fz = ((p.z - z0) / gs).clamp(0.0, (g - 1) as f32 - 0.001);
            let (i, j) = (fx as usize, fz as usize);
            let (tx, tz) = (fx - i as f32, fz - j as f32);
            (tvis[j * g + i] * (1.0 - tx) + tvis[j * g + i + 1] * tx) * (1.0 - tz) + (tvis[(j + 1) * g + i] * (1.0 - tx) + tvis[(j + 1) * g + i + 1] * tx) * tz
        };
        let occ = Occlusion::with_max_cells(&sk.occluders, 1.0e4);
        sk.light(&occ, sun, &terrain_sun, Some(eye));
        std::mem::take(&mut sk.cards)
    }

    /// Build chunk (cx, cz) with glyphs sized from `eye`.
    pub fn build_chunk(&mut self, cx: i32, cz: i32, eye: Vec3, aspect: f32) -> ChunkOut {
        let w = &self.gen;
        let land = ChunkLand::new(w, cx, cz);
        let (x0, z0) = (cx as f32 * CHUNK, cz as f32 * CHUNK);
        let rect = [x0, z0, x0 + CHUNK, z0 + CHUNK];
        let view = View { eye, focus: eye, focal: FOCAL, near: 5.0 };
        let sun = sun_for(self.day);
        let glint = if self.day { [1.0, 0.98, 0.92] } else { [1.0, 0.86, 0.62] };
        let sky = self.sky();

        let mut placed = Vec::new();
        scatter_rect(w, &land, &mut self.lib, eye, rect, false, &mut placed);
        let mut neighbours = Vec::new();
        let m = SHADOW_MARGIN;
        for r in [
            [x0 - m, z0 - m, x0 + CHUNK + m, z0],
            [x0 - m, z0 + CHUNK, x0 + CHUNK + m, z0 + CHUNK + m],
            [x0 - m, z0, x0, z0 + CHUNK],
            [x0 + CHUNK, z0, x0 + CHUNK + m, z0 + CHUNK],
        ] {
            scatter_rect(w, &land, &mut self.lib, eye, r, true, &mut neighbours);
        }

        let seed = w.seed as u64 ^ ((cx as u64) << 32) ^ (cz as u32 as u64);
        let mut sk = Skinner::new(&self.glyphs, 0.1, aspect, seed);
        let mut colliders = Vec::new();
        let mut trees = Vec::new();
        for p in &placed {
            let a = &self.lib.assets[p.asset];
            skin_placed(&mut sk, a, p.pl, &view);
            if let Some(c) = collider(a, p.kind, p.pl) {
                colliders.push(c);
            }
            if let Kind::Tree(_) = p.kind {
                let (lo, hi) = a.bounds();
                trees.push((p.pl.pos.x, p.pl.pos.z, ((hi.x - lo.x) * p.pl.scale * 0.45).max(1.5)));
            }
        }
        for p in &neighbours {
            let a = &self.lib.assets[p.asset];
            sk.add_occluders(a, p.pl);
            if let Kind::Tree(_) = p.kind {
                let (lo, hi) = a.bounds();
                trees.push((p.pl.pos.x, p.pl.pos.z, ((hi.x - lo.x) * p.pl.scale * 0.45).max(1.5)));
            }
        }
        let canopy = |x: f32, z: f32| trees.iter().map(|&(tx, tz, r)| fm::exp(-((x - tx).powi(2) + (z - tz).powi(2)) / (r * r))).fold(0.0, f32::max);
        let mut rng = Pcg32::new(seed, 0x960d);
        let flow = |x: f32, z: f32| w.flow(x, z);
        landscape::ground_region(&mut sk, &land, &canopy, &sky, &view, sun, glint, &mut rng, rect, Some(&flow));

        // Terrain shadows on a 4 m grid (hills shading valleys), then baked light.
        let step = 4.0;
        let g = (CHUNK / step) as usize + 1;
        let mut tvis = vec![1.0f32; g * g];
        for j in 0..g {
            for i in 0..g {
                let (x, z) = (x0 + i as f32 * step, z0 + j as f32 * step);
                let p = Vec3::new(x, land.height(x, z) + 0.1, z);
                let mut vis = 1.0f32;
                for t in [1.2, 3.5, 8.0, 18.0, 40.0, 90.0, 200.0] {
                    let q = p + sun * t;
                    vis = vis.min(smoothstep(-0.2 - 0.02 * t, 0.2 + 0.02 * t, q.y - w.height(q.x, q.z)));
                    if vis <= 0.0 {
                        break;
                    }
                }
                tvis[j * g + i] = vis;
            }
        }
        let terrain_sun = |p: Vec3| {
            let fx = ((p.x - x0) / step).clamp(0.0, (g - 1) as f32 - 0.001);
            let fz = ((p.z - z0) / step).clamp(0.0, (g - 1) as f32 - 0.001);
            let (i, j) = (fx as usize, fz as usize);
            let (tx, tz) = (fx - i as f32, fz - j as f32);
            (tvis[j * g + i] * (1.0 - tx) + tvis[j * g + i + 1] * tx) * (1.0 - tz) + (tvis[(j + 1) * g + i] * (1.0 - tx) + tvis[(j + 1) * g + i + 1] * tx) * tz
        };
        let occ = Occlusion::with_max_cells(&sk.occluders, 6.0e5);
        sk.light(&occ, sun, &terrain_sun, Some(eye));

        // Opaque body: the ground (2 m cells, sunk a little) plus near rocks / trunks.
        let mut body = Vec::new();
        let bs = 2.0;
        let bn = (CHUNK / bs) as usize;
        let at = |i: usize, j: usize| {
            let (x, z) = (x0 + i as f32 * bs, z0 + j as f32 * bs);
            Vec3::new(x, land.height(x, z) - 0.08, z)
        };
        for j in 0..bn {
            for i in 0..bn {
                let (a, b, c, d) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
                body.push([a, d, c]);
                body.push([a, c, b]);
            }
        }
        body.append(&mut sk.solids);

        ChunkOut { heights: land.physics_heights(), placed: placed.len(), cards: std::mem::take(&mut sk.cards), body, colliders }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{layout, STRIDE};

    /// Far tiles: bare ground, few large glyphs, fewer the farther.
    #[test]
    fn far_tiles_are_light() {
        let mut w = World::new(1, true);
        let eye = Vec3::new(0.0, 10.0, 0.0);
        let mut last = usize::MAX;
        for d in [3, 5, 8] {
            let t0 = std::time::Instant::now();
            let cards = w.build_far_tile(d, 0, 128.0, eye, 0.6);
            let n = cards.len() / STRIDE;
            eprintln!("far tile at {} m: {n} cards in {:?}", d * 128, t0.elapsed());
            assert!(n > 50 && n < 8000, "{n} cards");
            assert!(n <= last);
            last = n;
        }
    }

    #[test]
    fn terrain_is_seamless_varied_and_has_lakes() {
        let w = WorldGen::new(1);
        let (mut wet, mut lo, mut hi, n) = (0, f32::INFINITY, f32::NEG_INFINITY, 4000);
        for i in 0..n {
            let (x, z) = ((i % 63) as f32 * 61.0 - 1900.0, (i / 63) as f32 * 59.0 - 1900.0);
            let h = w.height(x, z);
            assert!(h.is_finite());
            wet += usize::from(h < WATER);
            lo = lo.min(h);
            hi = hi.max(h);
        }
        let frac = wet as f32 / n as f32;
        eprintln!("height {lo:.1}..{hi:.1}, water {:.0}%", frac * 100.0);
        assert!(frac > 0.02 && frac < 0.3, "water fraction {frac}");
        assert!(hi - lo > 40.0, "mountains somewhere");
        // Chunk caches agree with the world function at shared edges.
        let (a, b) = (ChunkLand::new(&w, 3, 5), ChunkLand::new(&w, 4, 5));
        let x = 4.0 * CHUNK;
        for k in 0..10 {
            let z = 5.0 * CHUNK + k as f32 * 3.1;
            assert!((a.height(x, z) - b.height(x, z)).abs() < 1e-3);
            assert!((a.height(x, z) - w.height(x, z)).abs() < 0.05);
        }
    }

    #[test]
    fn scattering_is_deterministic_regardless_of_who_builds_it() {
        let w = WorldGen::new(2);
        let land = ChunkLand::new(&w, 0, 0);
        let mut lib = Library::new(2);
        let eye = Vec3::new(16.0, 5.0, 16.0);
        let (mut a, mut b) = (Vec::new(), Vec::new());
        scatter_rect(&w, &land, &mut lib, eye, [0.0, 0.0, CHUNK, CHUNK], true, &mut a);
        scatter_rect(&w, &land, &mut lib, eye, [0.0, 0.0, CHUNK, CHUNK], true, &mut b);
        assert_eq!(a.len(), b.len());
        for (p, q) in a.iter().zip(&b) {
            assert_eq!(p.pl.pos, q.pl.pos);
            assert_eq!(p.kind, q.kind);
        }
    }

    #[test]
    fn chunks_build_with_detail_falling_off_with_distance() {
        let mut world = World::new(3, false);
        let eye = Vec3::new(16.0, world.gen.height(16.0, 16.0) + 1.7, 16.0);
        let t = std::time::Instant::now();
        let near = world.build_chunk(0, 0, eye, 0.64);
        let far = world.build_chunk(6, 0, eye, 0.64);
        eprintln!("near {} cards ({} placed), far {} cards ({} placed), {} ms", near.cards.len() / STRIDE, near.placed, far.cards.len() / STRIDE, far.placed, t.elapsed().as_millis());
        for c in [&near, &far] {
            assert!(c.cards.iter().all(|v| v.is_finite()));
            assert_eq!(c.heights.len(), (GRID + 1) * (GRID + 1));
            assert!(!c.body.is_empty());
        }
        assert!(near.cards.len() > far.cards.len() * 2, "far chunks use bigger, fewer glyphs");
        let ground = near.cards.chunks_exact(STRIDE).filter(|c| (c[layout::GLYPH] as u32 / 1024) / 64 == 7).count();
        assert!(ground > 1000);
        let sky = world.sky_cards(0.64);
        assert!(sky.len() / STRIDE > 20_000);
    }
}

