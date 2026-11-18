//! Port of `pine_ascii(1).py`: the procedural pine, built out of ASCII cards.
//!
//! Same growth model (trunk, whorls of sagging primary branches, side shoots,
//! dead twigs, needle sprays), same voxel light model (needle density grid,
//! sun and sky transmittance by ray marching), same bark pattern (Worley plates
//! and fissures, flaky upper bark) and the grass/soil ground.
//!
//! Differences forced by a free-orbit camera instead of one fixed view:
//! * cards the script turned toward its camera (needles, twigs, grass) are
//!   marked as billboards and turned toward the viewer in the shader,
//! * the whole trunk is barked, not only the side facing the camera,
//! * the screen-space sky and far forest planes are left out.
//!
//! World units match the script: the tree is `TREE_H` = 10 tall, ground at y = 0.

use crate::cards::{layout, pack_glyph, write3, STRIDE};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::TAU;

pub const TREE_H: f32 = 10.0;
const DENS: f32 = 24.0; // needle-spray characters per unit of shoot length
const SIG_SUN: f32 = 1.1;
const SIG_SKY: f32 = 0.55;
const UP: Vec3 = Vec3::Y;

/// Low evening sun, front left (same as the script). The renderer must use
/// the same direction, see `sun_dir()`.
pub fn sun_dir() -> Vec3 {
    Vec3::new(-0.75, 0.33, 0.45).try_normalize().unwrap_or(Vec3::Y)
}

/// Material ids, decoded by the shader's material table.
pub mod material {
    pub const NEEDLE: u32 = 1;
    pub const TIP: u32 = 2;
    pub const WOOD: u32 = 3;
    pub const BARK: u32 = 4;
    pub const GRASS: u32 = 5;
    pub const SOIL: u32 = 6;
}

// ---- character sets (verbatim from the script) -------------------------------
const NEEDLE_CH: &str = "VYvy*WwXxKk|/\\li!^A";
const NEEDLE_P: [f32; 19] = [12., 10., 8., 6., 6., 4., 4., 3., 3., 2., 2., 6., 6., 6., 3., 3., 3., 4., 3.];
const TIP_CH: &str = "*+xX";
const WOOD_THICK: &str = "#=H%&8$";
const WOOD_THIN: &str = "-=~_";
const DEAD_CH: &str = "#%&=";
const BARK_PLATE: &str = "@#&8%BMW";
const BARK_MID: &str = "oO0=x";
const BARK_FISS: &str = "|!I:[]";
const BARK_UP: &str = "~-=szco<>";
const GRASS_CH: &str = "|/\\'\",;ivwVWYy^`";
const GRASS_P: [f32; 16] = [12., 9., 9., 6., 5., 4., 3., 5., 7., 6., 4., 2., 6., 4., 3., 2.];
const SOIL_CH: &str = ".,_-~=:;o";

const ALL_SETS: [&str; 11] =
    [NEEDLE_CH, TIP_CH, WOOD_THICK, WOOD_THIN, DEAD_CH, BARK_PLATE, BARK_MID, BARK_FISS, BARK_UP, GRASS_CH, SOIL_CH];

/// Every character the pine uses, unique, in first-seen order. The atlas must
/// be built from exactly this string so glyph indices line up.
pub fn charset() -> String {
    let mut out = String::new();
    for set in ALL_SETS {
        for c in set.chars() {
            if !out.contains(c) {
                out.push(c);
            }
        }
    }
    out
}

/// Character set -> atlas indices, with optional weights.
struct Picker {
    ids: Vec<u32>,
    cdf: Vec<f32>,
}

impl Picker {
    fn new(set: &str, all: &str, weights: Option<&[f32]>) -> Picker {
        let ids: Vec<u32> = set
            .chars()
            .map(|c| all.chars().position(|a| a == c).expect("charset covers every set") as u32)
            .collect();
        let mut acc = 0.0;
        let cdf = (0..ids.len())
            .map(|i| {
                acc += weights.map_or(1.0, |w| w[i]);
                acc
            })
            .collect();
        Picker { ids, cdf }
    }

    fn pick(&self, r: &mut Pcg32) -> u32 {
        let total = *self.cdf.last().unwrap_or(&1.0);
        let t = r.next_f32() * total;
        let i = self.cdf.partition_point(|&c| c <= t).min(self.ids.len() - 1);
        self.ids[i]
    }
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn unit(v: Vec3) -> Vec3 {
    v.try_normalize().unwrap_or(UP)
}

/// Any unit vector perpendicular to `v` (billboard cards re-orient it anyway).
fn any_perp(v: Vec3) -> Vec3 {
    let r = if v.y.abs() > 0.9 { Vec3::X } else { UP };
    unit(v.cross(r))
}

fn dir(e: f32, a: f32) -> Vec3 {
    Vec3::new(e.cos() * a.sin(), e.sin(), e.cos() * a.cos())
}

// ---- the tree -----------------------------------------------------------------
struct Seg {
    p0: Vec3,
    p1: Vec3,
    r: f32,
    level: u8,
    dead: bool,
}

struct Needle {
    p0: Vec3,
    p1: Vec3,
    tint: [f32; 2],
    young: bool,
}

pub struct Tree {
    rng: Pcg32,
    ph: [f32; 5],
    crown_base: f32,
    segs: Vec<Seg>,
    needles: Vec<Needle>,
    tips: Vec<(Vec3, Vec3)>,
}

impl Tree {
    pub fn grow(seed: u32) -> Tree {
        let mut rng = Pcg32::new(seed as u64, 0x7ee5);
        let ph = [0; 5].map(|_| rng.range(0.0, TAU));
        let crown_base = 2.8 + rng.range(-0.3, 0.3);
        let mut t = Tree { rng, ph, crown_base, segs: Vec::new(), needles: Vec::new(), tips: Vec::new() };
        t.grow_all();
        t
    }

