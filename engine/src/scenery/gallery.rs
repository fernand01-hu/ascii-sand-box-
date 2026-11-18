//! Preview sheets: a row of assets on studio ground (port of
//! `scenery/gallery.py`), skinned, with baked shadows.

use super::asset::{basis, unit, Asset, Placement, RngExt, UP};
use super::bushes::{make_bush, BushKind};
use super::light::{sun_dir, Occlusion};
use super::perlin::Perlin;
use super::plants::{make_plant, PlantKind};
use super::rocks::{make_rock, RockKind};
use super::skin::{CardMode, Glyphs, Skinner};
use super::style::Mat;
use super::trees::{make_tree, TreeKind};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::{PI, TAU};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
    Rocks,
    Plants,
    Bushes,
    Trees,
}

impl Category {
    pub const ALL: [Category; 4] = [Category::Rocks, Category::Plants, Category::Bushes, Category::Trees];

    pub fn parse(s: &str) -> Option<Category> {
        match s {
            "rocks" => Some(Category::Rocks),
            "plants" => Some(Category::Plants),
            "bushes" => Some(Category::Bushes),
            "trees" => Some(Category::Trees),
            _ => None,
        }
    }
}

pub struct SceneOut {
    pub cards: Vec<f32>,
    pub body: Vec<[Vec3; 3]>,
    pub target: Vec3,
    pub eye: Vec3,
    /// Vertical field of view, degrees.
    pub fov: f32,
    /// Glyph height in metres.
    pub glyph: f32,
    pub assets: usize,
}

struct Sheet {
    assets: Vec<Asset>,
    rows: usize,
    gap: f32,
    fov: f32,
    look_down: f32,
    dist_scale: f32,
}

fn sheet(cat: Category, seed: u32) -> Sheet {
    let s = seed * 100;
    match cat {
        Category::Rocks => {
            use RockKind::*;
            let kinds = [Pebbles, Boulder, Angular, Slab, Boulder, Outcrop, Angular, Boulder];
            let assets = kinds.iter().enumerate().map(|(i, &k)| make_rock(s + i as u32, k)).collect();
            Sheet { assets, rows: 2, gap: 0.5, fov: 40.0, look_down: 0.06, dist_scale: 1.0 }
        }
        Category::Plants => {
            use PlantKind::*;
            let kinds = [Fern, Hosta, ElephantEar, Rhubarb, GrassTuft, Reeds, Wildflowers, Fern, HostaVariegated, Wildflowers];
            let assets = kinds.iter().enumerate().map(|(i, &k)| make_plant(s + i as u32, k)).collect();
            Sheet { assets, rows: 2, gap: 0.35, fov: 40.0, look_down: 0.1, dist_scale: 1.15 }
        }
        Category::Bushes => {
            use BushKind::*;
            let kinds = [SmallRound, BigRound, Wide, Berry, Flowering, Boxwood, Juniper, SmallRound];
            let assets = kinds.iter().enumerate().map(|(i, &k)| make_bush(s + i as u32, k)).collect();
            Sheet { assets, rows: 1, gap: 0.4, fov: 40.0, look_down: 0.12, dist_scale: 1.0 }
        }
        Category::Trees => {
            let assets = TreeKind::ALL.iter().enumerate().map(|(i, &k)| make_tree(s + i as u32, k)).collect();
            Sheet { assets, rows: 1, gap: 1.0, fov: 45.0, look_down: 0.12, dist_scale: 1.0 }
        }
    }
}

