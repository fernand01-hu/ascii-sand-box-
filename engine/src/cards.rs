//! Places ASCII glyph cards on a mesh surface.
//!
//! Every card is one character on a small flat quad in 3D:
//!   centre C, horizontal edge U, vertical edge V (full lengths, not halves),
//!   albedo RGB, opacity, glyph (atlas index + 1024 * material id),
//!   sun visibility, sky visibility (0..1, baked shadows; 1 = unshadowed).
//!
//! Points are sampled by area with a stratified CDF walk, so every triangle
//! receives almost exactly its fair share of cards (much more even than plain
//! random sampling, and spatially coherent in memory).

use crate::math::Vec3;
use crate::mesh::Mesh;
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

#[derive(Debug, Clone, PartialEq)]
pub struct CardParams {
    pub seed: u32,
    pub count: u32,
    /// Card height relative to the average spacing between cards (>1 overlaps).
    pub size_factor: f32,
    /// Number of glyphs in the atlas; indices are drawn from [0, glyph_count).
    pub glyph_count: u32,
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

impl Default for CardParams {
    fn default() -> Self {
        CardParams {
            seed: 1,
            count: 60_000,
            size_factor: 1.6,
            glyph_count: 1,
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

impl CardParams {
    pub fn validate(&self) -> Result<(), ParamError> {
        let bad = |m: &str| Err(ParamError(m.to_string()));
        let finite = [
            self.size_factor,
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
        if self.count == 0 {
            return bad("count must be at least 1");
        }
        if self.count > MAX_CARDS {
            return Err(ParamError(format!("count must be at most {MAX_CARDS}")));
        }
        if self.glyph_count == 0 {
            return bad("glyph_count must be at least 1");
        }
        if self.size_factor <= 0.0 || self.glyph_aspect <= 0.0 {
            return bad("size_factor and glyph_aspect must be positive");
        }
        if !(0.0..=1.0).contains(&self.alpha_min) || !(0.0..=1.0).contains(&self.alpha_max) || self.alpha_min > self.alpha_max {
            return bad("alpha range must satisfy 0 <= alpha_min <= alpha_max <= 1");
        }
        if self.color_jitter < 0.0 || self.twist < 0.0 || self.tilt < 0.0 {
            return bad("jitter, twist and tilt must not be negative");
        }
        Ok(())
    }
}

/// Average distance between neighbouring cards for `count` cards on `mesh`.
pub fn spacing(mesh: &Mesh, count: u32) -> f32 {
    (mesh.total_area / count.max(1) as f64).sqrt() as f32
}

pub fn generate(mesh: &Mesh, p: &CardParams) -> Result<Vec<f32>, ParamError> {
    p.validate()?;
    let n = p.count as usize;
    let mut rng = Pcg32::new(p.seed as u64, 0x5eed_ca7d);
    let base_h = spacing(mesh, p.count) * p.size_factor;

    // Cumulative areas in f64: with millions of triangles f32 loses precision.
    let mut cdf = Vec::with_capacity(mesh.areas.len());
    let mut acc = 0.0f64;
    for &a in &mesh.areas {
        acc += a as f64;
        cdf.push(acc);
    }
    let total = acc;
    let last = mesh.tris.len() - 1;

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
        let shade = (1.0 + p.color_jitter * rng.normal()).max(0.0);
        let alpha = rng.range(p.alpha_min, p.alpha_max.max(p.alpha_min + f32::EPSILON)).min(p.alpha_max);
        let glyph = rng.below(p.glyph_count) as f32;

        write3(card, layout::CENTER, center);
        write3(card, layout::U, u * (h * p.glyph_aspect));
        write3(card, layout::V, v * h);
        card[layout::COLOR] = (p.color[0] * shade).clamp(0.0, 1.0);
        card[layout::COLOR + 1] = (p.color[1] * shade).clamp(0.0, 1.0);
        card[layout::COLOR + 2] = (p.color[2] * shade).clamp(0.0, 1.0);
        card[layout::COLOR + 3] = alpha;
        card[layout::GLYPH] = glyph;
        card[layout::LIGHT] = 1.0;
        card[layout::LIGHT + 1] = 1.0;
    }
    Ok(out)
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

    #[test]
    fn output_shape_and_finiteness() {
        let p = CardParams { count: 5000, glyph_count: 12, ..Default::default() };
        let out = generate(&cube_mesh(), &p).unwrap();
        assert_eq!(out.len(), 5000 * STRIDE);
        assert!(out.iter().all(|v| v.is_finite()));
        for c in out.chunks_exact(STRIDE) {
            let g = c[layout::GLYPH];
            assert!((0.0..12.0).contains(&g) && g.fract() == 0.0);
            assert!((0.0..=1.0).contains(&c[layout::COLOR + 3]));
        }
    }

    #[test]
    fn deterministic_per_seed() {
        let m = cube_mesh();
        let p = CardParams { count: 2000, ..Default::default() };
        assert_eq!(generate(&m, &p).unwrap(), generate(&m, &p).unwrap());
        let q = CardParams { seed: 2, ..p.clone() };
        assert_ne!(generate(&m, &p).unwrap(), generate(&m, &q).unwrap());
    }

    #[test]
    fn cards_sit_on_the_surface_and_face_out() {
        let m = cube_mesh(); // normalized: x,z in [-1,1], y in [0,2]
        let p = CardParams { count: 3000, twist: 0.0, tilt: 0.0, ..Default::default() };
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
        let p = CardParams { count: 6000, ..Default::default() };
        let out = generate(&m, &p).unwrap();
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
            CardParams { count: 0, ..Default::default() },
            CardParams { count: MAX_CARDS + 1, ..Default::default() },
            CardParams { glyph_count: 0, ..Default::default() },
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
        let p = CardParams { count: 100, alpha_min: 1.0, alpha_max: 1.0, ..Default::default() };
        let out = generate(&cube_mesh(), &p).unwrap();
        assert!(out.chunks_exact(STRIDE).all(|c| c[layout::COLOR + 3] == 1.0));
    }
}
