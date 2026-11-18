//! The landscape skin: ground, water, sky dome and weather particles.
//! Port of `skin_view` / `classify` / `Sky` in `scenery/terrain.py`, adapted
//! to a free-orbit camera:
//!
//! * the original samples a screen grid from one camera, so every glyph is
//!   ~15 px tall. Here ground marks are placed in the world with the size that
//!   rule gives *from the default camera*, but never coarser than seen from
//!   near the orbit focus, so the ground holds up when you orbit;
//! * the sky becomes a dome of glyph cards around the scene;
//! * lake water is '~' cards coloured by the reflected sky; streams get cards
//!   that the shader slides along the flow;
//! * rain and blowing leaves are particle cards animated in the shader.

use super::asset::{basis, smoothstep, unit, RngExt, UP};
use super::perlin::Perlin;
use super::scatter::Canopy;
use super::skin::{CardMode, Skinner};
use super::style::Mat;
use super::terrain::Terrain;
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::f32::consts::{PI, TAU};

/// Where the glyph-size rule is evaluated from.
#[derive(Clone, Copy, Debug)]
pub struct View {
    pub eye: Vec3,
    pub focus: Vec3,
    /// Focal length in px for a 1000 px tall frame.
    pub focal: f32,
}

impl View {
    /// Glyph height (m) for something at `p`: 15 px from the default camera,
    /// but at least as fine as seen from a little way off the focus.
    pub fn glyph_at(&self, p: Vec3) -> f32 {
        let d_eye = (p - self.eye).length();
        let d_focus = (p - self.focus).length() + 0.5 * (self.eye - self.focus).length();
        15.0 * d_eye.min(d_focus).max(2.0) / self.focal
    }
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

// ---- ground and water ------------------------------------------------------------------

fn classify(t: &Terrain, canopy: &Canopy, p: Vec3, n: Vec3, rng: &mut Pcg32) -> Mat {
    let noise = &t.noise;
    let slope = 1.0 - n.y;
    let n1 = noise.fbm(p.x / 9.0, p.z / 9.0, 7.7, 3);
    let n2 = noise.fbm(p.x / 2.5, p.z / 2.5, 1.1, 2);
    let mut mat = Mat::GroundGrass;
    if n1 > 0.28 && n2 > -0.1 {
        mat = Mat::Soil;
    }
    if canopy.at(p.x, p.z) > 0.45 + 0.2 * n2 {
        mat = Mat::Litter;
    }
    if mat == Mat::GroundGrass && n1 < -0.25 && rng.chance(0.06) {
        mat = Mat::MeadowFlower;
    }
    if let Some(level) = t.water {
        if t.shore_dist(p.x, p.z) < 2.5 + 2.0 * n2 && p.y < level + 1.2 {
            mat = Mat::Sand;
        }
    }
    let stream = t.stream_strength(p.x, p.z);
    if stream > 0.2 {
        mat = if n2 > 0.0 { Mat::Sand } else { Mat::Soil };
    }
    if t.trail_strength(p.x, p.z) > 0.35 + 0.15 * n2 {
        mat = Mat::Trail;
    }
    if slope > 0.30 + 0.08 * n1 {
        mat = Mat::GroundRock;
    }
    if p.y > t.hmax * 0.62 + 8.0 * n1 && slope < 0.45 {
        mat = Mat::Snow;
    }
    mat
}

/// Water colour seen from `eye` at `p`: reflected sky, Fresnel, sun glint.
fn water_color(sky: &Sky, eye: Vec3, p: Vec3, sun: Vec3, glint: [f32; 3], rng: &mut Pcg32) -> [f32; 3] {
    let d = unit(p - eye);
    let wave = unit(Vec3::new(rng.gauss(0.06), 1.0, rng.gauss(0.06)));
    let dr = d - wave * (2.0 * d.dot(wave));
    let (col, _, _) = sky.color(dr);
    let fres = 0.35 + 0.55 * (1.0 - d.y.abs()).powi(4);
    let g = unit(dr).dot(sun).clamp(0.0, 1.0).powi(40) * 255.0;
    let deep = [12.0, 22.0, 34.0];
    [0, 1, 2].map(|k| ((col[k] * fres + deep[k] * (1.0 - fres) + g * glint[k]) / 255.0).min(1.2))
}

/// Ground marks over the whole terrain (plus standing grass blades and lake
/// water), sized by the glyph rule.
#[allow(clippy::too_many_arguments)]
pub fn ground(sk: &mut Skinner, t: &Terrain, canopy: &Canopy, sky: &Sky, view: &View, sun: Vec3, glint: [f32; 3], seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x960d);
    let aspect = sk.aspect;
    let cell = 4.0;
    let m = (t.size / cell) as usize;
    let water = t.water;
    for cj in 0..m {
        for ci in 0..m {
            let (x0, z0) = (-t.half + ci as f32 * cell, -t.half + cj as f32 * cell);
            let c = Vec3::new(x0 + cell / 2.0, t.height(x0 + cell / 2.0, z0 + cell / 2.0), z0 + cell / 2.0);
            // Far land (valley walls, peaks) needs the original's denser screen
            // grid to read as solid ground rather than sky.
            let far = smoothstep(60.0, 160.0, (c - view.eye).length());
            let sp = (0.9 - 0.35 * far) * view.glyph_at(c);
            // The original samples the screen, so slopes facing the camera
            // (valley walls, mountains) get as many glyphs as their screen
            // area. Scale by surface area x facing, never below flat density.
            let nc = t.normal(c.x, c.z);
            let facing = nc.dot(unit(view.eye - c)).abs();
            let boost = ((0.35 + 2.0 * facing) / nc.y.max(0.2)).clamp(1.0, 10.0);
            let count = (cell * cell / (sp * sp) * boost + rng.next_f32()) as usize;
            for _ in 0..count {
                let (x, z) = (x0 + rng.next_f32() * cell, z0 + rng.next_f32() * cell);
                if !t.inside(x, z) {
                    continue;
                }
                let y = t.height(x, z);
                let p = Vec3::new(x, y, z);
                let toward = unit(view.eye - p);
                if let Some(level) = water {
                    if t.is_water(x, z) {
                        // Several wave glyphs per sample (the original packs
                        // three per half-glyph screen sample).
                        let pw = Vec3::new(x, level, z);
                        let g = view.glyph_at(pw);
                        for _ in 0..5 {
                            let q = pw + Vec3::new(rng.gauss(1.0), 0.0, rng.gauss(1.0)) * (g * 0.5);
                            let d = unit(q - view.eye);
                            let right = unit(d.cross(UP));
                            let right = if right == Vec3::ZERO { Vec3::X } else { right };
                            let back = right.cross(UP);
                            let yaw = rng.gauss(0.2);
                            let ud = right * yaw.cos() + back * yaw.sin();
                            let tilt = rng.uniform(35.0, 60.0).to_radians();
                            let vd = unit(ud.cross(UP) * -tilt.cos() + UP * tilt.sin());
                            let s = g * rng.uniform(0.9, 1.15);
                            let col = water_color(sky, view.eye, q, sun, glint, &mut rng).map(|v| v * rng.uniform(0.85, 1.15));
                            let glyph = sk.glyph(Mat::Water);
                            sk.push(q + UP * 0.02, ud * (s * aspect), vd * s, col, 0.95, glyph, Mat::Water, CardMode::Emissive);
                        }
                        continue;
                    }
                }
                if t.stream_strength(x, z) > 0.6 {
                    continue; // the stream's own cards cover the channel
                }
                let n = t.normal(x, z);
                let mat = classify(t, canopy, p, n, &mut rng);
                let g = view.glyph_at(p);
                // Tilted toward the default camera so glyphs don't flatten.
                let nn = unit(n + toward * 0.6 + rng.gauss3(0.12));
                let a = rng.uniform(-0.5, 0.5) + if rng.chance(0.5) { 0.0 } else { PI };
                let side = unit(toward.cross(UP));
                let side = if side == Vec3::ZERO { Vec3::X } else { side };
                let ud = unit(side * a.cos() + nn.cross(side) * a.sin());
                let ud = unit(ud - nn * ud.dot(nn));
                let vd = nn.cross(ud);
                let s = g * 1.15;
                let mut alb = mat.def().albedo.map(|v| v * (1.0 + mat.def().var * rng.normal()));
                let dry = smoothstep(-0.15, 0.35, t.noise.fbm(x / 30.0 + 50.0, z / 30.0, 2.2, 3));
                if mat == Mat::GroundGrass {
                    let dc = [0.36, 0.32, 0.13];
                    alb = [0, 1, 2].map(|k| alb[k] * (1.0 - 0.6 * dry) + dc[k] * 0.6 * dry);
                }
                let alpha = mat.def().alpha.0 + 0.08 * rng.next_f32();
                let glyph = sk.glyph(mat);
                sk.push(p + n * (0.01 * s), ud * (s * aspect), vd * s, alb, alpha, glyph, mat, CardMode::Fixed);
                // Standing grass blades on grass.
                let dist = (p - view.eye).length().min((p - view.focus).length() + 10.0);
                let p_blade = 0.5 * smoothstep(160.0, 10.0, dist) * smoothstep(0.35, 0.1, 1.0 - n.y);
                if mat == Mat::GroundGrass && rng.chance(p_blade) {
                    let h = g * rng.uniform(0.9, 1.4);
                    let (tilt, tdir) = (rng.gauss(0.3), rng.uniform(0.0, TAU));
                    let vb = unit(n * 1.5 + Vec3::new(tilt.sin() * tdir.cos(), 0.0, tilt.sin() * tdir.sin()));
                    let ub = unit(vb.cross(Vec3::X + Vec3::Z * 0.3));
                    let slope_light = 0.4 + 0.6 * (n.dot(sun) / sun.y.max(0.25)).clamp(0.0, 1.15);
                    let gb = Mat::GrassBlade.def();
                    let mut ab = gb.albedo.map(|v| v * rng.uniform(0.85, 1.15) * slope_light);
                    let dc = [0.40, 0.36, 0.15];
                    ab = [0, 1, 2].map(|k| ab[k] * (1.0 - 0.6 * dry) + dc[k] * 0.6 * dry);
                    let glyph = sk.glyph(Mat::GrassBlade);
                    let alpha = gb.alpha.0 + 0.08 * rng.next_f32();
                    sk.push(p + vb * (h / 2.0), ub * (h * aspect), vb * h, ab, alpha, glyph, Mat::GrassBlade, CardMode::BillboardV);
                }
            }
        }
    }
}