/// Place assets in rows along x, spaced by their footprint.
fn lay_out(assets: &[Asset], gap: f32, rows: usize) -> (Vec<Placement>, f32, f32) {
    let widths: Vec<f32> = assets
        .iter()
        .map(|a| {
            let (lo, hi) = a.bounds();
            (hi.x - lo.x).max(hi.z - lo.z).max(0.3)
        })
        .collect();
    let per_row = assets.len().div_ceil(rows);
    let row_w: Vec<f32> = (0..rows)
        .map(|r| {
            let ws = &widths[(r * per_row).min(widths.len())..((r + 1) * per_row).min(widths.len())];
            ws.iter().sum::<f32>() + gap * ws.len().saturating_sub(1) as f32
        })
        .collect();
    let max_w = widths.iter().cloned().fold(0.0, f32::max);
    let mut out = Vec::new();
    let mut x = 0.0;
    for (i, a) in assets.iter().enumerate() {
        let (r, k) = (i / per_row, i % per_row);
        if k == 0 {
            x = -row_w[r] / 2.0;
        }
        let (lo, hi) = a.bounds();
        let cx = x + widths[i] / 2.0 - (hi.x + lo.x) / 2.0;
        let z = -(r as f32) * (max_w + gap * 2.0);
        out.push(Placement::at(Vec3::new(cx, 0.0, z)));
        x += widths[i] + gap;
    }
    let height = assets.iter().map(|a| a.height()).fold(0.0, f32::max);
    (out, row_w.iter().cloned().fold(0.0, f32::max), height)
}

pub fn build_gallery(cat: Category, seed: u32, glyph_aspect: f32) -> SceneOut {
    let sh = sheet(cat, seed);
    let (placed, width, height) = lay_out(&sh.assets, sh.gap, sh.rows);

    // Camera as in the original (a 16:9 frame).
    let fov = sh.fov.to_radians();
    let aspect_wh = 16.0 / 9.0;
    let hfov = 2.0 * ((fov / 2.0).tan() * aspect_wh).atan();
    let dist = (width / 2.0 / (hfov / 2.0).tan() * 1.08).max(height / 2.0 / (fov / 2.0).tan() * 1.25) * sh.dist_scale;
    let target = Vec3::new(0.0, height * 0.45, -((sh.rows - 1) as f32) * 1.5);
    let eye = target + Vec3::new(0.0, dist * sh.look_down + height * 0.1, dist);
    // One glyph ~15 px tall at the target distance in a 900 px tall frame.
    let focal = 450.0 / (fov / 2.0).tan();
    let g = 15.0 * dist / focal;

    let glyphs = Glyphs::new();
    let mut sk = Skinner::new(&glyphs, g, glyph_aspect, seed as u64);
    for (a, &pl) in sh.assets.iter().zip(&placed) {
        sk.skin(a, pl);
    }
    let footprint = width / 2.0 + 1.0 + (sh.rows - 1) as f32 * 1.5;
    let radius = (footprint * 2.2).max(dist * 1.2);
    studio_ground(&mut sk, Vec3::new(0.0, 0.0, target.z), radius, eye, focal, seed);

    let occ = Occlusion::new(&sk.occluders);
    sk.light(&occ, sun_dir(), &|_| 1.0, None);
    SceneOut {
        cards: std::mem::take(&mut sk.cards),
        body: std::mem::take(&mut sk.solids),
        target,
        eye,
        fov: sh.fov,
        glyph: g,
        assets: sh.assets.len(),
    }
}

