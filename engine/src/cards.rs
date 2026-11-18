//! Places ASCII glyph cards on a mesh surface.
//!
//! Every card is one character on a small flat quad in 3D:
//!   centre C, horizontal edge U, vertical edge V (full lengths, not halves),
//!   albedo RGB, opacity, glyph (atlas index + 1024 * material id),
//!   sun visibility, sky visibility (0..1, baked shadows; 1 = unshadowed).
//!
//! Density is set by glyph size (in normalized model units, where the model's
//! largest dimension is 2), so characters have the same on-screen size on
//! every model; the engine works out how many cards that takes.
//!
//! Points are sampled by area with a stratified CDF walk, so every triangle
//! receives almost exactly its fair share of cards (much more even than plain
//! random sampling, and spatially coherent in memory).
//!
//! Which character goes where is decided by a `GlyphRule`. The charset is a
//! ramp ordered from light to dense ink (like the script's sky ramp), and the
//! surface-driven rules map a pattern value to a position on that ramp.

use crate::math::Vec3;
use crate::mesh::Mesh;
use crate::noise;
use crate::rng::Pcg32;
use std::fmt;

/// Floats per card in the output buffer.
pub const STRIDE: usize = 16;
pub const MAX_CARDS: u32 = 2_000_000;

/// Offsets inside one card record.
pub mod layout {
    pub const CENTER: usize = 0;
    pub const U: usize = 3;
    pub const V: usize = 6;
    pub const COLOR: usize = 9; // r, g, b, alpha
    pub const GLYPH: usize = 13;
    pub const LIGHT: usize = 14; // sun visibility, sky visibility
}

/// The glyph slot packs the material id above the atlas index.
pub const MATERIAL_SHIFT: u32 = 1024;

pub fn pack_glyph(glyph: u32, material: u32) -> f32 {
    (glyph + material * MATERIAL_SHIFT) as f32
}

/// How each card's character is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GlyphRule {
    /// Uniformly random from the charset.
    Random = 0,
    /// Cellular plates and cracks (the pine bark's pattern, in 3D): light
    /// characters in the cracks, dense ones on the plates.
    Cells = 1,
    /// Smooth noise bands across the ramp.
    Noise = 2,
}

