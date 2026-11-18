//! Small plants: fern, big-leaf rosettes (hosta, variegated hosta, elephant
//! ear, rhubarb), grass tuft, reeds, wildflowers. Port of `scenery/plants.py`.

use super::asset::{dir, polyline, unit, Asset, RngExt, UP};
use super::style::{Bark, Mat};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::{FRAC_PI_2, PI, TAU};

const GOLDEN: f32 = 2.39996;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlantKind {
    Fern,
    Hosta,
    HostaVariegated,
    ElephantEar,
    Rhubarb,
    GrassTuft,
    Reeds,
    Wildflowers,
}

impl PlantKind {
    pub const ALL: [PlantKind; 8] = [
        PlantKind::Fern, PlantKind::Hosta, PlantKind::HostaVariegated, PlantKind::ElephantEar,
        PlantKind::Rhubarb, PlantKind::GrassTuft, PlantKind::Reeds, PlantKind::Wildflowers,
    ];

    pub fn name(self) -> &'static str {
        ["fern", "hosta", "hosta_variegated", "elephant_ear", "rhubarb", "grass_tuft", "reeds", "wildflowers"][self as usize]
    }
}

/// Polyline from `start` whose elevation follows `el(s)` along its length.
fn curve(start: Vec3, az: f32, el: impl Fn(f32) -> f32, length: f32, n: usize) -> Vec<Vec3> {
    let mut pts = vec![start];
    for j in 0..n {
        let s = (j as f32 + 0.5) / n as f32;
        let last = pts[pts.len() - 1];
        pts.push(last + dir(az, el(s)) * (length / n as f32));
    }
    pts
}

/// One sprite per segment of a polyline, aligned with it.
fn chain(a: &mut Asset, pts: &[Vec3], size: impl Fn(f32) -> f32, mat: Mat) {
    let n = pts.len() - 1;
    for i in 0..n {
        let seg = pts[i + 1] - pts[i];
        let s = (i as f32 + 0.5) / n as f32;
        a.sprite((pts[i] + pts[i + 1]) * 0.5, seg, seg.length() * size(s), mat, None);
    }
}

fn fern(rng: &mut Pcg32, size: f32) -> Asset {
    let mut a = Asset::new("fern");
    let nf = rng.int(9, 16);
    for i in 0..nf {
        let az = TAU * i as f32 / nf as f32 + rng.gauss(0.25);
        let len = size * rng.uniform(0.55, 1.0);
        let (e0, curl) = (rng.uniform(0.95, 1.25), rng.uniform(1.3, 2.1));
        let base = Vec3::new(az.sin(), 0.0, az.cos()) * (0.03 * size);
        let pts = curve(base, az, |s| e0 - curl * s.powf(1.4), len, 16);
        a.wood_chain(&pts, |i, n| 0.006 * size * (1.0 - 0.6 * i as f32 / (n - 1) as f32), 3, Bark::Stem);
        let mat = if rng.chance(0.12) { Mat::FernOld } else { Mat::Fern };
        let (segs, sl, cum) = polyline(&pts);
        let total = cum[cum.len() - 1];
        let npairs = rng.int(18, 26);
        for q in 0..npairs {
            let s = 0.12 + (0.98 - 0.12) * q as f32 / (npairs - 1) as f32;
            let pos = s * total;
            let k = (cum.partition_point(|&c| c < pos).saturating_sub(1)).min(segs.len() - 1);
            let p = pts[k] + segs[k] * ((pos - cum[k]) / sl[k]);
            let t = segs[k] * (1.0 / sl[k]);
            let side = unit(t.cross(UP));
            let nf_ = unit(side.cross(t));
            let lp = len * 0.3 * (PI * (s * 1.25).min(1.0)).sin().max(0.0).powf(0.6) * (1.0 - 0.45 * s);
            for sg in [-1.0f32, 1.0] {
                let d = unit(t * 0.4 + side * sg - nf_ * 0.15);
                let npin = ((lp / 0.028) as usize).max(2);
                for j in 0..npin {
                    let tt = (j as f32 + 0.5) / npin as f32;
                    let cen = p + d * (tt * lp);
                    let wid = lp * 0.32 * (1.0 - 0.75 * tt) + 0.012;
                    let alt = if j % 2 == 0 { 1.0 } else { -1.0 };
                    let ax = unit(d * 0.45 + nf_.cross(d) * (alt * 0.9));
                    a.sprite(cen + ax * (wid / 2.0), ax, wid * 1.2, mat, Some(nf_));
                }
            }
        }
    }
    for _ in 0..rng.int(0, 4) {
        let (az, h) = (rng.uniform(0.0, TAU), rng.uniform(0.08, 0.22) * size);
        let p = Vec3::new(az.sin() * 0.03, h, az.cos() * 0.03);
        a.wood(Vec3::ZERO, p, 0.005, 3, Bark::Stem);
        a.sprite(p + UP * 0.02, UP, 0.06 * size, Mat::Fiddlehead, None);
    }
    a
}