/// Flat studio ground, laid out like the original's screen grid: every mark
/// is about one glyph (15 px) tall *as seen from the default camera*, so
/// marks are small and dense near the camera and bigger, sparser far away.
/// They still have a fixed size in the world, so orbiting works. Grass marks
/// get a standing blade now and then; soil patches and a few flowers.
fn studio_ground(sk: &mut Skinner, center: Vec3, radius: f32, eye: Vec3, focal: f32, seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x6a0d);
    let noise = Perlin::new(seed as u64 + 31);
    let aspect = sk.aspect;
    let h = eye.y.max(0.3);
    let ground_eye = Vec3::new(eye.x, 0.0, eye.z);
    // Glyph size at distance d from the eye, and mark spacing.
    let glyph_at = |d: f32| 15.0 * d / focal;
    let spacing_at = |d: f32| 0.9 * glyph_at(d);
    // Polar rings around the eye's foot cover the disc; density 1/spacing^2.
    let reach = (ground_eye - center).length() + radius;
    let bins = 256;
    for b in 0..bins {
        // Rings get wider farther out (quadratic spacing of ring radii).
        let (fa, fb) = (b as f32 / bins as f32, (b + 1) as f32 / bins as f32);
        let (ra, rb) = (reach * fa * fa, reach * fb * fb);
        let rho = (ra + rb) / 2.0;
        let sp = spacing_at((rho * rho + h * h).sqrt());
        let expected = PI * (rb * rb - ra * ra) / (sp * sp);
        let count = (expected + rng.next_f32()) as usize;
        for _ in 0..count {
            let r = (ra * ra + rng.next_f32() * (rb * rb - ra * ra)).sqrt();
            let a = rng.uniform(0.0, TAU);
            let p = ground_eye + Vec3::new(r * a.cos(), 0.0, r * a.sin());
            let rc = (p - center).length();
            if rc > radius {
                continue;
            }
            let g = glyph_at((p - eye).length());
            let fade = 1.0 - super::asset::smoothstep(0.85 * radius, radius, rc);
            let soil = noise.fbm(p.x * 0.15, p.z * 0.15, 0.37, 3) > 0.18;
            let mat = if soil { Mat::Soil } else { Mat::GroundGrass };
            // Mark stored flat; the shader leans it toward the current camera
            // (as the original does) so glyphs never flatten into slivers.
            let n = unit(UP + rng.gauss3(0.06));
            let (b1, b2) = basis(n);
            let ang = rng.uniform(0.0, TAU);
            let ud = b1 * ang.cos() + b2 * ang.sin();
            let vd = n.cross(ud);
            let alb = mat.def().albedo.map(|c| c * (1.0 + 0.12 * rng.normal()));
            let alpha = (mat.def().alpha.0 + 0.08 * rng.next_f32()) * fade;
            let glyph = sk.glyph(mat);
            sk.push(p + UP * 0.005, ud * (g * aspect), vd * g, alb, alpha, glyph, mat, CardMode::GroundLean);
            if !soil && rng.chance(0.22) {
                let bh = g * rng.uniform(0.7, 1.0);
                let axis = unit(UP + rng.gauss3(0.3));
                let side = unit(axis.cross(Vec3::X));
                let alb = [0.22, 0.40, 0.12].map(|c| c * rng.uniform(0.8, 1.3));
                let glyph = sk.glyph(Mat::GrassBlade);
                sk.push(p + axis * (bh / 2.0), side * (bh * aspect), axis * bh, alb, 0.8 * fade, glyph, Mat::GrassBlade, CardMode::BillboardV);
            } else if rng.chance(0.01) {
                let glyph = sk.glyph(Mat::MeadowFlower);
                sk.push(p + UP * 0.02, ud * (g * 0.7 * aspect), vd * (g * 0.7), Mat::MeadowFlower.def().albedo, 0.9 * fade, glyph, Mat::MeadowFlower, CardMode::Fixed);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::{layout, STRIDE};

    #[test]
    fn every_gallery_builds_quickly_with_sane_output() {
        for cat in Category::ALL {
            let t = std::time::Instant::now();
            let s = build_gallery(cat, 1, 0.64);
            let ms = t.elapsed().as_millis();
            let n = s.cards.len() / STRIDE;
            eprintln!("{cat:?}: {} assets, {n} cards, {} solid tris, glyph {:.3} m, {ms} ms", s.assets, s.body.len(), s.glyph);
            assert!(n > 10_000 && n < 1_500_000, "{cat:?}: {n} cards");
            if let Some(i) = s.cards.iter().position(|v| !v.is_finite()) {
                let c = &s.cards[i / STRIDE * STRIDE..(i / STRIDE + 1) * STRIDE];
                panic!("{cat:?}: card {} field {} not finite: {c:?}", i / STRIDE, i % STRIDE);
            }
            assert!(s.eye.z > s.target.z && s.eye.y > 0.0);
            // Some cards are shadowed (baked light varies).
            let dark = s.cards.chunks_exact(STRIDE).filter(|c| c[layout::LIGHT] < 0.5).count();
            assert!(dark > 0, "{cat:?} has no shadows");
        }
    }

    #[test]
    fn deterministic() {
        let a = build_gallery(Category::Bushes, 3, 0.64);
        let b = build_gallery(Category::Bushes, 3, 0.64);
        assert_eq!(a.cards, b.cards);
        assert_ne!(a.cards, build_gallery(Category::Bushes, 4, 0.64).cards);
    }
}
