//! Skinning: asset primitives -> ASCII cards. Port of `scenery/skin.py`,
//! adapted to a free-orbit camera (the Python version builds cards for one
//! fixed view):
//!
//! * sprites without a plane, and thin wood chains, become shader billboards
//!   (they turn round their axis to face the viewer every frame);
//! * bark is wrapped round the whole trunk, not only the visible half;
//! * solid surfaces (rock, bark) are flagged so the shader drops their back
//!   faces, and they also add triangles to an opaque body that hides
//!   whatever is behind them.
//!
//! One rule from the original drives sizes: a character is about `g` metres
//! tall (the gallery picks `g` so that is ~15 px at its viewing distance).
//! Smaller sprites are enlarged and thinned out, bigger ones split.
use crate::fm;

use super::asset::{basis, smoothstep, unit, Asset, Placement, RngExt, UP};
use super::style::{charset, Bark, Mat, Pattern, MATERIALS, MID_CHARS};
use crate::cards::{layout, write3, MATERIAL_SHIFT, STRIDE};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::{PI, TAU};

/// Per-card shader behaviour, packed above the material id.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CardMode {
    /// Fixed orientation (lies in a plane), two-sided.
    Fixed = 0,
    /// Turns round its V axis to face the viewer.
    BillboardV = 1,
    /// Turns round its U axis to face the viewer.
    BillboardU = 2,
    /// Fixed, opaque surface: back faces are not drawn.
    Solid = 3,
    /// Final colour in the card (sky, water): no lighting, optional haze.
    Emissive = 4,
    /// Rain streak: the shader moves it down (and with the wind) in a box
    /// that follows the camera. Position = seed inside that box.
    Rain = 5,
    /// Blowing leaf: the shader carries it along the wind, tumbling.
    Drift = 6,
    /// Ground mark stored flat on the surface (U x V = surface normal); the
    /// shader tilts it toward the *current* camera every frame so glyphs
    /// never flatten into slivers or sink into the ground, from any angle.
    /// Lit with the true surface normal.
    GroundLean = 7,
    /// Water glyph stored flat (U x V = up, U = flow direction); the shader
    /// tilts it 35-60 degrees toward the current camera. Colour as given.
    WaterLean = 8,
}

/// Material ids fit below this (the shader table has 64 rows).
pub const MAX_MATERIALS: u32 = 64;

pub fn pack(glyph: u32, mat: Mat, mode: CardMode) -> f32 {
    (glyph + MATERIAL_SHIFT * (mat as u32 + MAX_MATERIALS * mode as u32)) as f32
}

struct Picker {
    ids: Vec<u32>,
    cdf: Vec<f32>,
}

impl Picker {
    fn new(chars: &str, weights: Option<&[f32]>, index: &[u32; 128]) -> Picker {
        let ids: Vec<u32> = chars.chars().map(|c| index[c as usize]).collect();
        let mut acc = 0.0;
        let cdf = (0..ids.len()).map(|i| {
            acc += weights.map_or(1.0, |w| w[i]);
            acc
        });
        Picker { cdf: cdf.collect(), ids }
    }

    fn pick(&self, rng: &mut Pcg32) -> u32 {
        let t = rng.next_f32() * self.cdf[self.cdf.len() - 1];
        self.ids[self.cdf.partition_point(|&c| c <= t).min(self.ids.len() - 1)]
    }
}

/// Character pickers for every material and bark part, indexing `charset()`.
pub struct Glyphs {
    pub charset: String,
    index: [u32; 128],
    mats: Vec<Picker>,
    barks: Vec<[Picker; 4]>,
    mid: Picker,
}

impl Default for Glyphs {
    fn default() -> Self {
        Self::new()
    }
}

impl Glyphs {
    pub fn new() -> Glyphs {
        let cs = charset();
        let mut index = [0u32; 128];
        for (i, c) in cs.chars().enumerate() {
            index[c as usize] = i as u32;
        }
        Glyphs {
            mats: MATERIALS.iter().map(|m| Picker::new(m.chars, m.weights, &index)).collect(),
            barks: Bark::ALL
                .iter()
                .map(|b| {
                    let d = b.def();
                    [d.plate, d.mid, d.fissure, d.upper].map(|s| Picker::new(s, None, &index))
                })
                .collect(),
            mid: Picker::new(MID_CHARS, None, &index),
            index,
            charset: cs,
        }
    }
}