    pub fn trunk_center(&self, y: f32) -> (f32, f32) {
        let t = y / TREE_H;
        let ph = self.ph;
        let x = t * (0.28 * (1.8 * t + ph[0]).sin() + 0.07 * (5.5 * t + ph[1]).sin());
        let z = t * (0.20 * (1.4 * t + ph[2]).sin());
        (x, z)
    }

    pub fn trunk_radius(&self, y: f32) -> f32 {
        let y = y.max(0.0);
        let t = (y / TREE_H).min(1.0);
        0.02 + 0.21 * (1.0 - t).powf(1.15) + 0.11 * (-y / 0.35).exp()
    }

    fn envelope(t: f32) -> f32 {
        0.3 + 2.75 * (1.0 - t).powf(0.85) * (0.8 + 0.2 * (t / 0.2).min(1.0))
    }

    fn uniform(&mut self, lo: f32, hi: f32) -> f32 {
        self.rng.range(lo, hi)
    }

    fn normal(&mut self, sd: f32) -> f32 {
        self.rng.normal() * sd
    }

    fn chance(&mut self, p: f32) -> bool {
        self.rng.next_f32() < p
    }

    fn grow_all(&mut self) {
        let mut whorls = Vec::new();
        let mut y = self.crown_base;
        while y < TREE_H - 0.45 {
            whorls.push(y);
            y += self.uniform(0.42, 0.75);
        }
        let span = TREE_H - self.crown_base;
        for yw in whorls {
            let t = (yw - self.crown_base) / span;
            let n = 4 + self.rng.below(4);
            let rot = self.uniform(0.0, TAU);
            for j in 0..n {
                if self.chance(if t < 0.12 { 0.3 } else { 0.1 }) {
                    continue;
                }
                let az = rot + TAU * j as f32 / n as f32 + self.normal(0.3);
                let yb = yw + self.uniform(-0.05, 0.05);
                let (cx, cz) = self.trunk_center(yb);
                let rad = self.trunk_radius(yb);
                let base = Vec3::new(cx + 0.7 * rad * az.sin(), yb, cz + 0.7 * rad * az.cos());
                let len = Self::envelope(t) * self.uniform(0.6, 1.18);
                self.primary(base, az, len, t);
            }
        }
        // Leader: a tuft of needles at the very top.
        let top: Vec<Vec3> = (0..7)
            .map(|i| {
                let y = TREE_H - 0.65 + 0.7 * i as f32 / 6.0;
                let (cx, cz) = self.trunk_center(y);
                Vec3::new(cx, y, cz)
            })
            .collect();
        self.add_needles(&top, 0.7);
        // Dead stubs on the bare lower trunk.
        let stubs = 3 + self.rng.below(4);
        for _ in 0..stubs {
            let yb = self.uniform(1.2, self.crown_base - 0.1);
            let az = self.uniform(0.0, TAU);
            let el = self.uniform(-0.3, 0.2);
            let len = self.uniform(0.1, 0.4);
            let (cx, cz) = self.trunk_center(yb);
            let rad = self.trunk_radius(yb);
            let mut pts = vec![Vec3::new(cx, yb, cz) + Vec3::new(az.sin(), 0.0, az.cos()) * (0.8 * rad)];
            for k in 1..4 {
                let e = el - 0.5 * k as f32 / 3.0;
                let last = pts[pts.len() - 1];
                pts.push(last + dir(e, az) * (len / 3.0));
            }
            let r0 = self.uniform(0.015, 0.026);
            self.add_wood(&pts, r0, 0.008, 1, true);
        }
    }

    fn primary(&mut self, base: Vec3, az: f32, len: f32, t: f32) {
        let e0 = -0.12 + 0.8 * t + self.normal(0.1);
        let sag = (0.6 * (1.0 - t) + 0.12) * self.uniform(0.7, 1.3);
        let upturn = self.uniform(0.3, 0.75);
        let n = ((len / 0.12) as usize).max(5);
        let mut pts = vec![base];
        let mut a = az;
        for i in 0..n {
            let s = (i as f32 + 0.5) / n as f32;
            let e = e0 - sag * s + upturn * s * s * s;
            a += self.normal(0.05);
            let last = pts[pts.len() - 1];
            pts.push(last + dir(e, a) * (len / n as f32));
        }
        self.add_wood(&pts, 0.022 + 0.022 * len / 2.5, 0.006, 1, false);
        self.children(&pts, len, 1);
        let fol = self.uniform(0.45, 0.7);
        self.add_needles(&pts, fol);
    }

