//! The data contract between generators and the renderer (port of
//! `scenery/geometry.py`). Generators never produce characters, only:
//!
//! * wood: tapered segments (trunks, branches, twigs, stems)
//! * sprites: small oriented elements, each becomes one card (needle sprays,
//!   leaves, blades, flowers); `normal` zero = free to face the viewer
//! * surfels: surface samples of a solid or a big leaf (rocks, hosta blades)
//!
//! plus `solids`: triangles of opaque bodies (rocks, thick trunks) that hide
//! whatever is behind them. Local coordinates: metres, +y up, base at y = 0.

use super::style::{Bark, Mat};
use crate::math::Vec3;
use crate::rng::Pcg32;

#[derive(Clone, Copy, Debug)]
pub struct Wood {
    pub p0: Vec3,
    pub p1: Vec3,
    pub r: f32,
    /// 0 trunk, 1 limb, 2+ twig.
    pub level: u8,
    pub bark: Bark,
}

#[derive(Clone, Copy, Debug)]
pub struct Sprite {
    pub pos: Vec3,
    /// Direction the glyph's vertical runs along (unit).
    pub axis: Vec3,
    /// Plane normal, or zero when the card may turn to face the viewer.
    pub normal: Vec3,
    pub size: f32,
    pub mat: Mat,
}

#[derive(Clone, Copy, Debug)]
pub struct Surfel {
    pub pos: Vec3,
    pub normal: Vec3,
    pub spacing: f32,
    pub mat: Mat,
}

#[derive(Clone, Debug, Default)]
pub struct Asset {
    pub name: String,
    pub wood: Vec<Wood>,
    pub sprites: Vec<Sprite>,
    pub surfels: Vec<Surfel>,
    pub solids: Vec<[Vec3; 3]>,
}

impl Asset {
    pub fn new(name: impl Into<String>) -> Asset {
        Asset { name: name.into(), ..Default::default() }
    }

    pub fn wood(&mut self, p0: Vec3, p1: Vec3, r: f32, level: u8, bark: Bark) {
        self.wood.push(Wood { p0, p1, r, level, bark });
    }

    /// Consecutive segments of a polyline, radius per segment from `r(i, n)`.
    pub fn wood_chain(&mut self, pts: &[Vec3], r: impl Fn(usize, usize) -> f32, level: u8, bark: Bark) {
        let n = pts.len().saturating_sub(1);
        for i in 0..n {
            self.wood(pts[i], pts[i + 1], r(i, n), level, bark);
        }
    }

    pub fn sprite(&mut self, pos: Vec3, axis: Vec3, size: f32, mat: Mat, normal: Option<Vec3>) {
        self.sprites.push(Sprite { pos, axis: unit(axis), normal: normal.map(unit).unwrap_or(Vec3::ZERO), size, mat });
    }

    pub fn surfel(&mut self, pos: Vec3, normal: Vec3, spacing: f32, mat: Mat) {
        self.surfels.push(Surfel { pos, normal: unit(normal), spacing, mat });
    }

    pub fn bounds(&self) -> (Vec3, Vec3) {
        let mut lo = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut hi = -lo;
        let mut add = |p: Vec3| {
            lo = lo.min(p);
            hi = hi.max(p);
        };
        self.wood.iter().for_each(|w| {
            add(w.p0);
            add(w.p1)
        });
        self.sprites.iter().for_each(|s| add(s.pos));
        self.surfels.iter().for_each(|s| add(s.pos));
        if lo.x > hi.x {
            return (Vec3::ZERO, Vec3::ZERO);
        }
        (lo, hi)
    }

    pub fn height(&self) -> f32 {
        self.bounds().1.y.max(0.1)
    }

    pub fn primitive_count(&self) -> usize {
        self.wood.len() + self.sprites.len() + self.surfels.len()
    }