#[derive(Clone, Copy, PartialEq)]
enum Shape {
    Ovate,
    Heart,
    Round,
}

struct LeafPreset {
    n: (u32, u32),
    pet: (f32, f32),
    pet_el: (f32, f32),
    l: (f32, f32),
    wr: (f32, f32),
    droop: f32,
    cup: f32,
    shape: Shape,
    surf: &'static [Mat],
    edge: Option<Mat>,
    mid: Mat,
    stem: Bark,
    wavy: f32,
    blade_el: f32,
}

fn leaf_preset(k: PlantKind) -> LeafPreset {
    match k {
        PlantKind::Hosta => LeafPreset {
            n: (11, 17), pet: (0.22, 0.36), pet_el: (1.0, 1.3), l: (0.3, 0.42), wr: (0.58, 0.72), droop: 0.9, cup: 0.3,
            shape: Shape::Ovate, surf: &[Mat::BigleafBlue, Mat::Bigleaf], edge: None, mid: Mat::Midrib, stem: Bark::Stem,
            wavy: 0.0, blade_el: -0.4,
        },
        PlantKind::HostaVariegated => LeafPreset {
            n: (11, 17), pet: (0.22, 0.34), pet_el: (1.0, 1.3), l: (0.28, 0.4), wr: (0.52, 0.64), droop: 0.9, cup: 0.3,
            shape: Shape::Ovate, surf: &[Mat::Bigleaf], edge: Some(Mat::BigleafEdge), mid: Mat::Midrib, stem: Bark::Stem,
            wavy: 0.0, blade_el: -0.4,
        },
        PlantKind::ElephantEar => LeafPreset {
            n: (5, 9), pet: (0.6, 1.0), pet_el: (1.05, 1.35), l: (0.5, 0.75), wr: (0.7, 0.85), droop: 0.75, cup: 0.12,
            shape: Shape::Heart, surf: &[Mat::Bigleaf], edge: None, mid: Mat::Midrib, stem: Bark::Stem,
            wavy: 0.0, blade_el: -1.25,
        },
        _ => LeafPreset {
            n: (5, 9), pet: (0.3, 0.5), pet_el: (0.8, 1.05), l: (0.4, 0.6), wr: (0.85, 1.0), droop: 1.2, cup: 0.2,
            shape: Shape::Round, surf: &[Mat::BigleafDark], edge: None, mid: Mat::MidribRed, stem: Bark::StemRed,
            wavy: 0.05, blade_el: -0.55,
        },
    }
}

/// Half-width profile of the blade (0..1) along the midrib parameter u.
fn width(u: f32, shape: Shape) -> f32 {
    match shape {
        Shape::Heart => {
            let x = (u + 0.3) / 1.3;
            (1.0 - ((x - 0.42) / 0.58).powi(2)).clamp(0.0, 1.0).sqrt() * (1.0 - 0.35 * x)
        }
        Shape::Round => {
            let x = (u + 0.12) / 1.12;
            (1.0 - ((x - 0.48) / 0.52).powi(2)).clamp(0.0, 1.0).sqrt()
        }
        Shape::Ovate => (PI * u.clamp(0.0, 1.0)).sin().max(0.0).powf(0.75) * (1.0 - 0.2 * u),
    }
}