    fn shoot(&mut self, p: Vec3, d0: Vec3, len: f32, level: u8, dead: bool) {
        let n = ((len / 0.1) as usize + 1).max(2);
        let mut pts = vec![p];
        let mut d = d0;
        for i in 0..n {
            let s = i as f32 / n as f32;
            let jitter = Vec3::new(self.normal(0.06), self.normal(0.06), self.normal(0.06));
            d = unit(d + Vec3::new(0.0, -0.07 * (1.0 - s) + 0.12 * s * s, 0.0) + jitter);
            let last = pts[pts.len() - 1];
            pts.push(last + d * (len / n as f32));
        }
        self.add_wood(&pts, 0.005 + 0.01 * len.min(1.0), 0.003, level, dead);
        if dead {
            return;
        }
        self.children(&pts, len, level);
        let fol = if level == 2 { len.min(self.uniform(0.3, 0.55)) } else { len };
        self.add_needles(&pts, fol);
    }

    fn add_wood(&mut self, pts: &[Vec3], r0: f32, r1: f32, level: u8, dead: bool) {
        let n = pts.len() - 1;
        for i in 0..n {
            let r = r0 + (r1 - r0) * (i as f32 + 0.5) / n as f32;
            self.segs.push(Seg { p0: pts[i], p1: pts[i + 1], r, level, dead });
        }
    }

    fn children(&mut self, pts: &[Vec3], len: f32, level: u8) {
        let (spacing, s_lo, s_hi) = match level {
            1 => ((0.1, 0.17), 0.25, 0.95),
            2 if len >= 0.25 => ((0.08, 0.14), 0.12, 0.9),
            _ => return,
        };
        let (segs, sl, cum) = polyline(pts);
        let mut pos = s_lo * len + self.uniform(0.0, spacing.1);
        while pos < s_hi * len {
            let s = pos / len;
            let i = locate(&cum, pos, segs.len());
            let p = pts[i] + segs[i] * ((pos - cum[i]) / sl[i]);
            let t = segs[i] * (1.0 / sl[i]);
            let sv0 = t.cross(UP).try_normalize().unwrap_or(Vec3::X);
            for sg in [-1.0f32, 1.0] {
                if self.chance(if level == 1 { 0.1 } else { 0.3 }) {
                    continue;
                }
                let roll = self.normal(0.55);
                let sv = sv0 * roll.cos() + t.cross(sv0) * roll.sin();
                let al = self.uniform(0.55, 1.05);
                let lift = self.uniform(-0.1, 0.35);
                let dc = unit(t * al.cos() + sv * (sg * al.sin()) + UP * lift);
                let (lc, dead) = if level == 1 {
                    let lc = len * 0.38 * (1.0 - s).powf(0.6) * (0.5 + 0.8 * s) * self.uniform(0.6, 1.15);
                    (lc, s < 0.42 && self.chance(0.55))
                } else {
                    (len * 0.55 * (1.0 - s).powf(0.7) * self.uniform(0.6, 1.1), false)
                };
                if lc > 0.08 {
                    self.shoot(p, dc, lc, level + 1, dead);
                }
            }
            if level == 1 && self.chance(0.25) {
                let dc = unit(t * 0.5 + UP * 0.85 + sv0 * self.normal(0.3));
                let lc = len * 0.25 * (1.0 - s) * self.uniform(0.6, 1.0);
                if lc > 0.1 {
                    self.shoot(p, dc, lc, level + 1, false);
                }
            }
            pos += self.uniform(spacing.0, spacing.1);
        }
    }

