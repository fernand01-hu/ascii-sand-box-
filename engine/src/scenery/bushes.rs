//! Bushes: several stems from the ground, branching by space colonization
//! inside a rounded envelope, leaves on the twigs. Port of `scenery/bushes.py`.

use super::asset::{unit, Asset, RngExt, UP};
use super::colonize::{colonize, envelope_points, pipe_radii, smooth};
use super::params::{p as param, ParamDesc, Values};
use super::perlin::Perlin;
use super::style::{Bark, Mat};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BushKind {
    SmallRound,
    BigRound,
    Wide,
    Berry,
    Flowering,
    Boxwood,
    Juniper,
}

impl BushKind {
    pub const ALL: [BushKind; 7] =
        [BushKind::SmallRound, BushKind::BigRound, BushKind::Wide, BushKind::Berry, BushKind::Flowering, BushKind::Boxwood, BushKind::Juniper];

    pub fn name(self) -> &'static str {
        ["small_round", "big_round", "wide", "berry", "flowering", "boxwood", "juniper"][self as usize]
    }
}

struct Preset {
    size: (f32, f32),
    shape: [f32; 3],
    stems: (u32, u32),
    att: usize,
    d: f32,
    leaf: Mat,
    leaf_size: (f32, f32),
    per: usize,
    accent: Option<(&'static [Mat], f32)>,
    trop: f32,
}

fn preset(k: BushKind) -> Preset {
    let base = Preset {
        size: (1.0, 1.5), shape: [1.0, 0.85, 1.0], stems: (3, 6), att: 1800, d: 0.06, leaf: Mat::LeafBush,
        leaf_size: (0.09, 0.12), per: 3, accent: None, trop: 0.02,
    };
    match k {
        BushKind::SmallRound => Preset { size: (0.55, 0.85), att: 1200, d: 0.04, leaf_size: (0.07, 0.1), ..base },
        BushKind::BigRound => Preset { size: (1.6, 2.4), shape: [1.0, 0.8, 1.0], stems: (4, 8), att: 2600, d: 0.08, leaf_size: (0.1, 0.14), trop: 0.03, ..base },
        BushKind::Wide => Preset { size: (1.3, 1.9), shape: [1.5, 0.5, 1.2], stems: (5, 9), att: 2200, d: 0.07, leaf_size: (0.09, 0.13), trop: -0.02, ..base },
        BushKind::Berry => Preset { accent: Some((&[Mat::BerryRed], 0.25)), ..base },
        BushKind::Flowering => Preset {
            size: (1.0, 1.6), shape: [1.0, 0.9, 1.0], att: 1900, leaf_size: (0.08, 0.11), per: 2,
            accent: Some((&[Mat::BlossomPink, Mat::BlossomWhite], 0.55)), trop: 0.04, ..base
        },
        BushKind::Boxwood => Preset { size: (0.7, 1.1), shape: [1.0, 0.8, 1.0], stems: (4, 7), d: 0.035, leaf: Mat::LeafBox, leaf_size: (0.05, 0.07), per: 4, ..base },
        BushKind::Juniper => Preset {
            size: (0.9, 1.4), shape: [0.55, 1.0, 0.55], stems: (3, 5), att: 1600, d: 0.05, leaf: Mat::NeedleJuniper,
            leaf_size: (0.08, 0.11), trop: 0.18, ..base
        },
    }
}

pub fn make_bush(seed: u32, kind: BushKind) -> Asset {
    grow(seed, kind, preset(kind))
}

fn mid_u(r: (u32, u32)) -> f32 {
    ((r.0 + r.1) as f32 / 2.0).round()
}

/// What can be changed on a bush (see `params`).
pub fn bush_params(kind: BushKind) -> Vec<ParamDesc> {
    let b = preset(kind);
    let mut v = vec![
        param("size", "size", 0.3, 3.0, 0.05, 1.0),
        param("width", "width", 0.3, 2.5, 0.05, 1.0),
        param("height", "height", 0.3, 2.5, 0.05, 1.0),
        param("stems", "stems", 1.0, 12.0, 1.0, mid_u(b.stems)),
        param("density", "branch density", 0.2, 2.5, 0.05, 1.0),
        param("twig", "twig length", 0.5, 2.0, 0.05, 1.0),
        param("leaves", "leaves per twig", 0.0, 8.0, 1.0, b.per as f32),
        param("leaf_size", "leaf size", 0.4, 2.5, 0.05, 1.0),
        param("upward", "upward growth", -0.2, 0.4, 0.01, b.trop),
    ];
    if let Some((_, prob)) = b.accent {
        v.push(param("accents", "berries / blossoms", 0.0, 1.0, 0.01, prob));
    }
    v
}

/// A bush grown with parameter values (`params`).
pub fn make_bush_with(seed: u32, kind: BushKind, v: &Values) -> Asset {
    let mut p = preset(kind);
    let m = v.get("size");
    p.size = (p.size.0 * m, p.size.1 * m);
    let (w, h) = (v.get("width"), v.get("height"));
    p.shape = [p.shape[0] * w, p.shape[1] * h, p.shape[2] * w];
    let st = v.get("stems");
    if (st - mid_u(p.stems)).abs() > 1e-4 {
        let n = st.round().max(1.0) as u32;
        p.stems = (n, n);
    }
    p.att = ((p.att as f32 * v.get("density")) as usize).max(40);
    p.d *= v.get("twig");
    p.per = v.int("leaves") as usize;
    let ls = v.get("leaf_size");
    p.leaf_size = (p.leaf_size.0 * ls, p.leaf_size.1 * ls);
    p.trop = v.get("upward");
    if let Some((mats, _)) = p.accent {
        p.accent = Some((mats, v.get("accents")));
    }
    grow(seed, kind, p)
}

fn grow(seed: u32, kind: BushKind, p: Preset) -> Asset {
    let mut rng = Pcg32::new(seed as u64, 0xb054);
    let noise = Perlin::new(seed as u64 + 5);
    let size = rng.uniform(p.size.0, p.size.1);
    let radii = Vec3::new(p.shape[0], p.shape[1], p.shape[2]) * (size / 2.0);
    let radii = Vec3::new(radii.x * rng.uniform(0.9, 1.1), radii.y * rng.uniform(0.9, 1.1), radii.z * rng.uniform(0.9, 1.1));
    let center = Vec3::new(0.0, radii.y * if kind == BushKind::Juniper { 1.0 } else { 0.9 }, 0.0);
    let blobs = if kind == BushKind::Juniper { 0 } else { rng.int(3, 6) };
    let att = envelope_points(&mut rng, p.att, center, radii, blobs, 0.4, Some(&noise), 0.04);
    let d = p.d;
    let (mut nodes, mut parents) = (Vec::new(), Vec::new());
    for _ in 0..rng.int(p.stems.0, p.stems.1) {
        let (a, rr) = (rng.uniform(0.0, TAU), rng.uniform(0.0, 0.12) * size);
        let b = Vec3::new(a.cos() * rr, 0.0, a.sin() * rr);
        nodes.push(b);
        parents.push(-1);
        nodes.push(b + unit(UP + rng.gauss3(0.25)) * d);
        parents.push(nodes.len() as i32 - 2);
    }
    let sk = colonize(&mut rng, &att, nodes, parents, d, d * 7.0, d * 1.3, UP * p.trop, 300, 0.15);
    let (mut pts, par) = (sk.nodes, sk.parents);
    let nchild = smooth(&mut pts, &par, 2, 0);
    let r = pipe_radii(&par, 0.0035 * size.max(0.6).sqrt(), 2.5);
    let mut asset = Asset::new(format!("bush_{}", kind.name()));
    for i in 0..pts.len() {
        if par[i] >= 0 {
            asset.wood(pts[par[i] as usize], pts[i], r[i], 2, Bark::Shrub);
        }
    }

    // Leaves on twig nodes.
    let rmin = r.iter().cloned().fold(f32::INFINITY, f32::min);
    for i in 0..pts.len() {
        if par[i] < 0 || r[i] >= rmin * 2.2 {
            continue;
        }
        for _ in 0..p.per {
            let dirv = unit(pts[i] - pts[par[i] as usize]);
            let out = unit(pts[i] - center);
            let pos = pts[i] + rng.gauss3(d * 0.6);
            let (axis, normal) = if kind == BushKind::Juniper {
                (unit(dirv + UP * 0.5 + rng.gauss3(0.4)), None)
            } else {
                let axis = unit(dirv + out * 0.6 + rng.gauss3(0.7) + Vec3::new(0.0, -0.2, 0.0));
                (axis, Some(unit(out + UP * 0.8 + rng.gauss3(0.5))))
            };
            let sl = rng.uniform(p.leaf_size.0, p.leaf_size.1) * 1.15;
            asset.sprite(pos + axis * (sl / 2.0), axis, sl, p.leaf, normal);
        }
    }

    if let Some((mats, prob)) = p.accent {
        let mat = mats[rng.int(0, mats.len() as u32) as usize];
        for i in 0..pts.len() {
            if par[i] < 0 || nchild[i] != 0 || !rng.chance(prob) {
                continue;
            }
            let pos = pts[i] + rng.gauss3(d * 0.4);
            let out = unit(pos - center);
            let ax = unit(out.cross(rng.gauss3(1.0)));
            let sz = rng.uniform(0.06, 0.09);
            asset.sprite(pos + out * 0.02, if ax == Vec3::ZERO { Vec3::X } else { ax }, sz, mat, Some(out));
        }
    }
    asset
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_is_valid_and_shaped_like_its_preset() {
        for kind in BushKind::ALL {
            let a = make_bush(2, kind);
            assert!(a.is_valid(), "{kind:?}");
            assert!(a.wood.len() > 50 && a.sprites.len() > 100, "{kind:?}: {} wood {} sprites", a.wood.len(), a.sprites.len());
            let (lo, hi) = a.bounds();
            let p = preset(kind);
            assert!(hi.y < p.size.1 * 1.3 && hi.y > p.size.0 * 0.3, "{kind:?} height {}", hi.y);
            assert!(lo.y > -0.2);
        }
        let w = make_bush(2, BushKind::Wide).bounds();
        assert!((w.1.x - w.0.x) > (w.1.y - w.0.y), "wide bushes are wider than tall");
        assert!(make_bush(2, BushKind::Berry).sprites.iter().any(|s| s.mat == Mat::BerryRed));
    }
}
