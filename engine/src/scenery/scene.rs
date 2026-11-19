//! Whole scenes from a preset and a seed (port of `scenery/scenes.py`):
//! terrain preset + biome + time of day + camera height, then scatter, skin,
//! ground / water / sky, weather particles and baked light.
use crate::fm;

use super::asset::{unit, Placement};
use super::landscape::{self, Sky, View, DAY, DUSK};
use super::light::Occlusion;
use super::scatter::{scatter, Biome};
use super::skin::{Glyphs, Skinner};
use super::terrain::{Terrain, TerrainPreset};
use crate::cards::STRIDE;
use crate::math::Vec3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScenePreset {
    Meadow,
    Forest,
    Lake,
    Valley,
    Alpine,
}

impl ScenePreset {
    pub const ALL: [ScenePreset; 5] = [ScenePreset::Meadow, ScenePreset::Forest, ScenePreset::Lake, ScenePreset::Valley, ScenePreset::Alpine];

    pub fn parse(s: &str) -> Option<ScenePreset> {
        Self::ALL.into_iter().find(|p| p.name() == s)
    }

    pub fn name(self) -> &'static str {
        ["meadow", "forest", "lake", "valley", "alpine"][self as usize]
    }

    fn spec(self) -> (TerrainPreset, Biome, bool, f32, bool) {
        // terrain, biome, daytime, camera height, look across the water
        match self {
            ScenePreset::Meadow => (TerrainPreset::Hills, Biome::Meadow, false, 4.0, false),
            ScenePreset::Forest => (TerrainPreset::Hills, Biome::Forest, false, 3.0, false),
            ScenePreset::Lake => (TerrainPreset::Lake, Biome::Lakeside, false, 4.0, true),
            ScenePreset::Valley => (TerrainPreset::Valley, Biome::Meadow, true, 6.0, false),
            ScenePreset::Alpine => (TerrainPreset::Rocky, Biome::Alpine, true, 6.0, false),
        }
    }
}

/// Sun directions of the `dusk` and `day` presets (light.py).
pub fn sun_for(day: bool) -> Vec3 {
    if day {
        unit(Vec3::new(-0.45, 0.78, 0.43))
    } else {
        unit(Vec3::new(-0.75, 0.33, 0.45))
    }
}

/// Default wind: from the west-north-west, blowing toward +x.
pub fn wind_dir() -> [f32; 2] {
    let w = unit(Vec3::new(0.9, 0.0, -0.45));
    [w.x, w.z]
}

pub struct SceneOut {
    pub cards: Vec<f32>,
    pub body: Vec<[Vec3; 3]>,
    pub eye: Vec3,
    /// Orbit centre on the default line of sight.
    pub target: Vec3,
    pub fov: f32,
    pub day: bool,
    pub wind: [f32; 2],
    /// Blowing-leaf box: min x, min z, size.
    pub leaf_box: [f32; 3],
    pub placed: usize,
    pub variants: usize,
    /// For walking: the terrain heightfield (n x n over size metres),
    /// lake level and mask, and colliders (x, z, radius, top y).
    pub heights: Vec<f32>,
    pub grid_n: usize,
    pub grid_size: f32,
    pub water: Option<f32>,
    pub water_mask: Vec<u8>,
    pub colliders: Vec<[f32; 4]>,
}

/// The original's default camera: a raised viewpoint near the front edge,
/// or (focus on water) back from the nearest shore looking across.
fn default_camera(t: &Terrain, height: f32, focus_water: bool) -> (Vec3, Vec3) {
    let mut x = 0.0;
    let mut cz = t.half - 40.0;
    let mut look_z = -25.0;
    if focus_water && t.water.is_some() {
        let (sx, sz) = t.water_seed;
        x = sx;
        let mut z = cz;
        while z > sz {
            if t.is_water(x, z) {
                cz = cz.min(z + 22.0);
                look_z = sz - 30.0;
                break;
            }
            z -= 1.0;
        }
    }
    let mut gy = t.height(x, cz);
    let mut ty = t.height(x, look_z);
    if let Some(w) = t.water {
        gy = gy.max(w);
        ty = ty.max(w);
    }
    (Vec3::new(x, gy + height, cz), Vec3::new(x, ty + height * 0.1, look_z))
}