    fn add_needles(&mut self, pts: &[Vec3], fol: f32) {
        let (segs, sl, cum) = polyline(pts);
        let total = cum[cum.len() - 1];
        let fol = fol.min(total);
        let cnt = (DENS * fol + self.rng.next_f32()) as usize;
        let tint = [self.normal(1.0), self.normal(1.0)];
        for _ in 0..cnt {
            let x = self.rng.next_f32().powf(1.5);
            let u = total - fol * x;
            let i = locate(&cum, u, segs.len());
            let base = pts[i] + segs[i] * ((u - cum[i]) / sl[i]);
            let t = segs[i] * (1.0 / sl[i]);
            let reference = if t.y.abs() > 0.95 { Vec3::X } else { UP };
            let b1 = unit(t.cross(reference));
            let b2 = t.cross(b1);
            let psi = self.uniform(0.0, TAU);
            let al = self.uniform(0.55, 1.05) * (0.45 + 0.55 * (x / 0.15).min(1.0));
            let mut dv = t * al.cos() + (b1 * psi.cos() + b2 * psi.sin()) * al.sin();
            dv.y += 0.22;
            let dv = unit(dv);
            let ln = self.uniform(0.09, 0.15) * (1.0 - 0.2 * x);
            self.needles.push(Needle { p0: base, p1: base + dv * ln, tint, young: x < 0.12 });
        }
        let last = segs.len() - 1;
        self.tips.push((pts[pts.len() - 1], segs[last] * (1.0 / sl[last])));
    }
}

/// Segment vectors, lengths and cumulative lengths of a polyline.
fn polyline(pts: &[Vec3]) -> (Vec<Vec3>, Vec<f32>, Vec<f32>) {
    let segs: Vec<Vec3> = pts.windows(2).map(|w| w[1] - w[0]).collect();
    let sl: Vec<f32> = segs.iter().map(|s| s.length().max(1e-6)).collect();
    let mut cum = vec![0.0];
    for l in &sl {
        cum.push(cum[cum.len() - 1] + l);
    }
    (segs, sl, cum)
}

/// Index of the segment containing arc length `u` (numpy searchsorted - 1, clamped).
fn locate(cum: &[f32], u: f32, nseg: usize) -> usize {
    cum.partition_point(|&c| c <= u).saturating_sub(1).min(nseg - 1)
}

// ---- light: needle density in a voxel grid, transmittance by ray marching ------
struct Light {
    cell: f32,
    lo: Vec3,
    dims: [usize; 3],
    g: Vec<f32>,
}

impl Light {
    fn new(tree: &Tree) -> Light {
        let cell = 0.2;
        let pts: Vec<Vec3> = tree.needles.iter().map(|n| (n.p0 + n.p1) * 0.5).collect();
        let mut lo = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut hi = -lo;
        for &p in &pts {
            lo = lo.min(p);
            hi = hi.max(p);
        }
        // Extend down to the ground so the trunk can shadow it too.
        lo = Vec3::new(lo.x - 0.6, -0.2, lo.z - 0.6);
        hi += Vec3::new(0.6, 0.6, 0.6);
        let ext = hi - lo;
        let dims = [ext.x, ext.y, ext.z].map(|e| (e / cell).ceil() as usize + 1);
        let mut light = Light { cell, lo, dims, g: vec![0.0; dims[0] * dims[1] * dims[2]] };
        for p in pts {
            if let Some(i) = light.index(p) {
                light.g[i] += 1.0;
            }
        }
        light.blur(0.8);
        // Normalize so a typical dense patch of crown is ~1 (85th percentile).
        let max = light.g.iter().cloned().fold(0.0, f32::max);
        let mut vals: Vec<f32> = light.g.iter().cloned().filter(|&v| v > 0.02 * max).collect();
        if !vals.is_empty() {
            vals.sort_by(f32::total_cmp);
            let p85 = vals[((vals.len() - 1) as f32 * 0.85) as usize].max(1e-6);
            light.g.iter_mut().for_each(|v| *v /= p85);
        }
        // The trunk is opaque: add it so it shadows the ground and the crown behind it.
        let mut y = 0.0;
        while y < TREE_H {
            let (cx, cz) = tree.trunk_center(y);
            let r = tree.trunk_radius(y);
            let steps = (r / (cell * 0.5)).ceil() as i32;
            for a in -steps..=steps {
                for b in -steps..=steps {
                    let (dx, dz) = (a as f32 * cell * 0.5, b as f32 * cell * 0.5);
                    if dx * dx + dz * dz <= r * r {
                        if let Some(i) = light.index(Vec3::new(cx + dx, y, cz + dz)) {
                            light.g[i] = light.g[i].max(6.0);
                        }
                    }
                }
            }
            y += cell * 0.5;
        }
        light
    }

    fn index(&self, p: Vec3) -> Option<usize> {
        let q = (p - self.lo) * (1.0 / self.cell);
        let (x, y, z) = (q.x.floor(), q.y.floor(), q.z.floor());
        if x < 0.0 || y < 0.0 || z < 0.0 {
            return None;
        }
        let (x, y, z) = (x as usize, y as usize, z as usize);
        let [nx, ny, nz] = self.dims;
        (x < nx && y < ny && z < nz).then(|| (x * ny + y) * nz + z)
    }

    /// Separable Gaussian blur along each axis.
    fn blur(&mut self, sigma: f32) {
        let rad = (3.0 * sigma).ceil() as isize;
        let mut k: Vec<f32> = (-rad..=rad).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
        let sum: f32 = k.iter().sum();
        k.iter_mut().for_each(|v| *v /= sum);
        let [nx, ny, nz] = self.dims;
        let strides = [ny * nz, nz, 1];
        for axis in 0..3 {
            let n = self.dims[axis];
            let st = strides[axis];
            let src = self.g.clone();
            for x in 0..nx {
                for y in 0..ny {
                    for z in 0..nz {
                        let pos = [x, y, z][axis] as isize;
                        let i = (x * ny + y) * nz + z;
                        let mut acc = 0.0;
                        for (o, w) in (-rad..=rad).zip(&k) {
                            let q = pos + o;
                            if q >= 0 && (q as usize) < n {
                                acc += w * src[(i as isize + o * st as isize) as usize];
                            }
                        }
                        self.g[i] = acc;
                    }
                }
            }
        }
    }