    /// Every primitive finite and sane (used by tests and debug builds).
    pub fn is_valid(&self) -> bool {
        self.wood.iter().all(|w| w.p0.is_finite() && w.p1.is_finite() && w.r.is_finite() && w.r > 0.0)
            && self.sprites.iter().all(|s| s.pos.is_finite() && s.axis.is_finite() && s.normal.is_finite() && s.size > 0.0)
            && self.surfels.iter().all(|s| s.pos.is_finite() && s.normal.is_finite() && s.spacing > 0.0)
            && self.solids.iter().all(|t| t.iter().all(|v| v.is_finite()))
    }
}

/// Where and how one copy of an asset sits in the world.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub pos: Vec3,
    pub yaw: f32,
    pub scale: f32,
    /// Brightness multiplier (instances differ by about +-15%).
    pub tint: f32,
}

impl Placement {
    pub fn at(pos: Vec3) -> Placement {
        Placement { pos, yaw: 0.0, scale: 1.0, tint: 1.0 }
    }

    pub fn point(&self, p: Vec3) -> Vec3 {
        rot_y(p * self.scale, self.yaw) + self.pos
    }

    pub fn dir(&self, d: Vec3) -> Vec3 {
        rot_y(d, self.yaw)
    }
}

// ---- small helpers shared by the generators -----------------------------------

pub const UP: Vec3 = Vec3::Y;

pub fn unit(v: Vec3) -> Vec3 {
    v.try_normalize().unwrap_or(Vec3::ZERO)
}

pub fn rot_y(v: Vec3, a: f32) -> Vec3 {
    let (s, c) = a.sin_cos();
    Vec3::new(v.x * c + v.z * s, v.y, -v.x * s + v.z * c)
}

/// Direction from azimuth (around +y, 0 = +z) and elevation.
pub fn dir(az: f32, el: f32) -> Vec3 {
    Vec3::new(el.cos() * az.sin(), el.sin(), el.cos() * az.cos())
}

/// Two unit vectors perpendicular to unit `t` and to each other.
pub fn basis(t: Vec3) -> (Vec3, Vec3) {
    let r = if t.y.abs() > 0.95 { Vec3::X } else { UP };
    let b1 = unit(t.cross(r));
    (b1, t.cross(b1))
}

pub fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// numpy-style helpers on our RNG.
pub trait RngExt {
    fn uniform(&mut self, lo: f32, hi: f32) -> f32;
    fn int(&mut self, lo: u32, hi_exclusive: u32) -> u32;
    fn gauss(&mut self, sd: f32) -> f32;
    fn gauss3(&mut self, sd: f32) -> Vec3;
    fn chance(&mut self, p: f32) -> bool;
}

impl RngExt for Pcg32 {
    fn uniform(&mut self, lo: f32, hi: f32) -> f32 {
        self.range(lo, hi)
    }
    fn int(&mut self, lo: u32, hi_exclusive: u32) -> u32 {
        lo + self.below((hi_exclusive - lo).max(1))
    }
    fn gauss(&mut self, sd: f32) -> f32 {
        self.normal() * sd
    }
    fn gauss3(&mut self, sd: f32) -> Vec3 {
        Vec3::new(self.normal() * sd, self.normal() * sd, self.normal() * sd)
    }
    fn chance(&mut self, p: f32) -> bool {
        self.next_f32() < p
    }
}

/// Polyline segments, their lengths and cumulative arc length.
pub fn polyline(pts: &[Vec3]) -> (Vec<Vec3>, Vec<f32>, Vec<f32>) {
    let segs: Vec<Vec3> = pts.windows(2).map(|w| w[1] - w[0]).collect();
    let sl: Vec<f32> = segs.iter().map(|s| s.length().max(1e-6)).collect();
    let mut cum = vec![0.0];
    for l in &sl {
        cum.push(cum[cum.len() - 1] + l);
    }
    (segs, sl, cum)
}

/// Segment index containing arc length `u` (numpy `searchsorted(right) - 1`, clamped).
pub fn locate(cum: &[f32], u: f32, nseg: usize) -> usize {
    cum.partition_point(|&c| c <= u).saturating_sub(1).min(nseg - 1)
}