fn rosette(rng: &mut Pcg32, kind: PlantKind, size: f32) -> Asset {
    let p = leaf_preset(kind);
    let mut a = Asset::new(kind.name());
    let n = rng.int(p.n.0, p.n.1);
    let surf_mat = p.surf[rng.int(0, p.surf.len() as u32) as usize];
    let u0 = match p.shape {
        Shape::Heart => -0.3,
        Shape::Round => -0.12,
        Shape::Ovate => 0.0,
    };
    for i in 0..n {
        let az = i as f32 * GOLDEN + rng.gauss(0.15);
        let outer = i as f32 / (n - 1).max(1) as f32;
        let el = rng.uniform(p.pet_el.0, p.pet_el.1) - 0.35 * outer;
        let pl = rng.uniform(p.pet.0, p.pet.1) * size * (1.0 - 0.25 * (1.0 - outer));
        let pts = curve(Vec3::ZERO, az, |s| el - 0.4 * s * s, pl, 6);
        a.wood_chain(&pts, |i, n| 0.008 * size * (1.2 - 0.4 * i as f32 / (n - 1) as f32), 3, p.stem);
        let b = pts[pts.len() - 1];
        let len = rng.uniform(p.l.0, p.l.1) * size * (0.75 + 0.35 * outer);
        let wb = len * rng.uniform(p.wr.0, p.wr.1);
        let eb = el + p.blade_el;
        let droop = p.droop * rng.uniform(0.8, 1.2);
        let roll = rng.gauss(0.35);
        // Midrib on a fine grid of u, from the lobes (u0 < 0) to the tip.
        let nu_grid = 60;
        let uu: Vec<f32> = (0..nu_grid).map(|k| u0 + (1.0 - u0) * k as f32 / (nu_grid - 1) as f32).collect();
        let dirs: Vec<Vec3> = uu.iter().map(|&u| dir(az, eb - droop * u.max(0.0).powf(1.5))).collect();
        let stepl = len * (1.0 - u0) / nu_grid as f32;
        let mut mid = Vec::with_capacity(nu_grid);
        let mut acc = Vec3::ZERO;
        for d in &dirs {
            acc += *d * stepl;
            mid.push(b + acc - dirs[0] * (len * -u0));
        }
        let ds = 0.022 * size;
        let nu = ((len * (1.0 - u0) / ds) as usize).max(4);
        let nv = ((wb / ds) as usize).max(3);
        let surface = |u: f32, v: f32| -> (Vec3, Vec3) {
            let k = (((u - u0) / (1.0 - u0) * (nu_grid - 1) as f32) as isize).clamp(0, nu_grid as isize - 1) as usize;
            let t = dirs[k];
            let side = unit(t.cross(UP));
            let side = unit(side * roll.cos() + t.cross(side) * roll.sin());
            let nrm = unit(side.cross(t));
            let lift = p.cup * v * v * wb * 0.6 + p.wavy * size * (v * 9.0 + u * 14.0).sin() * v.abs();
            (mid[k] + side * (v * wb / 2.0) + nrm * lift, nrm)
        };
        for iu in 0..nu {
            for iv in 0..nv {
                let u = u0 + (1.0 - u0) * iu as f32 / (nu - 1) as f32 + rng.uniform(-0.4, 0.4) / nu as f32;
                let v = -1.0 + 2.0 * iv as f32 / (nv - 1) as f32 + rng.uniform(-0.4, 0.4) / nv as f32;
                let w = width(u, p.shape);
                if v.abs() >= w {
                    continue;
                }
                if p.shape == Shape::Heart && u < 0.0 && v.abs() < 0.5 * ((-u).max(0.0) / -u0).powf(0.7) {
                    continue; // notch between the lobes
                }
                let (mut pos, _) = surface(u, v);
                pos.y = pos.y.max(0.01 + 0.02 * v.abs()); // leaves rest on the ground
                let e = 1e-3;
                let du = surface(u + e, v).0 - surface(u - e, v).0;
                let dv = surface(u, v + e).0 - surface(u, v - e).0;
                let mut nrm = unit(dv.cross(du));
                if nrm.y < 0.0 {
                    nrm = -nrm;
                }
                if nrm == Vec3::ZERO {
                    nrm = UP;
                }
                let rel = v.abs() / w.max(1e-3);
                let mut mat = surf_mat;
                if let Some(edge) = p.edge {
                    if rel > 0.72 {
                        mat = edge;
                    }
                }
                if v.abs() * wb / 2.0 < 0.012 * size && u > 0.0 {
                    mat = p.mid;
                }
                a.surfel(pos, nrm, ds, mat);
            }
        }
    }
    a
}

fn grass_tuft(rng: &mut Pcg32, size: f32) -> Asset {
    let mut a = Asset::new("grass_tuft");
    for _ in 0..rng.int(22, 46) {
        let (az, r0) = (rng.uniform(0.0, TAU), rng.uniform(0.0, 0.06) * size);
        let h = rng.uniform(0.3, 0.75) * size;
        let (lean, bend) = (rng.uniform(0.05, 0.45), rng.uniform(0.4, 1.3));
        let pts = curve(Vec3::new(az.sin() * r0, 0.0, az.cos() * r0), az, |s| FRAC_PI_2 - lean - bend * s.powf(1.6), h, 6);
        chain(&mut a, &pts, |s| 1.35 - 0.3 * s, Mat::GrassTall);
    }
    a
}