pub fn build_scene(preset: ScenePreset, seed: u32, glyph_aspect: f32) -> SceneOut {
    let (tp, biome, day, cam_h, focus_water) = preset.spec();
    let t = Terrain::new(seed, tp);
    let (eye, look) = default_camera(&t, cam_h, focus_water);
    // Orbit about a point ~35 m along the line of sight (same first view).
    let dir = unit(look - eye);
    let mut target = eye + dir * 35.0;
    target.y = target.y.max(t.height(target.x, target.z) + 1.0);
    let fov: f32 = 50.0;
    let view = View { eye, focus: target, focal: 500.0 / fm::tan(fov.to_radians() / 2.0), near: 2.0 };
    let sun = sun_for(day);
    let glint = if day { [1.0, 0.98, 0.92] } else { [1.0, 0.86, 0.62] };
    let sky = Sky::new(seed, if day { &DAY } else { &DUSK });

    let sc = scatter(&t, eye, target, biome, seed);
    let glyphs = Glyphs::new();
    let mut sk = Skinner::new(&glyphs, 0.1, glyph_aspect, seed as u64);
    for p in &sc.placed {
        skin_placed(&mut sk, &sc.library.assets[p.asset], p.pl, &view);
    }
    landscape::ground(&mut sk, &t, &sc.canopy, &sky, &view, sun, glint, seed);
    landscape::streams(&mut sk, &t, &sky, &view, sun, glint, seed);

    // Light the scene before the sky and particles (they are not lit).
    let occ = Occlusion::with_max_cells(&sk.occluders, 2.0e6);
    sk.light(&occ, sun, &|p| t.sun_visibility(p, sun), Some(eye));

    // Built round the origin: the shader keeps the dome centred on the camera.
    landscape::sky_dome(&mut sk, &sky, Vec3::ZERO, 900.0, &view, seed);
    landscape::rain(&mut sk, 7000, seed);
    let half_box = 45.0;
    landscape::leaves(&mut sk, &t, &view, 900, half_box, seed);

    // Colliders for walking: trunks, rocks, big bushes.
    let mut colliders = Vec::new();
    for p in &sc.placed {
        let a = &sc.library.assets[p.asset];
        let (lo, hi) = a.bounds();
        let s = p.pl.scale;
        let (x, z) = (p.pl.pos.x, p.pl.pos.z);
        let top = p.pl.pos.y + hi.y * s;
        match p.kind {
            super::scatter::Kind::Tree(_) => {
                let r = a.wood.iter().filter(|w| w.level == 0 && w.p0.y < 1.0).map(|w| w.r).fold(0.0, f32::max);
                if r > 0.0 {
                    colliders.push([x, z, r * s + 0.05, top]);
                }
            }
            super::scatter::Kind::Rock(_) => {
                let r = (hi.x - lo.x).max(hi.z - lo.z) * s * 0.4;
                if r > 0.15 {
                    colliders.push([x, z, r, top]);
                }
            }
            super::scatter::Kind::Bush(_) => {
                let w = (hi.x - lo.x).max(hi.z - lo.z) * s;
                if w > 1.2 {
                    colliders.push([x, z, w * 0.3, top]);
                }
            }
            super::scatter::Kind::Plant(_) => {}
        }
    }

    let mut body = t.body(2.5, 0.08);
    body.append(&mut sk.solids);
    let _ = Placement::at(Vec3::ZERO);
    SceneOut {
        placed: sc.placed.len(),
        variants: sc.library.assets.len(),
        cards: std::mem::take(&mut sk.cards),
        body,
        eye,
        target,
        fov,
        day,
        wind: wind_dir(),
        leaf_box: [target.x - half_box, target.z - half_box, half_box * 2.0],
        grid_n: t.n,
        grid_size: t.size,
        water: t.water,
        water_mask: t.water_mask().to_vec(),
        colliders,
        heights: t.h.clone(),
    }
}

/// Skin one placed asset with the glyph size its distance calls for, opaque
/// bodies only when near, and a per-object character budget.
pub fn skin_placed(sk: &mut Skinner, a: &super::asset::Asset, pl: Placement, view: &View) {
    let eye = view.eye;
    sk.g = view.glyph_at(pl.pos);
    sk.solids_on = (pl.pos - eye).length() < 120.0;
    let start = sk.card_count();
    sk.skin(a, pl);
    // Budget: ~glyph cells covered by the silhouette, a few per cell (3 near,
    // 1.8 far as in the original, generous so crowns stay full).
    let (lo, hi) = a.bounds();
    let w = (hi.x - lo.x).max(hi.z - lo.z) * pl.scale;
    let h = (hi.y - lo.y.max(0.0)).max(0.1) * pl.scale;
    let cells = (w * h * 0.75) / (sk.g * sk.g * sk.aspect);
    let d = (pl.pos - eye).length();
    let per_cell = 3.5 * (1.8 + 1.2 * super::asset::smoothstep(90.0, 25.0, d));
    sk.cap_since(start, (cells * per_cell).ceil() as usize + 8);
}

/// Number of cards in a scene's buffer.
pub fn card_count(s: &SceneOut) -> usize {
    s.cards.len() / STRIDE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cards::layout;
    use crate::scenery::skin::{CardMode, MAX_MATERIALS};

    #[test]
    fn every_preset_builds() {
        for p in ScenePreset::ALL {
            let t0 = std::time::Instant::now();
            let s = build_scene(p, 1, 0.64);
            let n = card_count(&s);
            let mut modes = [0usize; 9];
            for c in s.cards.chunks_exact(STRIDE) {
                modes[((c[layout::GLYPH] as u32 / 1024) / MAX_MATERIALS) as usize] += 1;
            }
            eprintln!("{:7} {n:7} cards, {} placed ({} variants), {} body tris, modes {modes:?}, {} ms",
                p.name(), s.placed, s.variants, s.body.len(), t0.elapsed().as_millis());
            assert!(s.cards.iter().all(|v| v.is_finite()), "{p:?}");
            assert!(n > 100_000 && n < 3_000_000, "{p:?}: {n} cards");
            assert!(modes[CardMode::Emissive as usize] > 20_000, "sky present");
            assert!(modes[CardMode::Rain as usize] == 7000 && modes[CardMode::Drift as usize] == 900);
            assert!(s.placed > 200);
            assert_eq!(s.heights.len(), s.grid_n * s.grid_n);
            assert!(!s.colliders.is_empty() && s.colliders.iter().all(|c| c.iter().all(|v| v.is_finite()) && c[2] > 0.0));
            assert_eq!(s.water.is_some(), !s.water_mask.is_empty());
        }
    }
}


