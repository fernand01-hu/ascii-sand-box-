//! The sky and the weather: a dome of sky glyphs (port of `Sky` in
//! `scenery/terrain.py`, adapted to a free-orbit camera), the sun and wind
//! directions, and the rain and blowing-leaf particles the shader animates.
//! None of this depends on the ground, so it works over any map.

use super::asset::{basis, smoothstep, unit, RngExt, UP};
use super::perlin::Perlin;
use super::skin::{CardMode, Skinner, View};
use super::style::Mat;
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::PI;

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

// ---- sky ---------------------------------------------------------------------------

pub struct Palette {
    el: &'static [f32],
    col: &'static [[f32; 3]],
    b_el: &'static [f32],
    b: &'static [f32],
    cloud_lo: [f32; 3],
    cloud_hi: [f32; 3],
    alpha: f32,
    stars: bool,
}

pub const DUSK: Palette = Palette {
    el: &[-10.0, 0.0, 2.5, 7.0, 16.0, 32.0, 60.0, 90.0],
    col: &[[70., 76., 110.], [96., 104., 146.], [152., 132., 168.], [230., 152., 160.], [150., 118., 172.], [60., 82., 152.], [28., 40., 92.], [20., 28., 72.]],
    b_el: &[-10.0, 0.0, 3.0, 8.0, 20.0, 45.0, 90.0],
    b: &[0.45, 0.6, 0.78, 0.74, 0.5, 0.3, 0.18],
    cloud_lo: [255., 196., 160.],
    cloud_hi: [150., 136., 186.],
    alpha: 0.8,
    stars: true,
};

pub const DAY: Palette = Palette {
    el: &[-10.0, 0.0, 4.0, 12.0, 30.0, 60.0, 90.0],
    col: &[[150., 170., 190.], [200., 214., 226.], [178., 204., 230.], [128., 172., 228.], [84., 138., 216.], [60., 112., 200.], [50., 98., 188.]],
    b_el: &[-10.0, 0.0, 5.0, 20.0, 60.0, 90.0],
    b: &[0.5, 0.7, 0.62, 0.48, 0.36, 0.3],
    cloud_lo: [250., 248., 244.],
    cloud_hi: [236., 240., 248.],
    alpha: 0.85,
    stars: false,
};

fn interp(x: f32, xs: &[f32], ys: &[f32]) -> f32 {
    if x <= xs[0] {
        return ys[0];
    }
    for i in 1..xs.len() {
        if x <= xs[i] {
            let t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
            return ys[i - 1] + (ys[i] - ys[i - 1]) * t;
        }
    }
    ys[ys.len() - 1]
}

pub struct Sky {
    pub pal: &'static Palette,
    noise: Perlin,
}

impl Sky {
    pub fn new(seed: u32, pal: &'static Palette) -> Sky {
        Sky { pal, noise: Perlin::new(seed as u64 * 13 + 5) }
    }

    /// Colour (0-255), brightness (ramp position) and elevation (degrees).
    pub fn color(&self, d: Vec3) -> ([f32; 3], f32, f32) {
        let el = d.y.clamp(-1.0, 1.0).asin().to_degrees();
        let p = self.pal;
        let col = [0, 1, 2].map(|k| interp(el, p.el, &p.col.iter().map(|c| c[k]).collect::<Vec<_>>()));
        (col, interp(el, p.b_el, p.b), el)
    }

    pub fn clouds(&self, d: Vec3, el: f32) -> f32 {
        let y = d.y.max(0.03);
        let (u, v) = (d.x / y * 0.9, d.z / y * 0.9);
        let c = self.noise.fbm(u * 0.9 + 3.1, v * 2.4, 0.5, 6);
        smoothstep(0.08, 0.38, c) * smoothstep(3.0, 10.0, el) * smoothstep(55.0, 25.0, el)
    }
}