/// Bark pattern in cylinder coordinates (arc length x height).
struct BarkPattern {
    grid: Vec<f32>,
    seed: u64,
}

const G: usize = 256;

impl BarkPattern {
    fn new(rng: &mut Pcg32) -> BarkPattern {
        let raw: Vec<f32> = (0..G * G).map(|_| rng.next_f32()).collect();
        let k = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]; // gaussian sigma 0.8
        let mut tmp = vec![0.0; G * G];
        let mut grid = vec![0.0; G * G];
        for y in 0..G {
            for x in 0..G {
                tmp[y * G + x] = (0..5).map(|i| k[i] * raw[y * G + (x + G + i - 2) % G]).sum();
            }
        }
        for y in 0..G {
            for x in 0..G {
                grid[y * G + x] = (0..5).map(|i| k[i] * tmp[((y + G + i - 2) % G) * G + x]).sum();
            }
        }
        let (lo, hi) = grid.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), &v| (a.min(v), b.max(v)));
        grid.iter_mut().for_each(|v| *v = (*v - lo) / (hi - lo).max(1e-6));
        BarkPattern { grid, seed: rng.next_u32() as u64 }
    }

    fn n(&self, a: f32, b: f32) -> f32 {
        let (a, b) = (a.rem_euclid(G as f32), b.rem_euclid(G as f32));
        let (ia, ib) = (a as usize, b as usize);
        let (fa, fb) = (a - ia as f32, b - ib as f32);
        let g = |x: usize, y: usize| self.grid[(x % G) * G + (y % G)];
        (g(ia, ib) * (1.0 - fb) + g(ia, ib + 1) * fb) * (1.0 - fa) + (g(ia + 1, ib) * (1.0 - fb) + g(ia + 1, ib + 1) * fb) * fa
    }

    fn worley_edge(&self, a: f32, b: f32, cw: f32, ch: f32) -> f32 {
        let (ia, ib) = ((a / cw).floor() as i64, (b / ch).floor() as i64);
        let (mut f1, mut f2) = (9.0f32, 9.0f32);
        for da in -1..=1 {
            for db in -1..=1 {
                let (ca, cb) = (ia + da, ib + db);
                let mut h = (ca as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (cb as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ self.seed;
                h ^= h >> 33;
                h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
                h ^= h >> 33;
                let (jx, jy) = ((h & 0xFFFF) as f32 / 65535.0, ((h >> 16) & 0xFFFF) as f32 / 65535.0);
                let d = fm::hypot((a - (ca as f32 + jx) * cw) / cw, (b - (cb as f32 + jy) * ch) / ch);
                if d < f1 {
                    f2 = f1;
                    f1 = d;
                } else if d < f2 {
                    f2 = d;
                }
            }
        }
        f2 - f1
    }

    /// Part (0 plate, 1 mid, 2 fissure, 3 upper) and albedo.
    fn sample(&self, bark: Bark, arc: f32, y: f32, rel_h: f32) -> (usize, [f32; 3]) {
        let b = bark.def();
        let (fiss, raised) = match b.pattern {
            Pattern::Plates => {
                let e = self.worley_edge(arc + 0.02 * (self.n(arc * 20.0, y * 5.0) - 0.5), y, 0.075, 0.24);
                (e < 0.12 + 0.12 * self.n(arc * 12.0 + 7.0, y * 2.5), e > 0.45)
            }
            Pattern::Scales => {
                let e = self.worley_edge(arc, y, 0.06, 0.07);
                (e < 0.1, e > 0.4)
            }
            Pattern::Bands => {
                let thr = 0.62 - if rel_h < 0.12 { 0.25 } else { 0.0 };
                let dash = self.n(arc * 4.0 + 3.0, y * 30.0) > thr;
                (dash, !dash)
            }
            Pattern::Ridges => {
                let w = self.n(arc * 14.0 + 2.0 * self.n(arc * 3.0, y * 0.8), y * 1.2);
                ((w - 0.5).abs() < 0.09, (w - 0.5).abs() > 0.25)
            }
        };
        let mut part = if fiss { 2 } else if raised { 0 } else { 1 };
        let upper = rel_h + 0.1 * (self.n(arc * 5.0, y * 1.5) - 0.5) > b.upper_from;
        if upper && (b.pattern != Pattern::Plates || part != 2) {
            part = 3;
        }
        let mott = 0.8 + 0.4 * self.n(arc * 40.0 + 90.0, y * 16.0);
        let base = match part {
            2 => b.alb_fissure,
            3 => b.alb_upper,
            _ => b.alb_plate,
        };
        let f = mott * if part == 1 { 0.85 } else { 1.0 };
        (part, base.map(|c| c * f))
    }
}

/// Opaque cores inside thick trunks (off: see `skin_wood`).
const TRUNK_CORES: bool = false;

pub struct Skinner<'a> {
    /// Glyph height in metres.
    pub g: f32,
    pub aspect: f32,
    glyphs: &'a Glyphs,
    rng: Pcg32,
    bark: BarkPattern,
    pub cards: Vec<f32>,
    pub solids: Vec<[Vec3; 3]>,
    pub occluders: Vec<(Vec3, f32)>,
    foliage: Vec<usize>,
    /// Add opaque bodies (rock meshes, trunk tubes) for the next objects.
    pub solids_on: bool,
    /// The next pushed foliage card is a thinned stand-in: no shadow ramp.
    no_ramp: bool,
}

