//! Rocks: boulders, angular rocks, slabs, pebble clusters, outcrops.
//! Port of `scenery/rocks.py`:
//!
//! 1. icosphere,
//! 2. stretched and pushed in/out by 3D fBm,
//! 3. random plane cuts (flat fractured facets),
//! 4. flattened bottom sunk into the ground,
//! 5. area-weighted surfels painted rock / crack / lichen / moss.
//!
//! The cut mesh also becomes a solid body that hides what is behind it.

use super::asset::{unit, Asset, RngExt};
use super::perlin::Perlin;
use super::style::Mat;
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::collections::HashMap;
use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RockKind {
    Boulder,
    Angular,
    Slab,
    Pebbles,
    Outcrop,
}

impl RockKind {
    pub const ALL: [RockKind; 5] = [RockKind::Boulder, RockKind::Angular, RockKind::Slab, RockKind::Pebbles, RockKind::Outcrop];

    pub fn name(self) -> &'static str {
        ["boulder", "angular", "slab", "pebbles", "outcrop"][self as usize]
    }
}

struct Preset {
    r: (f32, f32),
    scale: [f32; 3],
    lump: f32,
    cuts: (u32, u32),
    moss: (f32, f32),
}

fn preset(k: RockKind) -> Preset {
    match k {
        RockKind::Boulder => Preset { r: (0.45, 1.2), scale: [1.0, 0.72, 0.9], lump: 0.22, cuts: (2, 4), moss: (0.2, 0.8) },
        RockKind::Angular => Preset { r: (0.4, 1.0), scale: [1.0, 0.85, 0.8], lump: 0.10, cuts: (6, 10), moss: (0.0, 0.4) },
        RockKind::Slab => Preset { r: (0.6, 1.3), scale: [1.5, 0.32, 1.1], lump: 0.12, cuts: (3, 5), moss: (0.3, 0.9) },
        RockKind::Pebbles => Preset { r: (0.06, 0.2), scale: [1.0, 0.6, 0.85], lump: 0.18, cuts: (1, 3), moss: (0.0, 0.2) },
        RockKind::Outcrop => Preset { r: (0.9, 2.0), scale: [1.0, 0.9, 0.8], lump: 0.10, cuts: (6, 10), moss: (0.2, 0.7) },
    }
}