/// Dome of sky glyphs around `center`: colour and ramp character by
/// elevation, clouds, and stars at dusk.
pub fn sky_dome(sk: &mut Skinner, sky: &Sky, center: Vec3, radius: f32, view: &View, seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x5c7);
    let ang = 15.0 / view.focal; // one glyph, in radians
    let spacing = 0.55 * ang; // the original's sky grid is ~0.5 glyph
    let total = (4.0 * PI / (spacing * spacing)) as usize;
    let ramp: Vec<char> = Mat::Sky.def().chars.chars().collect();
    let aspect = sk.aspect;
    for i in 0..total {
        let y = 1.0 - 2.0 * (i as f32 + 0.5) / total as f32;
        if y < -0.21 || !rng.chance(0.75) {
            continue;
        }
        let r = (1.0 - y * y).sqrt();
        let phi = i as f32 * 2.399_963;
        // Jitter about half a spacing so the spiral lattice doesn't show as stripes.
        let d0 = Vec3::new(r * phi.cos(), y, r * phi.sin());
        let (t1, t2) = basis(d0);
        let d = unit(d0 + (t1 * rng.uniform(-0.5, 0.5) + t2 * rng.uniform(-0.5, 0.5)) * spacing);
        let (mut col, b, el) = sky.color(d);
        let cl = sky.clouds(d, el);
        let b = (b + 0.5 * cl + rng.gauss(0.06)).clamp(0.0, 1.0);
        let warm = smoothstep(30.0, 6.0, el);
        for (k, c) in col.iter_mut().enumerate() {
            let cc = sky.pal.cloud_hi[k] * (1.0 - warm) + sky.pal.cloud_lo[k] * warm;
            *c = *c * (1.0 - cl) + cc * cl;
        }
        let idx = ((b * (ramp.len() - 1) as f32).round() as usize).min(ramp.len() - 1);
        let glyph = sk.glyph_for_char(ramp[idx]);
        let size = radius * ang * rng.uniform(0.85, 1.0);
        let (u, v) = facing(d, &mut rng);
        let c = center + d * radius;
        sk.push(c, u * (size * aspect), v * size, col.map(|x| x / 255.0), sky.pal.alpha, glyph, Mat::Sky, CardMode::Emissive);
        if sky.pal.stars && el > 30.0 && rng.chance(0.012) {
            let g = sk.glyph(Mat::Star);
            let s = rng.uniform(0.6, 1.0);
            sk.push(center + d * (radius * 0.999), u * (size * aspect * 0.8), v * (size * 0.8), [0.92 * s, 0.92 * s, 1.0 * s], 1.0, g, Mat::Star, CardMode::Emissive);
        }
    }
}

/// Card axes facing back along `d` (toward the centre), turned a little.
fn facing(d: Vec3, rng: &mut Pcg32) -> (Vec3, Vec3) {
    let right = unit(d.cross(UP));
    let right = if right == Vec3::ZERO { Vec3::X } else { right };
    let up = right.cross(d);
    let (yaw, roll) = (rng.gauss(0.3), rng.gauss(0.08));
    let u = right * yaw.cos() + d * yaw.sin();
    let u = u * roll.cos() + up * roll.sin();
    let mut v = unit(u.cross(d) * -1.0);
    if v.dot(up) < 0.0 {
        v = -v;
    }
    (u, v)
}

// ---- weather particles -----------------------------------------------------------------

/// Size of the box that follows the camera for rain (metres).
pub const RAIN_BOX: [f32; 3] = [36.0, 24.0, 36.0];

/// Rain streaks: seeds inside a box the shader wraps round the camera.
pub fn rain(sk: &mut Skinner, count: usize, seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x4a17);
    let aspect = sk.aspect;
    let rm = Mat::Rain.def();
    for _ in 0..count {
        let p = Vec3::new(rng.uniform(0.0, RAIN_BOX[0]), rng.uniform(0.0, RAIN_BOX[1]), rng.uniform(0.0, RAIN_BOX[2]));
        let len = rng.uniform(0.35, 0.6);
        let glyph = sk.glyph(Mat::Rain);
        let alb = rm.albedo.map(|v| v * rng.uniform(0.85, 1.15));
        sk.push(p, Vec3::X * (len * aspect * 0.6), -UP * len, alb, rng.uniform(rm.alpha.0, rm.alpha.1), glyph, Mat::Rain, CardMode::Rain);
    }
}

/// Blown leaves: seeds in a box of side `size` (x, z in [0, size), y the
/// height above the camera's feet). The shader keeps the box round the
/// camera, carries the leaves downwind and tumbles them.
pub fn drifting_leaves(sk: &mut Skinner, count: usize, size: f32, view: &View, seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x1ea5);
    let aspect = sk.aspect;
    let palette = [[0.75, 0.35, 0.08], [0.85, 0.62, 0.12], [0.62, 0.16, 0.06], [0.40, 0.48, 0.12], [0.70, 0.50, 0.20]];
    let chars = [Mat::LeafOak, Mat::LeafMaple, Mat::LeafBirch];
    let g = (15.0 * 12.0 / view.focal).max(0.12);
    for _ in 0..count {
        let p = Vec3::new(rng.uniform(0.0, size), rng.uniform(0.3, 5.0), rng.uniform(0.0, size));
        let ax = unit(rng.gauss3(1.0));
        let ax = if ax == Vec3::ZERO { UP } else { ax };
        let (u, v) = basis(ax);
        let s = g * rng.uniform(0.8, 1.2);
        let glyph = sk.glyph(chars[rng.below(3) as usize]);
        let alb = palette[rng.below(palette.len() as u32) as usize].map(|c| c * rng.uniform(0.85, 1.15));
        sk.push(p, u * (s * aspect), v * s, alb, 0.95, glyph, Mat::LeafMaple, CardMode::Drift);
    }
}
