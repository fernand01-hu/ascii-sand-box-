//! Turns a raw triangle soup (as read from STL) into a clean, normalized mesh:
//!
//! * converts Z-up (the usual CAD / 3D-printing convention) to Y-up,
//! * drops triangles with NaN/Inf coordinates or zero area,
//! * centres the model on X/Z, puts its lowest point on y = 0 and scales it so
//!   its largest dimension is `TARGET_SIZE`,
//! * welds shared vertices and computes per-corner normals that are smooth
//!   across gentle curves but stay sharp across hard edges (crease angle).
use crate::fm;

use crate::math::Vec3;
use crate::stl::Triangle;
use std::collections::HashMap;
use std::fmt;

/// Largest dimension of every model after normalization (world units).
pub const TARGET_SIZE: f32 = 2.0;
/// Edges sharper than this keep separate normals on each side.
const CREASE_DEG: f32 = 50.0;
/// Vertices shared by more faces than this fall back to flat normals, so a
/// pathological fan can't make normal smoothing quadratic.
const MAX_SMOOTH_VALENCE: usize = 256;

#[derive(Debug, Clone, PartialEq)]
pub enum MeshError {
    NoValidTriangles { input: usize },
}

impl fmt::Display for MeshError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MeshError::NoValidTriangles { input } => write!(
                f,
                "none of the {input} triangles are usable (all degenerate or non-finite)"
            ),
        }
    }
}

impl std::error::Error for MeshError {}

#[derive(Debug, Clone)]
pub struct Mesh {
    pub tris: Vec<Triangle>,
    pub corner_normals: Vec<[Vec3; 3]>,
    pub face_normals: Vec<Vec3>,
    pub areas: Vec<f32>,
    pub total_area: f64,
    pub bounds_min: Vec3,
    pub bounds_max: Vec3,
    /// How many input triangles were discarded as unusable.
    pub dropped: usize,
}

impl Mesh {
    pub fn from_triangles(raw: Vec<Triangle>, z_up: bool) -> Result<Mesh, MeshError> {
        let input = raw.len();
        let mut tris: Vec<Triangle> = raw
            .into_iter()
            .filter(|t| t.iter().all(|v| v.is_finite()))
            .map(|t| if z_up { t.map(z_up_to_y_up) } else { t })
            .collect();
        if tris.is_empty() {
            return Err(MeshError::NoValidTriangles { input });
        }

        // Normalize into a fixed frame so every later step can use absolute sizes.
        let (lo, hi) = bounds(&tris);
        let ext = hi - lo;
        let max_ext = ext.x.max(ext.y).max(ext.z);
        if !(max_ext > 0.0 && max_ext.is_finite()) {
            return Err(MeshError::NoValidTriangles { input });
        }
        let s = TARGET_SIZE / max_ext;
        let offset = Vec3::new(-(lo.x + hi.x) * 0.5, -lo.y, -(lo.z + hi.z) * 0.5);
        for t in &mut tris {
            for v in t.iter_mut() {
                *v = (*v + offset) * s;
            }
        }

        // Drop zero-area triangles (after scaling, so the threshold is absolute).
        let min_area = 1e-12_f32;
        let mut face_normals = Vec::with_capacity(tris.len());
        let mut areas = Vec::with_capacity(tris.len());
        tris.retain(|t| {
            let c = (t[1] - t[0]).cross(t[2] - t[0]);
            let area = 0.5 * c.length();
            match c.try_normalize() {
                Some(n) if area > min_area => {
                    face_normals.push(n);
                    areas.push(area);
                    true
                }
                _ => false,
            }
        });
        if tris.is_empty() {
            return Err(MeshError::NoValidTriangles { input });
        }

        let corner_normals = corner_normals(&tris, &face_normals, &areas);
        let total_area = areas.iter().map(|&a| a as f64).sum();
        let (bounds_min, bounds_max) = bounds(&tris);
        Ok(Mesh {
            dropped: input - tris.len(),
            tris,
            corner_normals,
            face_normals,
            areas,
            total_area,
            bounds_min,
            bounds_max,
        })
    }

    /// Flat xyz positions, 9 floats per triangle (non-indexed).
    pub fn flat_positions(&self) -> Vec<f32> {
        flatten(self.tris.iter())
    }

    /// Flat xyz normals matching `flat_positions`.
    pub fn flat_normals(&self) -> Vec<f32> {
        flatten(self.corner_normals.iter())
    }
}

fn z_up_to_y_up(v: Vec3) -> Vec3 {
    Vec3::new(v.x, v.z, -v.y)
}

fn bounds(tris: &[Triangle]) -> (Vec3, Vec3) {
    let mut lo = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
    let mut hi = -lo;
    for t in tris {
        for &v in t {
            lo = lo.min(v);
            hi = hi.max(v);
        }
    }
    (lo, hi)
}

fn flatten<'a>(it: impl Iterator<Item = &'a [Vec3; 3]>) -> Vec<f32> {
    let mut out = Vec::new();
    for t in it {
        for v in t {
            out.extend_from_slice(&[v.x, v.y, v.z]);
        }
    }
    out
}