fn reeds(rng: &mut Pcg32, size: f32) -> Asset {
    let mut a = Asset::new("reeds");
    for _ in 0..rng.int(10, 24) {
        let (az, r0) = (rng.uniform(0.0, TAU), rng.next_f32().sqrt() * 0.25 * size);
        let h = rng.uniform(1.0, 1.8) * size;
        let lean = rng.gauss(0.06);
        let base = Vec3::new(az.sin() * r0, 0.0, az.cos() * r0);
        let pts = curve(base, az, |s| FRAC_PI_2 - lean.abs() - 0.1 * s, h, 9);
        chain(&mut a, &pts, |_| 1.3, Mat::Reed);
        if rng.chance(0.45) {
            let k = 6;
            let head = pts[k] + (pts[k + 1] - pts[k]) * 0.5;
            let ax = unit(pts[k + 1] - pts[k]);
            for j in 0..3 {
                a.sprite(head + ax * ((j as f32 * 0.05 - 0.05) * size), ax, 0.07 * size, Mat::Cattail, None);
            }
        }
        for _ in 0..rng.int(1, 3) {
            let laz = az + rng.gauss(0.8);
            let lh = h * rng.uniform(0.5, 0.8);
            let lpts = curve(base, laz, |s| 1.35 - 1.4 * s.powf(1.5), lh, 7);
            chain(&mut a, &lpts, |_| 1.3, Mat::GrassTall);
        }
    }
    a
}

fn wildflowers(rng: &mut Pcg32, size: f32) -> Asset {
    let mut a = Asset::new("wildflowers");
    let colors = [Mat::FlowerYellow, Mat::FlowerWhite, Mat::FlowerPurple, Mat::FlowerRed];
    let main = colors[rng.int(0, 4) as usize];
    for _ in 0..rng.int(8, 18) {
        let (az, r0) = (rng.uniform(0.0, TAU), rng.next_f32().sqrt() * 0.18 * size);
        let h = rng.uniform(0.2, 0.55) * size;
        let lean = rng.uniform(0.0, 0.35);
        let base = Vec3::new(az.sin() * r0, 0.0, az.cos() * r0);
        let pts = curve(base, az, |s| FRAC_PI_2 - lean - 0.3 * s, h, 6);
        a.wood_chain(&pts, |_, _| 0.003 * size, 3, Bark::Stem);
        for j in [1, 2] {
            if rng.chance(0.7) {
                let laz = rng.uniform(0.0, TAU);
                let d = dir(laz, rng.uniform(0.2, 0.7));
                a.sprite(pts[j] + d * (0.03 * size), d, 0.06 * size, Mat::PlantLeaf, None);
            }
        }
        let mat = if rng.chance(0.85) { main } else { colors[rng.int(0, 4) as usize] };
        let heads = if rng.chance(0.7) { 1 } else { rng.int(2, 4) };
        for _ in 0..heads {
            let off = if heads > 1 { rng.gauss3(0.02) * size } else { Vec3::ZERO };
            let fnrm = unit(UP + rng.gauss3(0.35));
            let ax = unit(fnrm.cross(rng.gauss3(1.0)));
            let sz = rng.uniform(0.07, 0.11) * size;
            a.sprite(pts[pts.len() - 1] + off + fnrm * 0.01, if ax == Vec3::ZERO { Vec3::X } else { ax }, sz, mat, Some(fnrm));
        }
    }
    a
}

pub fn make_plant(seed: u32, kind: PlantKind) -> Asset {
    let mut rng = Pcg32::new(seed as u64, 0x91a7);
    let s = rng.uniform(0.85, 1.15);
    match kind {
        PlantKind::Fern => fern(&mut rng, s),
        PlantKind::Hosta | PlantKind::HostaVariegated | PlantKind::ElephantEar | PlantKind::Rhubarb => rosette(&mut rng, kind, s),
        PlantKind::GrassTuft => grass_tuft(&mut rng, s),
        PlantKind::Reeds => reeds(&mut rng, s),
        PlantKind::Wildflowers => wildflowers(&mut rng, s),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_is_valid_and_plausibly_sized() {
        for kind in PlantKind::ALL {
            let a = make_plant(4, kind);
            assert!(a.is_valid(), "{kind:?}");
            assert!(a.primitive_count() > 50, "{kind:?}: {}", a.primitive_count());
            let (lo, hi) = a.bounds();
            assert!(lo.y > -0.05, "{kind:?} below ground {lo:?}");
            assert!(hi.y > 0.1 && hi.y < 2.5, "{kind:?} height {}", hi.y);
            assert!((hi.x - lo.x) < 4.0, "{kind:?} width");
        }
    }

    #[test]
    fn rosettes_are_surfels_ferns_are_sprites() {
        let h = make_plant(1, PlantKind::Hosta);
        assert!(h.surfels.len() > 500 && h.surfels.iter().any(|s| s.mat == Mat::Midrib));
        let v = make_plant(1, PlantKind::HostaVariegated);
        assert!(v.surfels.iter().any(|s| s.mat == Mat::BigleafEdge));
        let f = make_plant(1, PlantKind::Fern);
        assert!(f.sprites.len() > 500 && f.sprites.iter().all(|s| s.normal != Vec3::ZERO || s.mat == Mat::Fiddlehead));
        let r = make_plant(1, PlantKind::Reeds);
        assert!(r.sprites.iter().any(|s| s.mat == Mat::Reed));
    }
}