/// Flowing water along each stream: cards lying in the water, U along the
/// flow (the shader slides them downstream), foam where it drops.
pub fn streams(sk: &mut Skinner, t: &Terrain, sky: &Sky, view: &View, sun: Vec3, glint: [f32; 3], seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x57e4);
    let aspect = sk.aspect;
    for s in &t.streams {
        let mut along = 0.0f32;
        for i in 1..s.pts.len() {
            let (a, b) = (s.pts[i - 1], s.pts[i]);
            let seg = b - a;
            along += seg.length();
            let g = view.glyph_at(b);
            if along < 0.55 * g {
                continue;
            }
            along = 0.0;
            let tangent = unit(Vec3::new(seg.x, 0.0, seg.z));
            let side = Vec3::new(-tangent.z, 0.0, tangent.x);
            let drop = (a.y - b.y).max(0.0) / seg.length().max(1e-3);
            let across = ((s.width / (g * aspect * 0.8)).ceil() as usize).max(1);
            for k in 0..across {
                let off = ((k as f32 + 0.5) / across as f32 - 0.5) * s.width * 0.9 + rng.gauss(0.1);
                let p = b + side * off + Vec3::new(0.0, 0.03, 0.0);
                let toward = unit(view.eye - p);
                let nn = unit(UP + toward * 0.6);
                let ud = unit(tangent - nn * tangent.dot(nn));
                let vd = nn.cross(ud);
                let foam = smoothstep(0.03, 0.12, drop) * rng.next_f32();
                let col = water_color(sky, view.eye, p, sun, glint, &mut rng).map(|v| (v * 1.1 + foam * 0.5).min(1.3));
                let sz = g * rng.uniform(0.9, 1.1);
                let glyph = sk.glyph(Mat::WaterStream);
                sk.push(p, ud * (sz * aspect), vd * sz, col, 0.95, glyph, Mat::WaterStream, CardMode::Emissive);
            }
        }
    }
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