/// Subdivided icosahedron: evenly spread unit vertices.
pub fn icosphere(level: u32) -> (Vec<Vec3>, Vec<[u32; 3]>) {
    let t = (1.0 + 5f32.sqrt()) / 2.0;
    let mut v: Vec<Vec3> = [
        (-1., t, 0.), (1., t, 0.), (-1., -t, 0.), (1., -t, 0.), (0., -1., t), (0., 1., t),
        (0., -1., -t), (0., 1., -t), (t, 0., -1.), (t, 0., 1.), (-t, 0., -1.), (-t, 0., 1.),
    ]
    .iter()
    .map(|&(x, y, z)| unit(Vec3::new(x, y, z)))
    .collect();
    let mut f: Vec<[u32; 3]> = vec![
        [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2],
        [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11],
        [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    for _ in 0..level {
        let mut cache: HashMap<(u32, u32), u32> = HashMap::new();
        let mut mid = |a: u32, b: u32, v: &mut Vec<Vec3>| -> u32 {
            *cache.entry((a.min(b), a.max(b))).or_insert_with(|| {
                v.push(unit(v[a as usize] + v[b as usize]));
                (v.len() - 1) as u32
            })
        };
        let mut nf = Vec::with_capacity(f.len() * 4);
        for &[a, b, c] in &f {
            let (ab, bc, ca) = (mid(a, b, &mut v), mid(b, c, &mut v), mid(c, a, &mut v));
            nf.extend_from_slice(&[[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]);
        }
        f = nf;
    }
    (v, f)
}

fn vertex_normals(p: &[Vec3], f: &[[u32; 3]]) -> Vec<Vec3> {
    let mut vn = vec![Vec3::ZERO; p.len()];
    for t in f {
        let [a, b, c] = t.map(|i| p[i as usize]);
        let n = (b - a).cross(c - a);
        for &i in t {
            vn[i as usize] += n;
        }
    }
    vn.into_iter().map(unit).collect()
}

fn stone_mesh(rng: &mut Pcg32, noise: &Perlin, radius: f32, scale: [f32; 3], lump: f32, cuts: u32, level: u32) -> (Vec<Vec3>, Vec<[u32; 3]>) {
    let (d, f) = icosphere(level);
    let o = [rng.uniform(-50.0, 50.0), rng.uniform(-50.0, 50.0), rng.uniform(-50.0, 50.0)];
    let mut p: Vec<Vec3> = d
        .iter()
        .map(|&q| {
            let r = 1.0
                + lump * noise.fbm(q.x * 1.6 + o[0], q.y * 1.6 + o[1], q.z * 1.6 + o[2], 4)
                + 0.25 * lump * noise.fbm(q.x * 6.0 + o[1], q.y * 6.0 + o[2], q.z * 6.0 + o[0], 3);
            Vec3::new(q.x * scale[0], q.y * scale[1], q.z * scale[2]) * (r * radius)
        })
        .collect();
    for _ in 0..cuts {
        let n = unit(Vec3::new(rng.normal(), rng.normal() * 0.6, rng.normal()));
        let ext = p.iter().map(|q| q.dot(n)).fold(f32::NEG_INFINITY, f32::max);
        let at = ext * rng.uniform(0.62, 0.9);
        for q in &mut p {
            let dist = q.dot(n) - at;
            if dist > 0.0 {
                *q = *q - n * dist;
            }
        }
    }
    let y0 = p.iter().map(|q| q.y).fold(f32::INFINITY, f32::min);
    let y1 = p.iter().map(|q| q.y).fold(f32::NEG_INFINITY, f32::max);
    let flat = y0 + (y1 - y0) * 0.18;
    for q in &mut p {
        if q.y < flat {
            q.y = flat - (flat - q.y) * 0.25;
        }
    }
    let y1 = p.iter().map(|q| q.y).fold(f32::NEG_INFINITY, f32::max);
    let sink = flat + (y1 - flat) * 0.08; // base slightly below ground
    p.iter_mut().for_each(|q| q.y -= sink);
    (p, f)
}

/// Area-weighted random points with interpolated normals (above ground only).
fn sample_surface(p: &[Vec3], f: &[[u32; 3]], spacing: f32, rng: &mut Pcg32) -> Vec<(Vec3, Vec3)> {
    let vn = vertex_normals(p, f);
    let mut cdf = Vec::with_capacity(f.len());
    let mut acc = 0.0f64;
    for t in f {
        let [a, b, c] = t.map(|i| p[i as usize]);
        acc += 0.5 * (b - a).cross(c - a).length() as f64;
        cdf.push(acc);
    }
    let n = (acc / (spacing as f64 * spacing as f64)) as usize + 1;
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let x = rng.next_f32() as f64 * acc;
        let ti = cdf.partition_point(|&c| c <= x).min(f.len() - 1);
        let (mut u, mut v) = (rng.next_f32(), rng.next_f32());
        if u + v > 1.0 {
            (u, v) = (1.0 - u, 1.0 - v);
        }
        let w = 1.0 - u - v;
        let [i0, i1, i2] = f[ti].map(|i| i as usize);
        let pos = p[i0] * w + p[i1] * u + p[i2] * v;
        if pos.y > -0.02 {
            out.push((pos, unit(vn[i0] * w + vn[i1] * u + vn[i2] * v)));
        }
    }
    out
}

fn paint(pos: Vec3, nrm: Vec3, noise: &Perlin, base: Mat, moss: f32, size: f32) -> Mat {
    let s = 1.0 / size.max(0.3);
    let crack = noise.noise3(pos.x * 2.2 * s, pos.y * 3.0 * s, pos.z * 2.2 * s).abs() < 0.06;
    if crack {
        return Mat::RockCrack;
    }
    let mut m = base;
    if noise.fbm(pos.x * 5.0 * s + 9.0, pos.y * 5.0 * s, pos.z * 5.0 * s, 2) > 0.46 {
        m = Mat::Lichen;
    }
    if moss > 0.0 {
        let v = nrm.y + 0.35 * noise.fbm(pos.x * 1.5 * s, pos.y * 1.5 * s + 4.0, pos.z * 1.5 * s, 3);
        if v > 1.05 - 0.45 * moss {
            m = Mat::Moss;
        }
    }
    m
}

const ROCK_TYPES: [Mat; 4] = [Mat::Rock, Mat::Rock, Mat::RockSand, Mat::RockDark];

pub fn make_rock(seed: u32, kind: RockKind) -> Asset {
    let mut rng = Pcg32::new(seed as u64, 0x50c4);
    let noise = Perlin::new(seed as u64 + 77);
    let p = preset(kind);
    let base = ROCK_TYPES[rng.int(0, 4) as usize];
    let mut asset = Asset::new(format!("rock_{}", kind.name()));

    let mut stone = |rng: &mut Pcg32, center: Vec3, radius: f32, cuts: u32, level: u32, moss: Option<f32>| {
        let sc = [0, 1, 2].map(|k| p.scale[k] * rng.uniform(0.85, 1.15));
        let (mut pts, f) = stone_mesh(rng, &noise, radius, sc, p.lump, cuts, level);
        let yaw = rng.uniform(0.0, TAU);
        let (s, c) = yaw.sin_cos();
        for q in &mut pts {
            *q = Vec3::new(q.x * c + q.z * s, q.y, -q.x * s + q.z * c) + center;
        }
        let spacing = (radius * 0.035).max(0.012);
        let mo = moss.unwrap_or_else(|| rng.uniform(p.moss.0, p.moss.1));
        for (pos, nrm) in sample_surface(&pts, &f, spacing, rng) {
            asset.surfel(pos, nrm, spacing, paint(pos, nrm, &noise, base, mo, radius));
        }
        // Solid body from the coarse (level-2) faces: an icosphere's first 162
        // vertices are exactly the level-2 ones, so they index the same deformed
        // points (320 triangles instead of 5120). Shrunk so cards sit on top.
        let c0 = center + Vec3::new(0.0, radius * 0.2, 0.0);
        let coarse = if level > 2 { icosphere(2).1 } else { f.clone() };
        for t in &coarse {
            let tri = t.map(|i| {
                let q = pts[i as usize];
                c0 + (q - c0) * 0.97
            });
            if tri.iter().any(|q| q.y > -0.05) {
                asset.solids.push(tri);
            }
        }
    };

    match kind {
        RockKind::Pebbles => {
            for _ in 0..rng.int(6, 15) {
                let (ang, rr) = (rng.uniform(0.0, TAU), 0.6 * rng.next_f32().sqrt());
                let r = rng.uniform(p.r.0, p.r.1);
                let cuts = rng.int(p.cuts.0, p.cuts.1);
                stone(&mut rng, Vec3::new(rr * ang.cos(), 0.0, rr * ang.sin()), r, cuts, 2, Some(0.0));
            }
        }
        RockKind::Outcrop => {
            let big = rng.uniform(p.r.0, p.r.1);
            for i in 0..rng.int(3, 7) {
                let ang = rng.uniform(0.0, TAU);
                let rr = if i > 0 { big * 0.9 * rng.next_f32().sqrt() } else { 0.0 };
                let y = -rng.uniform(0.0, 0.3) * big;
                let r = big * rng.uniform(0.45, 1.0) * if i == 0 { 1.0 } else { 0.8 };
                let cuts = rng.int(p.cuts.0, p.cuts.1);
                stone(&mut rng, Vec3::new(rr * ang.cos(), y, rr * ang.sin()), r, cuts, 4, None);
            }
            for _ in 0..rng.int(4, 9) {
                let (ang, rr) = (rng.uniform(0.0, TAU), big * rng.uniform(1.1, 1.8));
                let r = rng.uniform(0.1, 0.3);
                let cuts = rng.int(2, 5);
                stone(&mut rng, Vec3::new(rr * ang.cos(), 0.0, rr * ang.sin()), r, cuts, 2, Some(0.0));
            }
        }
        _ => {
            let r = rng.uniform(p.r.0, p.r.1);
            let cuts = rng.int(p.cuts.0, p.cuts.1);
            stone(&mut rng, Vec3::ZERO, r, cuts, 4, None);
        }
    }
    asset
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icosphere_counts() {
        let (v, f) = icosphere(2);
        assert_eq!((v.len(), f.len()), (162, 320));
        assert!(v.iter().all(|p| (p.length() - 1.0).abs() < 1e-5));
    }

    #[test]
    fn every_kind_is_valid_grounded_and_deterministic() {
        for kind in RockKind::ALL {
            let a = make_rock(3, kind);
            assert!(a.is_valid(), "{kind:?}");
            assert!(a.surfels.len() > 200, "{kind:?}: {} surfels", a.surfels.len());
            assert!(!a.solids.is_empty());
            let (lo, hi) = a.bounds();
            assert!(lo.y > -0.05 && hi.y > 0.05 && hi.y < 4.0, "{kind:?} {lo:?} {hi:?}");
            assert!(a.surfels.iter().any(|s| s.mat == Mat::RockCrack));
            assert_eq!(make_rock(3, kind).surfels.len(), a.surfels.len());
        }
        // Surface normals point outward on average (up on top, etc.).
        let a = make_rock(5, RockKind::Boulder);
        let top: Vec<_> = a.surfels.iter().filter(|s| s.pos.y > a.height() * 0.8).collect();
        assert!(top.iter().map(|s| s.normal.y).sum::<f32>() / top.len() as f32 > 0.5);
    }
}