impl GlyphRule {
    pub fn from_u32(v: u32) -> Result<GlyphRule, ParamError> {
        match v {
            0 => Ok(GlyphRule::Random),
            1 => Ok(GlyphRule::Cells),
            2 => Ok(GlyphRule::Noise),
            _ => Err(ParamError(format!("unknown glyph rule {v}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CardParams {
    pub seed: u32,
    /// Card height in normalized model units (model's largest dimension = 2).
    pub glyph_size: f32,
    /// Card height relative to the average spacing between cards (>1 overlaps).
    pub size_factor: f32,
    /// Characters to use, ordered light to dense. Normalized by `normalize_charset`.
    pub charset: String,
    pub glyph_rule: GlyphRule,
    /// Size of the rule's pattern features, in normalized model units.
    pub pattern_scale: f32,
    /// Glyph cell width / height, so characters aren't stretched.
    pub glyph_aspect: f32,
    pub color: [f32; 3],
    /// Relative brightness variation between cards.
    pub color_jitter: f32,
    /// Standard deviation of the spin around the surface normal (radians).
    pub twist: f32,
    /// Standard deviation of the tilt off the surface (radians, approx).
    pub tilt: f32,
    pub alpha_min: f32,
    pub alpha_max: f32,
}

pub const DEFAULT_CHARSET: &str = ":-=+*xoO#%&8@BMW";

impl Default for CardParams {
    fn default() -> Self {
        CardParams {
            seed: 1,
            glyph_size: 0.045,
            size_factor: 1.6,
            charset: DEFAULT_CHARSET.to_string(),
            glyph_rule: GlyphRule::Cells,
            pattern_scale: 0.22,
            glyph_aspect: 0.6,
            color: [0.78, 0.62, 0.45],
            color_jitter: 0.12,
            twist: 0.25,
            tilt: 0.15,
            alpha_min: 0.8,
            alpha_max: 1.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParamError(pub String);

impl fmt::Display for ParamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid card parameters: {}", self.0)
    }
}

impl std::error::Error for ParamError {}

/// The engine's one definition of a charset: visible characters only, each
/// once, in first-seen order. The renderer builds its atlas from the result,
/// so glyph indices always line up.
pub fn normalize_charset(s: &str) -> Result<String, ParamError> {
    let mut out = String::new();
    for c in s.chars().filter(|c| !c.is_whitespace() && !c.is_control()) {
        if !out.contains(c) {
            out.push(c);
        }
    }
    let n = out.chars().count();
    if n == 0 {
        return Err(ParamError("charset has no visible characters".into()));
    }
    if n >= MATERIAL_SHIFT as usize {
        return Err(ParamError(format!("charset may hold at most {} characters", MATERIAL_SHIFT - 1)));
    }
    Ok(out)
}

impl CardParams {
    pub fn validate(&self) -> Result<(), ParamError> {
        let bad = |m: &str| Err(ParamError(m.to_string()));
        let finite = [
            self.glyph_size,
            self.size_factor,
            self.pattern_scale,
            self.glyph_aspect,
            self.color_jitter,
            self.twist,
            self.tilt,
            self.alpha_min,
            self.alpha_max,
            self.color[0],
            self.color[1],
            self.color[2],
        ];
        if finite.iter().any(|v| !v.is_finite()) {
            return bad("all values must be finite numbers");
        }
        if self.glyph_size <= 0.0 || self.size_factor <= 0.0 || self.glyph_aspect <= 0.0 || self.pattern_scale <= 0.0 {
            return bad("glyph_size, size_factor, glyph_aspect and pattern_scale must be positive");
        }
        if !(0.0..=1.0).contains(&self.alpha_min) || !(0.0..=1.0).contains(&self.alpha_max) || self.alpha_min > self.alpha_max {
            return bad("alpha range must satisfy 0 <= alpha_min <= alpha_max <= 1");
        }
        if self.color_jitter < 0.0 || self.twist < 0.0 || self.tilt < 0.0 {
            return bad("jitter, twist and tilt must not be negative");
        }
        normalize_charset(&self.charset).map(|_| ())
    }
}

/// How many cards `p.glyph_size` takes on `mesh`, capped at `MAX_CARDS`
/// (past the cap the glyphs grow instead, so the surface stays covered).
pub fn card_count(mesh: &Mesh, p: &CardParams) -> u32 {
    let spacing = (p.glyph_size / p.size_factor) as f64;
    let n = (mesh.total_area / (spacing * spacing)).round();
    n.clamp(1.0, MAX_CARDS as f64) as u32
}

/// Glyph size that gives exactly `count` cards on `mesh` (handy for tests and tools).
pub fn glyph_size_for_count(mesh: &Mesh, count: u32, size_factor: f32) -> f32 {
    ((mesh.total_area / count.max(1) as f64).sqrt() as f32) * size_factor
}

pub fn generate(mesh: &Mesh, p: &CardParams) -> Result<Vec<f32>, ParamError> {
    p.validate()?;
    let glyphs = normalize_charset(&p.charset)?.chars().count() as u32;
    let count = card_count(mesh, p);
    let n = count as usize;
    let mut rng = Pcg32::new(p.seed as u64, 0x5eed_ca7d);
    let pattern_seed = rng.next_u32() as u64;
    let base_h = (mesh.total_area / count as f64).sqrt() as f32 * p.size_factor;

    // Cumulative areas in f64: with millions of triangles f32 loses precision.
    let mut cdf = Vec::with_capacity(mesh.areas.len());
    let mut acc = 0.0f64;
    for &a in &mesh.areas {
        acc += a as f64;
        cdf.push(acc);
    }
    let total = acc;
    let last = mesh.tris.len() - 1;
    let ramp = |t: f32| ((t.clamp(0.0, 1.0) * (glyphs - 1) as f32).round() as u32).min(glyphs - 1);

    let mut out = vec![0.0f32; n * STRIDE];
    for (i, card) in out.chunks_exact_mut(STRIDE).enumerate() {
        // Stratified: sample i lands in the i-th slice of the total area.
        let t = (i as f64 + rng.next_f32() as f64) / n as f64 * total;
        let f = cdf.partition_point(|&c| c <= t).min(last);

        // Uniform point in the triangle.
        let r1 = rng.next_f32().sqrt();
        let r2 = rng.next_f32();
        let (a, b, c) = (1.0 - r1, r1 * (1.0 - r2), r1 * r2);
        let [p0, p1, p2] = mesh.tris[f];
        let [n0, n1, n2] = mesh.corner_normals[f];
        let pos = p0 * a + p1 * b + p2 * c;
        let normal = (n0 * a + n1 * b + n2 * c).try_normalize().unwrap_or(mesh.face_normals[f]);

        let (mut u, mut v) = upright_frame(normal);

        // Spin around the normal...
        let tw = rng.normal() * p.twist;
        let (s, co) = tw.sin_cos();
        (u, v) = (u * co + v * s, v * co - u * s);
        // ...and tilt a little off the surface, like the bark in the pine script.
        u = (u + normal * (rng.normal() * p.tilt)).try_normalize().unwrap_or(u);
        v = (v + normal * (rng.normal() * p.tilt)).try_normalize().unwrap_or(v);

        let h = base_h * rng.range(0.85, 1.15);
        let center = pos + normal * (0.04 * base_h);
        let mut shade = (1.0 + p.color_jitter * rng.normal()).max(0.0);
        let alpha = rng.range(p.alpha_min, p.alpha_max.max(p.alpha_min + f32::EPSILON)).min(p.alpha_max);

        let q = pos * (1.0 / p.pattern_scale);
        let glyph = match p.glyph_rule {
            GlyphRule::Random => rng.below(glyphs),
            GlyphRule::Cells => {
                let (f1, f2) = noise::worley(q, pattern_seed);
                let t = smoothstep(0.02, 0.45, f2 - f1);
                shade *= 0.55 + 0.45 * t; // cracks are darker
                ramp(t + rng.normal() * 0.06)
            }
            GlyphRule::Noise => {
                let t = smoothstep(0.25, 0.75, noise::fbm(q, pattern_seed));
                shade *= 0.7 + 0.3 * t;
                ramp(t + rng.normal() * 0.06)
            }
        };

        write3(card, layout::CENTER, center);
        write3(card, layout::U, u * (h * p.glyph_aspect));
        write3(card, layout::V, v * h);
        card[layout::COLOR] = (p.color[0] * shade).clamp(0.0, 1.0);
        card[layout::COLOR + 1] = (p.color[1] * shade).clamp(0.0, 1.0);
        card[layout::COLOR + 2] = (p.color[2] * shade).clamp(0.0, 1.0);
        card[layout::COLOR + 3] = alpha;
        card[layout::GLYPH] = pack_glyph(glyph, 0);
        card[layout::LIGHT] = 1.0;
        card[layout::LIGHT + 1] = 1.0;
    }
    Ok(out)
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// Tangent frame (U = glyph right, V = glyph up) with the glyph standing as
/// upright as possible relative to world up, and U x V pointing along the
/// normal so the glyph reads correctly when seen from outside the surface.
pub fn upright_frame(normal: Vec3) -> (Vec3, Vec3) {
    let up = Vec3::Y;
    let v = (up - normal * normal.dot(up))
        .try_normalize()
        // Horizontal faces: let the glyph's "up" point away from the camera's default side.
        .or_else(|| (-Vec3::Z - normal * normal.dot(-Vec3::Z)).try_normalize())
        .unwrap_or(Vec3::Z);
    let u = v.cross(normal);
    (u, v)
}

pub fn write3(card: &mut [f32], at: usize, v: Vec3) {
    card[at] = v.x;
    card[at + 1] = v.y;
    card[at + 2] = v.z;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::tests::cube;

    fn cube_mesh() -> Mesh {
        Mesh::from_triangles(cube(), false).unwrap()
    }

    fn get3(c: &[f32], at: usize) -> Vec3 {
        Vec3::new(c[at], c[at + 1], c[at + 2])
    }

    /// Params that produce exactly `n` cards on the normalized cube.
    fn with_count(n: u32) -> CardParams {
        let p = CardParams::default();
        CardParams { glyph_size: glyph_size_for_count(&cube_mesh(), n, p.size_factor), ..p }
    }

    #[test]
    fn output_shape_and_finiteness() {
        let p = CardParams { charset: "abcdefghijkl".into(), ..with_count(5000) };
        let out = generate(&cube_mesh(), &p).unwrap();
        assert_eq!(out.len(), 5000 * STRIDE);
        assert!(out.iter().all(|v| v.is_finite()));
        for c in out.chunks_exact(STRIDE) {
            let g = c[layout::GLYPH];
            assert!((0.0..12.0).contains(&g) && g.fract() == 0.0);
            assert!((0.0..=1.0).contains(&c[layout::COLOR + 3]));
            assert_eq!([c[layout::LIGHT], c[layout::LIGHT + 1]], [1.0, 1.0]);
        }
    }

    #[test]
    fn glyph_size_sets_density() {
        let m = cube_mesh();
        let small = card_count(&m, &CardParams { glyph_size: 0.02, ..Default::default() });
        let large = card_count(&m, &CardParams { glyph_size: 0.04, ..Default::default() });
        // Half the glyph size, four times the cards.
        assert!((small as f32 / large as f32 - 4.0).abs() < 0.01, "{small} vs {large}");
        let p = CardParams { glyph_size: 0.05, ..Default::default() };
        let out = generate(&m, &p).unwrap();
        let mean_h: f32 = out.chunks_exact(STRIDE).map(|c| get3(c, layout::V).length()).sum::<f32>()
            / (out.len() / STRIDE) as f32;
        assert!((mean_h - 0.05).abs() < 0.002, "mean card height {mean_h}");
    }

    #[test]
    fn tiny_glyphs_are_capped_not_fatal() {
        let p = CardParams { glyph_size: 1e-6, ..Default::default() };
        assert_eq!(card_count(&cube_mesh(), &p), MAX_CARDS);
    }

    #[test]
    fn charset_normalization() {
        assert_eq!(normalize_charset("a b\ta\nbc").unwrap(), "abc");
        assert_eq!(normalize_charset("ÿé@").unwrap(), "ÿé@");
        assert!(normalize_charset("  \n").is_err());
        let huge: String = (0..1100u32).filter_map(|i| char::from_u32(0x4E00 + i)).collect();
        assert!(normalize_charset(&huge).is_err());
    }

    #[test]
    fn every_rule_is_valid_and_distinct() {
        let m = cube_mesh();
        let glyph_hist = |rule| {
            let p = CardParams { glyph_rule: rule, ..with_count(4000) };
            let out = generate(&m, &p).unwrap();
            let mut h = vec![0usize; DEFAULT_CHARSET.chars().count()];
            for c in out.chunks_exact(STRIDE) {
                h[c[layout::GLYPH] as usize] += 1;
            }
            h
        };
        let random = glyph_hist(GlyphRule::Random);
        let cells = glyph_hist(GlyphRule::Cells);
        let noise = glyph_hist(GlyphRule::Noise);
        // Random is flat; the pattern rules use the whole ramp but unevenly.
        let n = random.len() as f32;
        assert!(random.iter().all(|&c| (c as f32 - 4000.0 / n).abs() < 4000.0 / n * 0.35), "{random:?}");
        for h in [&cells, &noise] {
            assert!(h.iter().filter(|&&c| c > 0).count() as f32 > n * 0.6, "{h:?}");
        }
        assert_ne!(cells, noise);
        assert!(GlyphRule::from_u32(3).is_err());
    }

    #[test]
    fn cells_rule_follows_the_surface_pattern() {
        // Neighbouring cards share a cell, so their glyphs correlate far more
        // than random picks would.
        let m = cube_mesh();
        let p = CardParams { glyph_rule: GlyphRule::Cells, ..with_count(20000) };
        let out = generate(&m, &p).unwrap();
        let cards: Vec<(Vec3, f32)> = out.chunks_exact(STRIDE).map(|c| (get3(c, layout::CENTER), c[layout::GLYPH])).collect();
        let sample = &cards[..2000];
        let (mut near, mut far) = (0.0f32, 0.0f32);
        for (i, &(p, g)) in sample.iter().enumerate() {
            let nearest = sample
                .iter()
                .enumerate()
                .filter(|&(j, _)| j != i)
                .min_by(|a, b| (a.1 .0 - p).length().total_cmp(&(b.1 .0 - p).length()))
                .unwrap();
            near += (nearest.1 .1 - g).abs();
            far += (sample[(i * 7919 + 13) % sample.len()].1 - g).abs();
        }
        assert!(near < far * 0.7, "near {near} far {far}");
    }

    #[test]
    fn deterministic_per_seed() {
        let m = cube_mesh();
        let p = with_count(2000);
        assert_eq!(generate(&m, &p).unwrap(), generate(&m, &p).unwrap());
        let q = CardParams { seed: 2, ..p.clone() };
        assert_ne!(generate(&m, &p).unwrap(), generate(&m, &q).unwrap());
    }

    #[test]
    fn cards_sit_on_the_surface_and_face_out() {
        let m = cube_mesh(); // normalized: x,z in [-1,1], y in [0,2]
        let p = CardParams { twist: 0.0, tilt: 0.0, ..with_count(3000) };
        let out = generate(&m, &p).unwrap();
        for c in out.chunks_exact(STRIDE) {
            let ctr = get3(c, layout::CENTER);
            let dist_to_surface = [1.0 - ctr.x.abs(), 1.0 - ctr.z.abs(), ctr.y, 2.0 - ctr.y]
                .iter()
                .map(|d| d.abs())
                .fold(f32::INFINITY, f32::min);
            assert!(dist_to_surface < 0.05, "card centre {ctr:?} is off the surface");
            // U x V points outward from the cube centre.
            let n = get3(c, layout::U).cross(get3(c, layout::V));
            assert!(n.dot(ctr - Vec3::new(0.0, 1.0, 0.0)) > 0.0);
        }
    }

    #[test]
    fn even_coverage_per_face() {
        let m = cube_mesh();
        let out = generate(&m, &with_count(6000)).unwrap();
        assert_eq!(out.len(), 6000 * STRIDE);
        let mut per_face = [0usize; 6];
        for c in out.chunks_exact(STRIDE) {
            let ctr = get3(c, layout::CENTER) - Vec3::new(0.0, 1.0, 0.0);
            let a = [ctr.x.abs(), ctr.y.abs(), ctr.z.abs()];
            let axis = (0..3).max_by(|&i, &j| a[i].total_cmp(&a[j])).unwrap();
            let sign = [ctr.x, ctr.y, ctr.z][axis] > 0.0;
            per_face[axis * 2 + sign as usize] += 1;
        }
        for c in per_face {
            assert!((c as i64 - 1000).abs() <= 2, "stratified sampling should be near exact: {per_face:?}");
        }
    }

    #[test]
    fn upright_frame_is_orthonormal_everywhere() {
        let mut r = Pcg32::new(5, 5);
        let mut normals = vec![Vec3::Y, -Vec3::Y, Vec3::X, Vec3::Z];
        for _ in 0..1000 {
            normals.push(Vec3::new(r.normal(), r.normal(), r.normal()).try_normalize().unwrap());
        }
        for n in normals {
            let (u, v) = upright_frame(n);
            assert!((u.length() - 1.0).abs() < 1e-4 && (v.length() - 1.0).abs() < 1e-4);
            assert!(u.dot(v).abs() < 1e-4 && u.dot(n).abs() < 1e-4 && v.dot(n).abs() < 1e-4);
            assert!(u.cross(v).dot(n) > 0.999);
        }
    }

    #[test]
    fn rejects_bad_params() {
        let m = cube_mesh();
        let bad = [
            CardParams { glyph_size: 0.0, ..Default::default() },
            CardParams { glyph_size: f32::INFINITY, ..Default::default() },
            CardParams { pattern_scale: 0.0, ..Default::default() },
            CardParams { charset: " ".into(), ..Default::default() },
            CardParams { size_factor: f32::NAN, ..Default::default() },
            CardParams { size_factor: -1.0, ..Default::default() },
            CardParams { alpha_min: 0.9, alpha_max: 0.5, ..Default::default() },
            CardParams { twist: -1.0, ..Default::default() },
        ];
        for p in bad {
            assert!(generate(&m, &p).is_err(), "{p:?} should be rejected");
        }
    }

    #[test]
    fn fixed_alpha_is_allowed() {
        let p = CardParams { alpha_min: 1.0, alpha_max: 1.0, ..with_count(100) };
        let out = generate(&cube_mesh(), &p).unwrap();
        assert!(out.chunks_exact(STRIDE).all(|c| c[layout::COLOR + 3] == 1.0));
    }
}