    fn march(&self, p: Vec3, d: Vec3, steps: usize, step: f32, sigma: f32) -> f32 {
        let mut acc = 0.0;
        for k in 1..=steps {
            if let Some(i) = self.index(p + d * (k as f32 * step)) {
                acc += self.g[i];
            }
        }
        (-sigma * acc * step).exp()
    }

    fn sun(&self, p: Vec3) -> f32 {
        self.march(p, sun_dir(), 18, 0.2, SIG_SUN)
    }

    /// Long march for the ground: a low sun casts a long shadow.
    fn sun_far(&self, p: Vec3) -> f32 {
        self.march(p, sun_dir(), 90, 0.2, SIG_SUN)
    }

    fn sky(&self, p: Vec3) -> f32 {
        let dirs = [
            UP,
            Vec3::new(0.6, 0.8, 0.0),
            Vec3::new(-0.6, 0.8, 0.0),
            Vec3::new(0.0, 0.8, 0.6),
            Vec3::new(0.0, 0.8, -0.6),
        ];
        dirs.iter().map(|&d| self.march(p, d, 9, 0.3, SIG_SKY)).sum::<f32>() / dirs.len() as f32
    }
}

// ---- bark noise -----------------------------------------------------------------
struct NoiseGrid {
    n: usize,
    v: Vec<f32>,
}

impl NoiseGrid {
    /// Smoothed, normalized random grid (gaussian 0.6, wrapped) like the script's.
    fn new(rng: &mut Pcg32, n: usize) -> NoiseGrid {
        let raw: Vec<f32> = (0..n * n).map(|_| rng.next_f32()).collect();
        let k = [0.0385, 0.2415, 0.44, 0.2415, 0.0385]; // gaussian, sigma ~0.7
        let mut tmp = vec![0.0; n * n];
        let mut v = vec![0.0; n * n];
        for y in 0..n {
            for x in 0..n {
                tmp[y * n + x] = (0..5).map(|i| k[i] * raw[y * n + (x + n + i - 2) % n]).sum();
            }
        }
        for y in 0..n {
            for x in 0..n {
                v[y * n + x] = (0..5).map(|i| k[i] * tmp[((y + n + i - 2) % n) * n + x]).sum();
            }
        }
        let (lo, hi) = v.iter().fold((f32::INFINITY, f32::NEG_INFINITY), |(a, b), &x| (a.min(x), b.max(x)));
        v.iter_mut().for_each(|x| *x = (*x - lo) / (hi - lo).max(1e-6));
        NoiseGrid { n, v }
    }