/// Opacity of one card that stands in for `n` cards of opacity `a`
/// (the chance that at least one of them would have covered a point).
pub fn opaque(a: f32, n: f32) -> f32 {
    (1.0 - fm::powf(1.0 - a.clamp(0.0, 1.0), n.max(1.0))).min(1.0)
}

impl<'a> Skinner<'a> {
    pub fn new(glyphs: &'a Glyphs, g: f32, aspect: f32, seed: u64) -> Skinner<'a> {
        let mut rng = Pcg32::new(seed, 0x5c1e);
        let bark = BarkPattern::new(&mut rng);
        Skinner { g, aspect, glyphs, rng, bark, cards: Vec::new(), solids: Vec::new(), occluders: Vec::new(), foliage: Vec::new(), solids_on: true, no_ramp: false }
    }

    pub fn card_count(&self) -> usize {
        self.cards.len() / STRIDE
    }

    #[allow(clippy::too_many_arguments)]
    pub fn push(&mut self, c: Vec3, u: Vec3, v: Vec3, alb: [f32; 3], alpha: f32, glyph: u32, mat: Mat, mode: CardMode) {
        if mat.is_crown_foliage() && !self.no_ramp {
            self.foliage.push(self.card_count());
        }
        let start = self.cards.len();
        self.cards.resize(start + STRIDE, 0.0);
        let card = &mut self.cards[start..];
        write3(card, layout::CENTER, c);
        write3(card, layout::U, u);
        write3(card, layout::V, v);
        card[layout::COLOR..layout::COLOR + 3].copy_from_slice(&alb);
        card[layout::COLOR + 3] = alpha.clamp(0.0, 1.0);
        card[layout::GLYPH] = pack(glyph, mat, mode);
        card[layout::LIGHT] = 1.0;
        card[layout::LIGHT + 1] = 1.0;
    }

    fn albedo(&mut self, mat: Mat, tint: f32) -> [f32; 3] {
        let m = mat.def();
        let f = (1.0 + m.var * self.rng.normal()) * tint;
        m.albedo.map(|c| (c * f).clamp(0.005, 1.5))
    }

    fn alpha(&mut self, mat: Mat) -> f32 {
        mat.def().alpha.0 + 0.08 * self.rng.next_f32()
    }

    /// A character for `mat`, from its charset and weights.
    pub fn glyph(&mut self, mat: Mat) -> u32 {
        self.glyphs.mats[mat as usize].pick(&mut self.rng)
    }

    /// Character budget for one object (the original's per-screen-cell
    /// budget, applied per object so it survives orbiting): keep at most
    /// `cap` of the cards added since `start`, a random subset, and grow the
    /// kept foliage a little so the silhouette stays filled.
    pub fn cap_since(&mut self, start: usize, cap: usize) {
        let n = self.card_count() - start;
        if n <= cap || cap == 0 {
            return;
        }
        for i in 0..cap {
            let j = i + self.rng.below((n - i) as u32) as usize;
            if i != j {
                for k in 0..STRIDE {
                    self.cards.swap((start + i) * STRIDE + k, (start + j) * STRIDE + k);
                }
            }
        }
        self.cards.truncate((start + cap) * STRIDE);
        let r = n as f32 / cap as f32;
        let grow = fm::powf(r, 0.25).min(1.6);
        // Foliage keeps the area it covered: half as many leaves, sqrt(2) as big.
        let grow_leaf = r.sqrt().min(2.2);
        let keep_ramp = r < 1.5;
        self.foliage.retain(|&i| i < start);
        for i in start..start + cap {
            let base = i * STRIDE;
            let high = self.cards[base + layout::GLYPH] as u32 / MATERIAL_SHIFT;
            let (mat, mode) = (high % MAX_MATERIALS, high / MAX_MATERIALS);
            let leaf = Mat::ALL[mat as usize].is_crown_foliage();
            if mode != CardMode::Solid as u32 && mode < CardMode::GroundLean as u32 {
                let gr = if leaf { grow_leaf } else { grow };
                for k in layout::U..layout::V + 3 {
                    self.cards[base + k] *= gr;
                }
            }
            if leaf {
                let a = &mut self.cards[base + layout::COLOR + 3];
                *a = opaque(*a, r);
                if keep_ramp {
                    self.foliage.push(i);
                }
            }
        }
    }

    /// Only the shadow-casting part of an asset (for objects just outside
    /// a chunk, whose shadows fall into it): no cards.
    pub fn add_occluders(&mut self, asset: &Asset, pl: Placement) {
        for s in &asset.sprites {
            let size = s.size * pl.scale;
            let f = match s.mat {
                Mat::NeedlePine | Mat::NeedleSpruce | Mat::NeedleJuniper => 1.25,
                Mat::GrassBlade | Mat::GrassTall => 0.4,
                _ => 1.0,
            };
            self.occluders.push((pl.point(s.pos), size * size * 0.6 * f));
        }
        for s in &asset.surfels {
            let sp = s.spacing * pl.scale;
            self.occluders.push((pl.point(s.pos), sp * sp * 4.0));
        }
        for w in &asset.wood {
            let (p0, p1, r) = (pl.point(w.p0), pl.point(w.p1), w.r * pl.scale);
            if r > 0.015 {
                let len = (p1 - p0).length();
                let cnt = (len / 0.15).ceil().max(1.0) as usize;
                for k in 0..cnt {
                    self.occluders.push((p0 + (p1 - p0) * ((k as f32 + 0.5) / cnt as f32), 2.0 * r * len / cnt as f32 * 1.5));
                }
            }
        }
    }

    /// Atlas index of one specific character (it must be in the charset).
    pub fn glyph_for_char(&self, c: char) -> u32 {
        self.glyphs.index[(c as usize).min(127)]
    }

    fn any_perp(&mut self, a: Vec3) -> Vec3 {
        let r = if a.y.abs() > 0.9 { Vec3::X } else { UP };
        unit(a.cross(r))
    }

    /// Skin one placed copy of an asset.
    pub fn skin(&mut self, asset: &Asset, pl: Placement) {
        self.skin_sprites(asset, pl);
        self.skin_surfels(asset, pl);
        self.skin_wood(asset, pl);
        if self.solids_on {
            for t in &asset.solids {
                self.solids.push(t.map(|p| pl.point(p)));
            }
        }
    }

    fn skin_sprites(&mut self, asset: &Asset, pl: Placement) {
        for s in &asset.sprites {
            let (pos, axis, nrm, size) = (pl.point(s.pos), pl.dir(s.axis), pl.dir(s.normal), s.size * pl.scale);
            let md = s.mat.def();
            let f = match s.mat {
                Mat::NeedlePine | Mat::NeedleSpruce | Mat::NeedleJuniper => 1.25,
                Mat::GrassBlade | Mat::GrassTall => 0.4,
                Mat::FlowerYellow | Mat::FlowerWhite | Mat::FlowerPurple | Mat::FlowerRed => 0.3,
                _ => 1.0,
            };
            self.occluders.push((pos, size * size * 0.6 * f));
            if axis == Vec3::ZERO {
                continue;
            }
            let g = self.g * md.size;
            let k = (0.85 * g / size).max(1.0); // far: enlarge ...
            if self.rng.next_f32() >= 1.0 / fm::powf(k, md.keep) {
                continue; // ... and thin out
            }
            let reps = ((size / (1.5 * g)).powi(2).round() as usize).clamp(1, 9); // near: split
            let has_n = nrm.length() > 0.5;
            for _ in 0..reps {
                let sz = size * k / (reps as f32).sqrt();
                let side = if has_n { unit(axis.cross(nrm)) } else { Vec3::ZERO };
                let side = if side == Vec3::ZERO { self.any_perp(axis) } else { side };
                let mut c = pos;
                if reps > 1 {
                    let (ja, js) = (self.rng.uniform(-1.0, 1.0), self.rng.uniform(-1.0, 1.0));
                    c += (axis * ja + side * js) * (size * 0.35);
                }
                let (u, mode) = if has_n {
                    let tw = self.rng.gauss(0.15);
                    (side * fm::cos(tw) + axis.cross(side) * fm::sin(tw), CardMode::Fixed)
                } else {
                    (side, CardMode::BillboardV)
                };
                let alb = self.albedo(s.mat, pl.tint);
                // Fewer leaves -> each one more opaque (and no light "shade"
                // glyphs), so a thinned crown keeps its body.
                let thin = s.thin * fm::powf(k, md.keep);
                let alpha = opaque(self.alpha(s.mat), thin);
                let glyph = self.glyph(s.mat);
                self.no_ramp = thin > 1.5;
                self.push(c, u * (sz * self.aspect), axis * sz, alb, alpha, glyph, s.mat, mode);
                self.no_ramp = false;
            }
        }
    }

    fn skin_surfels(&mut self, asset: &Asset, pl: Placement) {
        for s in &asset.surfels {
            let (pos, nrm, sp) = (pl.point(s.pos), pl.dir(s.normal), s.spacing * pl.scale);
            let md = s.mat.def();
            let w = if matches!(s.mat, Mat::Bigleaf | Mat::BigleafBlue | Mat::BigleafDark | Mat::BigleafEdge | Mat::Midrib | Mat::MidribRed) {
                1.0
            } else {
                4.0
            };
            self.occluders.push((pos, sp * sp * w));
            let gw = self.g * md.size;
            let p_keep = ((sp / (0.55 * gw)).powi(2) * md.dens).clamp(0.0, 1.0);
            if self.rng.next_f32() >= p_keep {
                continue;
            }
            let n = unit(nrm + self.rng.gauss3(0.15));
            let n = if n == Vec3::ZERO { UP } else { n };
            let (b1, b2) = basis(n);
            let ang = self.rng.uniform(0.0, TAU);
            let ud = b1 * fm::cos(ang) + b2 * fm::sin(ang);
            let vd = n.cross(ud);
            let sz = gw.max(sp * 1.4);
            let c = pos + nrm * (0.002 + 0.01 * sz);
            let mode = if md.solid { CardMode::Solid } else { CardMode::Fixed };
            let alb = self.albedo(s.mat, pl.tint);
            let alpha = self.alpha(s.mat);
            let glyph = self.glyph(s.mat);
            self.push(c, ud * (sz * self.aspect), vd * sz, alb, alpha, glyph, s.mat, mode);
        }
    }

    fn skin_wood(&mut self, asset: &Asset, pl: Placement) {
        let height = asset.height();
        let g = self.g;
        let aspect = self.aspect;
        let y_base = pl.pos.y;
        for w in &asset.wood {
            let (p0, p1, r) = (pl.point(w.p0), pl.point(w.p1), w.r * pl.scale);
            let len = (p1 - p0).length();
            if len < 1e-6 {
                continue;
            }
            let t = unit(p1 - p0);
            if r > 0.015 {
                let cnt = (len / 0.15).ceil().max(1.0) as usize;
                for k in 0..cnt {
                    let q = p0 + (p1 - p0) * ((k as f32 + 0.5) / cnt as f32);
                    self.occluders.push((q, 2.0 * r * len / cnt as f32 * 1.5));
                }
            }
            // Fine twigs sit inside the foliage, which hides them (the original
            // pine drew none); thin ones much smaller than a glyph neither.
            if w.level >= 3 || (w.level == 2 && 2.0 * r < g * 0.35) {
                continue;
            }
            let rel_h = w.p0.y.max(0.0) / height;
            let bark = w.bark.def();
            if 2.0 * r <= 1.6 * g * aspect {
                // Thin wood: a chain of cards along the branch.
                let thick = 2.0 * r > 0.35 * g;
                let mat = if thick { bark.branch } else { bark.twig };
                let md = mat.def();
                let h = (if thick { g * 0.95 } else { g * 0.8 }).max(2.0 * r * 1.3) * md.size;
                let step = h * aspect * if thick { 0.85 } else { 1.25 };
                let cnt = (len / step).ceil().max(1.0) as usize;
                for k in 0..cnt {
                    let c = p0 + (p1 - p0) * ((k as f32 + 0.5) / cnt as f32);
                    let hh = h * self.rng.uniform(0.9, 1.1);
                    let side = self.any_perp(t);
                    if w.level == 0 {
                        // A trunk too thin to wrap still shows its own bark (white birch).
                        let fis = self.rng.chance(0.25);
                        let glyph = self.glyphs.barks[w.bark as usize][if fis { 2 } else { 0 }].pick(&mut self.rng);
                        let alb = (if fis { bark.alb_fissure } else { bark.alb_plate }).map(|c| c * pl.tint);
                        let alpha = self.alpha(Mat::Bark);
                        self.push(c, side * (hh * aspect), t * hh, alb, alpha, glyph, Mat::Bark, CardMode::BillboardV);
                    } else {
                        let alb = self.albedo(mat, pl.tint);
                        let alpha = self.alpha(mat);
                        let glyph = self.glyph(mat);
                        if md.axis_v {
                            self.push(c, side * (hh * aspect), t * hh, alb, alpha, glyph, mat, CardMode::BillboardV);
                        } else {
                            self.push(c, t * (hh * aspect), side * hh, alb, alpha, glyph, mat, CardMode::BillboardU);
                        }
                    }
                }
                continue;
            }
            // Trunk-thick wood: cards wrapped round the cylinder, characters
            // from the bark pattern in cylinder coordinates.
            let rows = (len / (g * 0.75)).ceil().max(1.0) as usize;
            let around = (TAU * r / (g * aspect * 0.7)).ceil() as usize + 1;
            let f0 = {
                let x = unit(Vec3::X - t * t.x);
                if x == Vec3::ZERO { unit(Vec3::Z - t * t.z) } else { x }
            };
            let s0 = t.cross(f0);
            for row in 0..rows {
                for col in 0..around {
                    let tt = (row as f32 + self.rng.uniform(0.1, 0.9)) / rows as f32;
                    let phi = (col as f32 + self.rng.uniform(0.15, 0.85)) / around as f32 * TAU;
                    let a = p0 + (p1 - p0) * tt;
                    let nrm = f0 * fm::cos(phi) + s0 * fm::sin(phi);
                    let c = a + nrm * (r * (1.0 + self.rng.uniform(0.0, 0.05)));
                    let rot = self.rng.gauss(0.15);
                    let tang = t.cross(nrm);
                    let ud = unit(tang * fm::cos(rot) + t * fm::sin(rot) + nrm * self.rng.gauss(0.25));
                    let vd = unit(-tang * fm::sin(rot) + t * fm::cos(rot) + nrm * self.rng.gauss(0.25));
                    let hh = g * self.rng.uniform(0.9, 1.1);
                    let arc = (phi - PI) * r;
                    let (part, alb) = self.bark.sample(w.bark, arc, c.y, rel_h);
                    let glyph = self.glyphs.barks[w.bark as usize][part].pick(&mut self.rng);
                    let dim = 0.7 + 0.3 * smoothstep(0.0, 0.8, c.y - y_base);
                    let alpha = self.alpha(Mat::Bark);
                    self.push(c, ud * (hh * aspect), vd * hh, alb.map(|x| x * pl.tint * dim), alpha, glyph, Mat::Bark, CardMode::Solid);
                }
            }
            // Inner layer: dense, darker glyphs behind the bark, so the wood
            // reads opaque in characters rather than through a black core.
            // Thicker wood gets more of it: none at the wrapping threshold,
            // a full layer from about 2.5 times that.
            let core = smoothstep(1.6 * g * aspect, 4.0 * g * aspect, 2.0 * r);
            if core > 0.0 {
                let ri = r * 0.72;
                let around_i = (TAU * ri / (g * aspect * 0.8)).ceil() as usize + 1;
                let bark_def = w.bark.def();
                for row in 0..rows {
                    for col in 0..around_i {
                        if !self.rng.chance(core) {
                            continue;
                        }
                        let tt = (row as f32 + self.rng.uniform(0.1, 0.9)) / rows as f32;
                        let phi = (col as f32 + self.rng.uniform(0.15, 0.85)) / around_i as f32 * TAU;
                        let a = p0 + (p1 - p0) * tt;
                        let nrm = f0 * fm::cos(phi) + s0 * fm::sin(phi);
                        let c = a + nrm * ri;
                        let tang = t.cross(nrm);
                        let hh = g * self.rng.uniform(0.95, 1.15);
                        let glyph = self.glyphs.barks[w.bark as usize][0].pick(&mut self.rng);
                        let mix = self.rng.uniform(0.3, 0.6);
                        let alb: [f32; 3] = std::array::from_fn(|k| (bark_def.alb_plate[k] * mix + bark_def.alb_fissure[k] * (1.0 - mix)) * pl.tint);
                        let dim = 0.6 + 0.3 * smoothstep(0.0, 0.8, c.y - y_base);
                        let alpha = self.alpha(Mat::Bark);
                        self.push(c, tang * (hh * aspect), t * hh, alb.map(|x| x * dim), alpha, glyph, Mat::Bark, CardMode::Solid);
                    }
                }
            }
            // An opaque tube inside would hide what is behind the trunk, but
            // it reads as a black block between the bark glyphs, unlike
            // anything else on screen: the inner layer stands for it.
            if self.solids_on && w.level == 0 && TRUNK_CORES {
                self.tube(p0, p1, t, r * 0.9, 8);
            }
        }
    }

    #[allow(dead_code)]
    /// An opaque open tube of `sides` faces from `p0` to `p1` (axis `t`).
    fn tube(&mut self, p0: Vec3, p1: Vec3, t: Vec3, r: f32, sides: usize) {
        let f0 = {
            let x = unit(Vec3::X - t * t.x);
            if x == Vec3::ZERO { unit(Vec3::Z - t * t.z) } else { x }
        };
        let s0 = t.cross(f0);
        for k in 0..sides {
            let (a0, a1) = (k as f32 / sides as f32 * TAU, (k + 1) as f32 / sides as f32 * TAU);
            let ring = |p: Vec3, a: f32| p + (f0 * fm::cos(a) + s0 * fm::sin(a)) * r;
            let (q00, q01, q10, q11) = (ring(p0, a0), ring(p0, a1), ring(p1, a0), ring(p1, a1));
            self.solids.push([q00, q01, q11]);
            self.solids.push([q00, q11, q10]);
        }
    }

    /// Fill in baked sun/sky visibility for every lit card (`extra_sun`
    /// multiplies the sun, e.g. terrain shadows), then shade crown foliage the
    /// ASCII way: deeply shaded leaves become light characters (fading out
    /// beyond 30-60 m from `eye`, where crowns need dense glyphs).
    pub fn light(&mut self, occ: &super::light::Occlusion, sun: Vec3, extra_sun: &dyn Fn(Vec3) -> f32, eye: Option<Vec3>) {
        let n = self.card_count();
        for i in 0..n {
            let card = &mut self.cards[i * STRIDE..(i + 1) * STRIDE];
            let mode = (card[layout::GLYPH] as u32 / MATERIAL_SHIFT) / MAX_MATERIALS;
            let lit = mode < CardMode::Emissive as u32 || mode == CardMode::GroundLean as u32;
            if !lit {
                continue;
            }
            let c = Vec3::new(card[0], card[1], card[2]);
            card[layout::LIGHT] = occ.sun(c, sun) * extra_sun(c);
            card[layout::LIGHT + 1] = occ.sky(c);
        }
        let foliage = std::mem::take(&mut self.foliage);
        for &i in &foliage {
            let base = i * STRIDE;
            if let Some(e) = eye {
                let c = Vec3::new(self.cards[base], self.cards[base + 1], self.cards[base + 2]);
                if !self.rng.chance(smoothstep(60.0, 30.0, (c - e).length())) {
                    continue;
                }
            }
            let ts = self.cards[base + layout::LIGHT];
            let t = ts + self.rng.uniform(-0.03, 0.03);
            let slot = self.cards[base + layout::GLYPH] as u32;
            let high = slot / MATERIAL_SHIFT;
            // Only the mid-weight ramp (: ; - ~ +): the dot glyphs read as
            // holes and made crowns look transparent.
            let swap = if t < 0.35 && self.rng.chance(0.3) { Some(self.glyphs.mid.pick(&mut self.rng)) } else { None };
            if let Some(g) = swap {
                self.cards[base + layout::GLYPH] = (g + high * MATERIAL_SHIFT) as f32;
                // Lift shaded colours so the sparse characters stay visible.
                for k in 0..3 {
                    self.cards[base + layout::COLOR + k] *= 1.25;
                }
            }
        }
        self.foliage = foliage;
    }
}

/// The material table for the shader: per material spec, shininess,
/// translucency, wrap, default billboard (0), twist, alpha range, haze.
/// Floats per material in `material_table`.
pub const MATERIAL_FLOATS: usize = 12;

/// Per material: spec, shininess, trans, wrap | billboard (0), twist,
/// alphaLit, haze (0) | wind flex, water flow, fog (haze applies), chain.
pub fn material_table() -> Vec<f32> {
    let mut out = Vec::with_capacity(MATERIALS.len() * MATERIAL_FLOATS);
    for (i, m) in MATERIALS.iter().enumerate() {
        let fog = if i == Mat::Sky as usize || i == Mat::Star as usize || i == Mat::Rain as usize { 0.0 } else { 1.0 };
        // Wood drawn as a chain of cards along a branch: a renderer that thins
        // cards with distance must thin these along one dimension only.
        let chain = f32::from(matches!(Mat::ALL[i], Mat::Bark | Mat::Twig | Mat::Branch | Mat::TwigBirch | Mat::TwigDead));
        out.extend_from_slice(&[m.spec, m.shin, m.trans, m.wrap, 0.0, 0.55, m.alpha.1 - m.alpha.0, 0.0, m.flex, m.flow, fog, chain]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenery::rocks::{make_rock, RockKind};
    use crate::scenery::trees::{make_tree, TreeKind};

    #[test]
    fn packing_round_trips() {
        let v = pack(87, Mat::FarTrunk, CardMode::Solid) as u32;
        assert_eq!(v % MATERIAL_SHIFT, 87);
        let hi = v / MATERIAL_SHIFT;
        assert_eq!(hi % MAX_MATERIALS, Mat::FarTrunk as u32);
        assert_eq!(hi / MAX_MATERIALS, 3);
        assert!(v < 1 << 24, "exact in f32");
    }

    #[test]
    fn skins_a_tree_and_a_rock_into_valid_cards() {
        let glyphs = Glyphs::new();
        let nglyph = glyphs.charset.chars().count() as u32;
        let mut sk = Skinner::new(&glyphs, 0.25, 0.64, 1);
        sk.skin(&make_tree(1, TreeKind::Oak), Placement::at(Vec3::ZERO));
        sk.skin(&make_tree(2, TreeKind::Spruce), Placement::at(Vec3::new(-8.0, 0.0, 0.0)));
        sk.skin(&make_rock(1, RockKind::Boulder), Placement { pos: Vec3::new(6.0, 0.0, 0.0), yaw: 1.0, scale: 1.2, tint: 0.9 });
        let occ = crate::scenery::light::Occlusion::new(&sk.occluders);
        sk.light(&occ, crate::scenery::light::sun_dir(), &|_| 1.0, None);
        assert!(sk.card_count() > 1000);
        assert!(!sk.solids.is_empty());
        let mut modes = [0usize; 4];
        for c in sk.cards.chunks_exact(STRIDE) {
            assert!(c.iter().all(|v| v.is_finite()));
            let slot = c[layout::GLYPH] as u32;
            assert!(slot % MATERIAL_SHIFT < nglyph);
            modes[(slot / MATERIAL_SHIFT / MAX_MATERIALS) as usize] += 1;
            assert!((0.0..=1.0).contains(&c[layout::LIGHT]) && (0.0..=1.0).contains(&c[layout::LIGHT + 1]));
        }
        assert!(modes.iter().all(|&m| m > 0), "every card mode used: {modes:?}");
        // The crown shades itself: some foliage is dark, some is lit.
        let ts: Vec<f32> = sk.cards.chunks_exact(STRIDE).map(|c| c[layout::LIGHT]).collect();
        assert!(ts.iter().any(|&t| t < 0.3) && ts.iter().any(|&t| t > 0.9));
    }
}