/// Leaves blown through the scene around the focus, autumn coloured.
pub fn leaves(sk: &mut Skinner, t: &Terrain, view: &View, count: usize, half_box: f32, seed: u32) {
    let mut rng = Pcg32::new(seed as u64, 0x1ea5);
    let aspect = sk.aspect;
    let palette = [[0.75, 0.35, 0.08], [0.85, 0.62, 0.12], [0.62, 0.16, 0.06], [0.40, 0.48, 0.12], [0.70, 0.50, 0.20]];
    let chars = [Mat::LeafOak, Mat::LeafMaple, Mat::LeafBirch];
    let g = view.glyph_at(view.focus) * 0.8;
    for _ in 0..count {
        let (x, z) = (view.focus.x + rng.uniform(-half_box, half_box), view.focus.z + rng.uniform(-half_box, half_box));
        let base = if t.inside(x, z) { t.height(x, z).max(t.water.unwrap_or(f32::NEG_INFINITY)) } else { view.focus.y };
        let p = Vec3::new(x, base + rng.uniform(0.3, 5.0), z);
        let ax = unit(rng.gauss3(1.0));
        let ax = if ax == Vec3::ZERO { UP } else { ax };
        let (u, v) = basis(ax);
        let s = g * rng.uniform(0.8, 1.2);
        let glyph = sk.glyph(chars[rng.below(3) as usize]);
        let alb = palette[rng.below(palette.len() as u32) as usize].map(|c| c * rng.uniform(0.85, 1.15));
        sk.push(p, u * (s * aspect), v * s, alb, 0.95, glyph, Mat::LeafMaple, CardMode::Drift);
    }
}