/// Weld identical positions, then for each triangle corner average the normals
/// of the faces around that vertex that are within the crease angle.
fn corner_normals(tris: &[Triangle], face_n: &[Vec3], areas: &[f32]) -> Vec<[Vec3; 3]> {
    // Positions are normalized to ~[-1, 2], so a fixed quantum works for all models.
    const Q: f32 = 1e-5;
    let key = |v: Vec3| ((v.x / Q).round() as i32, (v.y / Q).round() as i32, (v.z / Q).round() as i32);

    let mut ids: HashMap<(i32, i32, i32), u32> = HashMap::with_capacity(tris.len() * 3 / 2);
    let mut corner_vid = Vec::with_capacity(tris.len() * 3);
    for t in tris {
        for &v in t {
            let next = ids.len() as u32;
            corner_vid.push(*ids.entry(key(v)).or_insert(next));
        }
    }

    // vertex -> incident faces, as compressed rows.
    let nv = ids.len();
    let mut start = vec![0u32; nv + 1];
    for &v in &corner_vid {
        start[v as usize + 1] += 1;
    }
    for i in 0..nv {
        start[i + 1] += start[i];
    }
    let mut fill = start.clone();
    let mut faces = vec![0u32; corner_vid.len()];
    for (c, &v) in corner_vid.iter().enumerate() {
        faces[fill[v as usize] as usize] = (c / 3) as u32;
        fill[v as usize] += 1;
    }

    let cos_crease = fm::cos(CREASE_DEG.to_radians());
    let mut out = Vec::with_capacity(tris.len());
    for f in 0..tris.len() {
        let fnorm = face_n[f];
        let mut corners = [fnorm; 3];
        for (k, corner) in corners.iter_mut().enumerate() {
            let v = corner_vid[f * 3 + k] as usize;
            let ring = &faces[start[v] as usize..start[v + 1] as usize];
            if ring.len() > MAX_SMOOTH_VALENCE {
                continue;
            }
            let mut sum = Vec3::ZERO;
            for &g in ring {
                let gn = face_n[g as usize];
                if gn.dot(fnorm) >= cos_crease {
                    sum += gn * areas[g as usize];
                }
            }
            if let Some(n) = sum.try_normalize() {
                *corner = n;
            }
        }
        out.push(corners);
    }
    out
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// Axis-aligned unit cube, 12 triangles, outward winding.
    pub fn cube() -> Vec<Triangle> {
        let p = |x: f32, y: f32, z: f32| Vec3::new(x, y, z);
        let quads = [
            [p(0., 0., 1.), p(1., 0., 1.), p(1., 1., 1.), p(0., 1., 1.)],
            [p(1., 0., 0.), p(0., 0., 0.), p(0., 1., 0.), p(1., 1., 0.)],
            [p(1., 0., 1.), p(1., 0., 0.), p(1., 1., 0.), p(1., 1., 1.)],
            [p(0., 0., 0.), p(0., 0., 1.), p(0., 1., 1.), p(0., 1., 0.)],
            [p(0., 1., 1.), p(1., 1., 1.), p(1., 1., 0.), p(0., 1., 0.)],
            [p(0., 0., 0.), p(1., 0., 0.), p(1., 0., 1.), p(0., 0., 1.)],
        ];
        quads.iter().flat_map(|q| [[q[0], q[1], q[2]], [q[0], q[2], q[3]]]).collect()
    }

    #[test]
    fn normalizes_into_target_frame() {
        let scaled: Vec<Triangle> = cube().into_iter().map(|t| t.map(|v| v * 37.0 + Vec3::new(100., -5., 3.))).collect();
        let m = Mesh::from_triangles(scaled, false).unwrap();
        assert!((m.bounds_min.y).abs() < 1e-5);
        assert!((m.bounds_max.y - TARGET_SIZE).abs() < 1e-4);
        assert!((m.bounds_min.x + m.bounds_max.x).abs() < 1e-4);
        assert!((m.bounds_min.z + m.bounds_max.z).abs() < 1e-4);
        assert!((m.total_area - 6.0 * 4.0).abs() < 1e-3);
    }

    #[test]
    fn cube_keeps_hard_edges() {
        let m = Mesh::from_triangles(cube(), false).unwrap();
        for (f, cn) in m.corner_normals.iter().enumerate() {
            for n in cn {
                assert!(n.dot(m.face_normals[f]) > 0.9999, "corner normal bled across a 90° edge");
            }
        }
    }

    #[test]
    fn z_up_conversion() {
        // A tall box along Z must become tall along Y.
        let tall: Vec<Triangle> = cube().into_iter().map(|t| t.map(|v| Vec3::new(v.x, v.y, v.z * 4.0))).collect();
        let m = Mesh::from_triangles(tall, true).unwrap();
        let ext = m.bounds_max - m.bounds_min;
        assert!(ext.y > ext.x * 3.9 && ext.y > ext.z * 3.9);
    }

    #[test]
    fn drops_bad_triangles() {
        let mut t = cube();
        t.push([Vec3::ZERO, Vec3::ZERO, Vec3::X]); // degenerate
        t.push([Vec3::new(f32::NAN, 0., 0.), Vec3::X, Vec3::Y]); // NaN
        let m = Mesh::from_triangles(t, false).unwrap();
        assert_eq!(m.tris.len(), 12);
        assert_eq!(m.dropped, 2);
    }

    #[test]
    fn all_bad_is_an_error() {
        let t = vec![[Vec3::ZERO, Vec3::ZERO, Vec3::ZERO]];
        assert!(Mesh::from_triangles(t, false).is_err());
        let t = vec![[Vec3::new(f32::INFINITY, 0., 0.), Vec3::X, Vec3::Y]];
        assert!(Mesh::from_triangles(t, false).is_err());
    }

    #[test]
    fn flat_buffers_match() {
        let m = Mesh::from_triangles(cube(), false).unwrap();
        assert_eq!(m.flat_positions().len(), 12 * 9);
        assert_eq!(m.flat_normals().len(), 12 * 9);
    }
}