    /// Smooth (cubic-weighted bilinear) lookup with wrap-around, coords in cells.
    fn at(&self, a: f32, b: f32) -> f32 {
        let n = self.n as f32;
        let (a, b) = (a.rem_euclid(n), b.rem_euclid(n));
        let (ia, ib) = (a.floor() as usize, b.floor() as usize);
        let (fa, fb) = (a - a.floor(), b - b.floor());
        let (fa, fb) = (fa * fa * (3.0 - 2.0 * fa), fb * fb * (3.0 - 2.0 * fb));
        let g = |x: usize, y: usize| self.v[(x % self.n) * self.n + (y % self.n)];
        let top = g(ia, ib) * (1.0 - fb) + g(ia, ib + 1) * fb;
        let bot = g(ia + 1, ib) * (1.0 - fb) + g(ia + 1, ib + 1) * fb;
        top * (1.0 - fa) + bot * fa
    }
}

/// Jitter of a Worley cell, from a hash so no table is needed.
fn cell_jitter(ca: i64, cb: i64, seed: u64) -> (f32, f32) {
    let mut h = (ca as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ (cb as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ seed;
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    ((h & 0xFFFF) as f32 / 65535.0, ((h >> 16) & 0xFFFF) as f32 / 65535.0)
}

/// Distances to the nearest and second-nearest cell point (in cell units).
fn worley(a: f32, b: f32, cw: f32, ch: f32, seed: u64) -> (f32, f32) {
    let (ia, ib) = ((a / cw).floor() as i64, (b / ch).floor() as i64);
    let (mut f1, mut f2) = (9.0f32, 9.0f32);
    for da in -1..=1 {
        for db in -1..=1 {
            let (ca, cb) = (ia + da, ib + db);
            let (jx, jy) = cell_jitter(ca, cb, seed);
            let d = ((a - (ca as f32 + jx) * cw) / cw).hypot((b - (cb as f32 + jy) * ch) / ch);
            if d < f1 {
                f2 = f1;
                f1 = d;
            } else if d < f2 {
                f2 = d;
            }
        }
    }
    (f1, f2)
}

// ---- cards ------------------------------------------------------------------------
struct Out {
    data: Vec<f32>,
}

impl Out {
    #[allow(clippy::too_many_arguments)]
    fn push(&mut self, c: Vec3, u: Vec3, v: Vec3, alb: [f32; 3], alpha: f32, glyph: u32, mat: u32, light: [f32; 2]) {
        let start = self.data.len();
        self.data.resize(start + STRIDE, 0.0);
        let card = &mut self.data[start..];
        write3(card, layout::CENTER, c);
        write3(card, layout::U, u);
        write3(card, layout::V, v);
        for (k, a) in alb.iter().enumerate() {
            card[layout::COLOR + k] = a.clamp(0.0, 1.0);
        }
        card[layout::COLOR + 3] = alpha.clamp(0.0, 1.0);
        card[layout::GLYPH] = pack_glyph(glyph, mat);
        card[layout::LIGHT] = light[0];
        card[layout::LIGHT + 1] = light[1];
    }
}

/// Build the whole pine scene. `glyph_aspect` is the atlas cell width / height.
pub fn generate(seed: u32, glyph_aspect: f32) -> Vec<f32> {
    let tree = Tree::grow(seed);
    let light = Light::new(&tree);
    let all = charset();
    let mut rng = Pcg32::new(seed as u64 + 7919, 0xca7d);
    let mut out = Out { data: Vec::with_capacity((tree.needles.len() + 80_000) * STRIDE) };
    let aspect = glyph_aspect;

    // Needles: one character ~ a small spray of needles, aligned with it.
    let needle_pick = Picker::new(NEEDLE_CH, &all, Some(&NEEDLE_P));
    for n in &tree.needles {
        let h = rng.range(0.14, 0.20);
        let vd = unit(n.p1 - n.p0);
        let c = n.p0 + vd * (h * 0.45);
        let [t0, t1] = n.tint;
        let mut alb = [0.13 * (1.0 + 0.12 * t0) + 0.03 * t1, 0.33 * (1.0 + 0.12 * t0), 0.17 * (1.0 + 0.12 * t0) - 0.03 * t1];
        if n.young {
            let y = [0.26, 0.42, 0.16];
            alb = [0, 1, 2].map(|k| alb[k] * 0.4 + y[k] * 0.6);
        }
        let j = 1.0 + 0.15 * rng.normal();
        let alb = alb.map(|a| (a * j).clamp(0.02, 1.0));
        // Base opacity; the shader adds more where the card is sunlit ("lit = crisp").
        let alpha = 0.28 + 0.1 * rng.next_f32();
        let glyph = needle_pick.pick(&mut rng);
        out.push(c, any_perp(vd) * (h * aspect), vd * h, alb, alpha, glyph, material::NEEDLE, [light.sun(c), light.sky(c)]);
    }

    // Light new growth at the shoot tips.
    let tip_pick = Picker::new(TIP_CH, &all, None);
    for &(p, d) in &tree.tips {
        if rng.next_f32() >= 0.4 {
            continue;
        }
        let c = p + d * 0.02;
        let vd = unit(d + Vec3::new(0.0, 0.3, 0.0));
        let glyph = tip_pick.pick(&mut rng);
        out.push(c, any_perp(vd) * (0.13 * aspect), vd * 0.13, [0.36, 0.5, 0.2], 0.85, glyph, material::TIP, [light.sun(c), light.sky(c)]);
    }

    // Branches and twigs: glyphs laid along the wood. Fine twigs inside the
    // foliage get no cards (the needles cover them), dead ones always do.
    let (thick_pick, thin_pick, dead_pick) =
        (Picker::new(WOOD_THICK, &all, None), Picker::new(WOOD_THIN, &all, None), Picker::new(DEAD_CH, &all, None));
    for s in tree.segs.iter().filter(|s| s.level < 3 || s.dead) {
        let len = (s.p1 - s.p0).length();
        let h = (3.5 * s.r).clamp(0.08, 0.12);
        let thick = s.r > 0.012;
        let step = h * aspect * if thick { 0.85 } else { 1.25 }; // thin twigs: dashed
        let cnt = ((len / step).ceil() as usize).max(1);
        let t = unit(s.p1 - s.p0);
        for k in 0..cnt {
            let c = s.p0 + (s.p1 - s.p0) * ((k as f32 + 0.5) / cnt as f32);
            let hh = h * rng.range(0.9, 1.1);
            let glyph = if s.dead {
                dead_pick.pick(&mut rng)
            } else if thick {
                thick_pick.pick(&mut rng)
            } else {
                thin_pick.pick(&mut rng)
            };
            let warm = smoothstep(0.55, 0.9, c.y / TREE_H);
            let alb = if s.dead {
                [0.48, 0.45, 0.42]
            } else {
                [0.50 + 0.25 * warm, 0.34 + 0.08 * warm, 0.22]
            };
            let j = 1.0 + 0.12 * rng.normal();
            let alpha = rng.range(0.82, 0.95);
            out.push(c, t * (hh * aspect), any_perp(t) * hh, alb.map(|a| a * j), alpha, glyph, material::WOOD, [light.sun(c), light.sky(c)]);
        }
    }

    trunk_cards(&tree, &light, &all, &mut rng, &mut out, aspect);
    ground_cards(&light, &all, &mut rng, &mut out, aspect);
    out.data
}

/// Bark wrapped all the way round the trunk, tilted a little off the surface,
/// with plates, fissures and flaky orange upper bark.
fn trunk_cards(tree: &Tree, light: &Light, all: &str, rng: &mut Pcg32, out: &mut Out, aspect: f32) {
    let grid = NoiseGrid::new(rng, 256);
    let worley_seed = rng.next_u32() as u64;
    let (plate, mid, fiss_p, upper_p) =
        (Picker::new(BARK_PLATE, all, None), Picker::new(BARK_MID, all, None), Picker::new(BARK_FISS, all, None), Picker::new(BARK_UP, all, None));
    let spacing = 0.07;
    let mut y = -0.05;
    while y < TREE_H {
        let r = tree.trunk_radius(y);
        let (cx, cz) = tree.trunk_center(y);
        let (cx2, cz2) = tree.trunk_center(y + 0.05);
        let axis = unit(Vec3::new((cx2 - cx) / 0.05, 1.0, (cz2 - cz) / 0.05));
        let n = ((TAU * r / spacing).ceil() as usize).max(4);
        let offset = rng.next_f32();
        for j in 0..n {
            let th = (j as f32 + offset) / n as f32 * TAU + rng.normal() * (0.15 / n as f32 * 6.0);
            let nrm = Vec3::new(th.sin(), 0.0, th.cos());
            let p = Vec3::new(cx, y, cz) + nrm * r + UP * (rng.range(-0.4, 0.4) * spacing);
            let tang = Vec3::new(th.cos(), 0.0, -th.sin());
            let phi = rng.normal() * 0.18;
            let u = unit(tang * phi.cos() + axis * phi.sin() + nrm * (rng.normal() * 0.25));
            let v = unit(-tang * phi.sin() + axis * phi.cos() + nrm * (rng.normal() * 0.25));
            let hh = rng.range(0.11, 0.13);
            let c = p + nrm * rng.range(0.0, 0.012);

            // Bark pattern, same plates-and-fissures model as the script.
            let py = p.y;
            let rr = tree.trunk_radius(py);
            let arc = (th + tree.ph[3]) * rr;
            let wa = arc + 0.018 * (grid.at(arc * 20.0, py * 5.0) - 0.5);
            let wb = py + 0.06 * (grid.at(arc * 20.0 + 33.0, py * 5.0) - 0.5);
            let (f1, f2) = worley(wa, wb, 0.075, 0.24, worley_seed);
            let edge = f2 - f1;
            let fiss = smoothstep(0.12 + 0.14 * grid.at(arc * 12.0 + 7.0, py * 2.5), 0.02, edge);
            let raised = smoothstep(0.05, 0.6, edge);
            let mott = grid.at(arc * 45.0 + 90.0, py * 18.0);
            let flake = smoothstep(0.56, 0.74, grid.at(arc * 14.0 + 20.0, py * 40.0));
            let m = smoothstep(0.4, 0.62, py / TREE_H + 0.12 * (grid.at(arc * 5.0, py * 1.5) - 0.5));
            let upper = rng.next_f32() < m;

            let glyph = if upper {
                upper_p.pick(rng)
            } else if fiss > 0.45 {
                fiss_p.pick(rng)
            } else if raised > 0.55 {
                plate.pick(rng)
            } else {
                mid.pick(rng)
            };
            let alb = if upper {
                [0.95, 0.50, 0.27].map(|a| a * (0.85 + 0.3 * flake))
            } else if fiss > 0.45 {
                [0.24, 0.14, 0.10]
            } else {
                [0.58, 0.48, 0.40].map(|a| a * (0.75 + 0.45 * mott) * (0.8 + 0.3 * raised))
            };
            let dim = 0.7 + 0.3 * smoothstep(0.0, 0.8, py);
            let alpha = rng.range(0.95, 1.0);
            let vis = [light.sun(c + nrm * 0.05), light.sky(c)];
            out.push(c, u * (hh * aspect), v * hh, alb.map(|a| a * dim), alpha, glyph, material::BARK, vis);
        }
        y += spacing;
    }
}

/// Standing grass blades and flat soil marks on a disc around the tree, in the
/// tree's shadow. The disc edge fades out instead of ending in a hard line.
fn ground_cards(light: &Light, all: &str, rng: &mut Pcg32, out: &mut Out, aspect: f32) {
    const RADIUS: f32 = 11.0;
    let fade = |r: f32| 1.0 - smoothstep(0.7 * RADIUS, RADIUS, r);
    let disc = |rng: &mut Pcg32| {
        let r = RADIUS * rng.next_f32().sqrt();
        let a = rng.range(0.0, TAU);
        (r, Vec3::new(r * a.cos(), 0.0, r * a.sin()))
    };
    // Shadowed ground keeps a quarter of the sunlight (sky still lights it).
    let ground_sun = |p: Vec3| 0.25 + 0.75 * light.sun_far(p);

    let soil = Picker::new(SOIL_CH, all, None);
    for _ in 0..14_000 {
        let (r, g) = disc(rng);
        let size = rng.range(0.12, 0.2);
        let yaw = rng.range(0.0, TAU);
        let u = Vec3::new(yaw.cos(), 0.0, yaw.sin());
        let v = Vec3::new(yaw.sin(), 0.0, -yaw.cos()); // u x v points up
        let c = g + Vec3::new(0.0, 0.002, 0.0);
        let s = rng.range(0.7, 1.3);
        let glyph = soil.pick(rng);
        out.push(c, u * (size * aspect), v * size, [0.22 * s, 0.26 * s, 0.11 * s], 0.7 * fade(r), glyph, material::SOIL, [ground_sun(c), 0.9]);
    }

    let grass = Picker::new(GRASS_CH, all, Some(&GRASS_P));
    let blades = 45_000;
    for k in 0..blades + 300 {
        // The last few hundred crowd round the trunk base.
        let (r, g) = if k < blades {
            disc(rng)
        } else {
            let g = Vec3::new(rng.normal() * 1.1, 0.0, rng.normal() * 0.9);
            (g.length(), g)
        };
        if r < 0.25 {
            continue; // inside the trunk
        }
        let h = if k < blades { rng.range(0.09, 0.15) } else { rng.range(0.1, 0.15) };
        let tilt = rng.normal() * 0.3;
        let tdir = rng.range(0.0, TAU);
        let vd = Vec3::new(tilt.sin() * tdir.cos(), tilt.cos(), tilt.sin() * tdir.sin());
        let c = g + vd * (h * 0.5);
        let tone = rng.next_f32();
        let alb = if rng.next_f32() < 0.15 {
            [0.55, 0.50, 0.25]
        } else {
            [0.22 + 0.16 * tone, 0.40 + 0.12 * tone, 0.12 + 0.05 * tone]
        };
        let alpha = rng.range(0.78, 0.95) * fade(r);
        let glyph = grass.pick(rng);
        out.push(c, any_perp(vd) * (h * aspect), vd * h, alb, alpha, glyph, material::GRASS, [ground_sun(c), 0.9]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::MATERIAL_SHIFT;

    #[test]
    fn charset_is_unique_and_covers_every_set() {
        let cs = charset();
        let mut seen = std::collections::HashSet::new();
        assert!(cs.chars().all(|c| seen.insert(c)), "duplicate characters");
        for set in ALL_SETS {
            assert!(set.chars().all(|c| cs.contains(c)));
        }
        assert!(cs.chars().count() < MATERIAL_SHIFT as usize);
    }

    #[test]
    fn tree_has_the_expected_structure() {
        let t = Tree::grow(23);
        // The Python original grows ~6-8k segments, ~9.5-12k needles, ~2k tips.
        eprintln!("segs {} needles {} tips {}", t.segs.len(), t.needles.len(), t.tips.len());
        assert!((4_000..12_000).contains(&t.segs.len()), "{} segments", t.segs.len());
        assert!((7_000..16_000).contains(&t.needles.len()), "{} needles", t.needles.len());
        assert!((1_200..3_500).contains(&t.tips.len()), "{} tips", t.tips.len());
        assert!(t.segs.iter().any(|s| s.dead));
        for n in &t.needles {
            assert!(n.p0.is_finite() && n.p1.is_finite());
            assert!(n.p0.y > 1.5 && n.p0.y < TREE_H + 1.0, "needle at {:?}", n.p0);
        }
    }

    #[test]
    fn scene_is_valid_and_deterministic() {
        let a = generate(23, 0.64);
        assert_eq!(a.len() % STRIDE, 0);
        assert!(a.iter().all(|v| v.is_finite()));
        let glyphs = charset().chars().count() as u32;
        for c in a.chunks_exact(STRIDE) {
            let g = c[layout::GLYPH] as u32;
            assert!(g % MATERIAL_SHIFT < glyphs);
            assert!((1..=6).contains(&(g / MATERIAL_SHIFT)));
            assert!((0.0..=1.0).contains(&c[layout::LIGHT]) && (0.0..=1.0).contains(&c[layout::LIGHT + 1]));
        }
        assert_eq!(a, generate(23, 0.64));
        assert_ne!(a, generate(24, 0.64));
    }

    #[test]
    fn crown_shades_itself() {
        // Needles deep in the crown must get less sun than ones on the sunny side.
        let t = Tree::grow(23);
        let light = Light::new(&t);
        let vis: Vec<f32> = t.needles.iter().map(|n| light.sun((n.p0 + n.p1) * 0.5)).collect();
        let min = vis.iter().cloned().fold(1.0, f32::min);
        let max = vis.iter().cloned().fold(0.0, f32::max);
        assert!(min < 0.2 && max > 0.8, "sun visibility range {min}..{max}");
    }

    #[test]
    fn worley_edges_are_sane() {
        for i in 0..1000 {
            let (f1, f2) = worley(i as f32 * 0.013, i as f32 * 0.071, 0.075, 0.24, 1);
            assert!(f1 <= f2 && f1 >= 0.0 && f2 < 9.0);
        }
    }
}
