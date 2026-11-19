//! Baked light: an occlusion grid (port of `Occlusion` in `scenery/light.py`).
//!
//! Every leaf, needle spray, rock surfel and piece of wood adds its area to a
//! voxel grid. A card's sunlight is exp(-k * optical depth) marched toward the
//! sun (5 m sharp, then 5-36 m through a blurrier copy for long cast shadows
//! between plants), its skylight the same toward five sky directions. The
//! shader does the rest of the shading per frame.
use crate::fm;

use super::asset::unit;
use crate::math::Vec3;

/// Low warm evening sun from the front left (the `dusk` preset).
pub fn sun_dir() -> Vec3 {
    unit(Vec3::new(-0.75, 0.33, 0.45))
}

pub struct Occlusion {
    lo: Vec3,
    cell: f32,
    dims: [usize; 3],
    near: Vec<f32>,
    far: Vec<f32>,
}

const MAX_CELLS: f32 = 4.0e6;

impl Occlusion {
    /// `occluders`: (world position, area in m^2).
    pub fn new(occluders: &[(Vec3, f32)]) -> Occlusion {
        Self::with_max_cells(occluders, MAX_CELLS)
    }

    /// Like `new`, with a cap on the grid size (big scenes get coarser cells).
    pub fn with_max_cells(occluders: &[(Vec3, f32)], max_cells: f32) -> Occlusion {
        let mut lo = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut hi = -lo;
        for &(p, _) in occluders {
            lo = lo.min(p);
            hi = hi.max(p);
        }
        if occluders.is_empty() {
            lo = Vec3::ZERO;
            hi = Vec3::ZERO;
        }
        lo = lo - Vec3::new(1.0, 1.0, 1.0);
        hi += Vec3::new(1.0, 1.0, 1.0);
        let ext = hi - lo;
        let mut cell = 0.25f32;
        while (ext.x / cell) * (ext.y / cell) * (ext.z / cell) > max_cells {
            cell *= 1.12;
        }
        let dims = [ext.x, ext.y, ext.z].map(|e| (e / cell).ceil() as usize + 1);
        let mut occ = Occlusion { lo, cell, dims, near: vec![0.0; dims[0] * dims[1] * dims[2]], far: Vec::new() };
        for &(p, area) in occluders {
            if let Some(i) = occ.index(p) {
                occ.near[i] += area;
            }
        }
        blur3(&mut occ.near, dims, 0.7);
        let inv_vol = 1.0 / (cell * cell * cell);
        occ.near.iter_mut().for_each(|v| *v *= inv_vol); // area per volume (1/m)
        occ.far = occ.near.clone();
        blur3(&mut occ.far, dims, 2.0);
        occ
    }

    fn index(&self, p: Vec3) -> Option<usize> {
        let q = (p - self.lo) * (1.0 / self.cell);
        if q.x < 0.0 || q.y < 0.0 || q.z < 0.0 {
            return None;
        }
        let (x, y, z) = (q.x as usize, q.y as usize, q.z as usize);
        let [nx, ny, nz] = self.dims;
        (x < nx && y < ny && z < nz).then(|| (x * ny + y) * nz + z)
    }

    #[allow(clippy::too_many_arguments)]
    fn march(&self, grid: &[f32], p: Vec3, d: Vec3, start: f32, dist: f32, steps: usize, k: f32) -> f32 {
        let step = (dist - start) / steps as f32;
        let mut acc = 0.0;
        for i in 1..=steps {
            if let Some(idx) = self.index(p + d * (start + i as f32 * step)) {
                acc += grid[idx];
            }
        }
        fm::exp(-k * acc * step)
    }

    pub fn sun(&self, p: Vec3, sun: Vec3) -> f32 {
        let near = self.march(&self.near, p, sun, 0.0, 5.0, 20, 0.3);
        let far = self.march(&self.far, p, sun, 5.0, 36.0, 16, 0.15);
        near * far
    }

    pub fn sky(&self, p: Vec3) -> f32 {
        let dirs = [
            Vec3::Y,
            unit(Vec3::new(0.6, 0.8, 0.0)),
            unit(Vec3::new(-0.6, 0.8, 0.0)),
            unit(Vec3::new(0.0, 0.8, 0.6)),
            unit(Vec3::new(0.0, 0.8, -0.6)),
        ];
        dirs.iter().map(|&d| self.march(&self.near, p, d, 0.0, 4.0, 10, 0.25)).sum::<f32>() / 5.0
    }
}

/// Separable Gaussian blur of a 3D grid (zero outside).
///
/// Each output cell sums its taps in the same order as the straightforward
/// triple loop (`blur3_reference`), so the result is bit-for-bit the same;
/// the loops just run along whole rows so they stay in cache and vectorise.
pub fn blur3(g: &mut [f32], dims: [usize; 3], sigma: f32) {
    let rad = (3.0 * sigma).ceil() as isize;
    let mut k: Vec<f32> = (-rad..=rad).map(|i| fm::exp(-(i * i) as f32 / (2.0 * sigma * sigma))).collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    let [nx, ny, nz] = dims;
    let mut src = vec![0.0f32; g.len()];
    for axis in 0..3 {
        src.copy_from_slice(g);
        let n = dims[axis];
        // The grid as [outer][n][inner] along this axis.
        let (outer, inner) = match axis {
            0 => (1, ny * nz),
            1 => (nx, nz),
            _ => (nx * ny, 1),
        };
        if inner == 1 {
            // Along contiguous rows: one pass per tap over the whole row, taps
            // still added to each cell in increasing order.
            for o in 0..outer {
                let row = &src[o * n..(o + 1) * n];
                let dst = &mut g[o * n..(o + 1) * n];
                dst.iter_mut().for_each(|v| *v = 0.0);
                for (t, &w) in k.iter().enumerate() {
                    let off = t as isize - rad;
                    let p0 = (-off).max(0) as usize;
                    let p1 = (n as isize - off).min(n as isize).max(0) as usize;
                    if p0 >= p1 {
                        continue;
                    }
                    let s0 = (p0 as isize + off) as usize;
                    for (d, s) in dst[p0..p1].iter_mut().zip(&row[s0..s0 + (p1 - p0)]) {
                        *d += w * s;
                    }
                }
            }
            continue;
        }
        for o in 0..outer {
            let base = o * n * inner;
            for pos in 0..n {
                let lo = (pos as isize - rad).max(0) as usize;
                let hi = (pos as isize + rad).min(n as isize - 1) as usize;
                let dst = &mut g[base + pos * inner..base + (pos + 1) * inner];
                dst.iter_mut().for_each(|v| *v = 0.0);
                for q in lo..=hi {
                    let w = k[(q as isize - pos as isize + rad) as usize];
                    let row = &src[base + q * inner..base + (q + 1) * inner];
                    for (d, s) in dst.iter_mut().zip(row) {
                        *d += w * s;
                    }
                }
            }
        }
    }
}

/// The original triple loop, kept to check `blur3` against.
#[cfg(test)]
fn blur3_reference(g: &mut [f32], dims: [usize; 3], sigma: f32) {
    let rad = (3.0 * sigma).ceil() as isize;
    let mut k: Vec<f32> = (-rad..=rad).map(|i| fm::exp(-(i * i) as f32 / (2.0 * sigma * sigma))).collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    let [nx, ny, nz] = dims;
    let strides = [ny * nz, nz, 1];
    let mut src = vec![0.0f32; g.len()];
    for axis in 0..3 {
        src.copy_from_slice(g);
        let n = dims[axis] as isize;
        let st = strides[axis] as isize;
        for x in 0..nx {
            for y in 0..ny {
                for z in 0..nz {
                    let pos = [x, y, z][axis] as isize;
                    let i = ((x * ny + y) * nz + z) as isize;
                    let mut acc = 0.0;
                    for (o, w) in (-rad..=rad).zip(&k) {
                        let q = pos + o;
                        if q >= 0 && q < n {
                            acc += w * src[(i + o * st) as usize];
                        }
                    }
                    g[i as usize] = acc;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blur3_matches_the_reference_bit_for_bit() {
        for (dims, sigma) in [([7usize, 5, 9], 0.7f32), ([13, 4, 6], 2.0), ([3, 11, 2], 2.0), ([1, 1, 1], 0.7), ([20, 17, 15], 0.7)] {
            let n = dims[0] * dims[1] * dims[2];
            let mut a: Vec<f32> = (0..n).map(|i| fm::sin(i as f32 * 1.37).abs() * if i % 3 == 0 { 0.0 } else { 2.5 }).collect();
            let mut b = a.clone();
            blur3(&mut a, dims, sigma);
            blur3_reference(&mut b, dims, sigma);
            assert!(a.iter().zip(&b).all(|(x, y)| x.to_bits() == y.to_bits()), "dims {dims:?} sigma {sigma}");
        }
    }

    #[test]
    fn a_leaf_ball_shades_its_inside_and_the_ground_below() {
        // A dense ball of foliage 3 m up.
        let mut occ = Vec::new();
        for i in 0..4000 {
            let t = i as f32 * 0.618;
            let p = Vec3::new(fm::sin(t) * (i % 7) as f32 * 0.12, 3.0 + fm::cos(t) * (i % 5) as f32 * 0.15, fm::sin(t * 1.7) * (i % 6) as f32 * 0.12);
            occ.push((p, 0.02));
        }
        let o = Occlusion::new(&occ);
        let sun = sun_dir();
        let open = o.sun(Vec3::new(10.0, 3.0, 10.0), sun);
        let inside = o.sun(Vec3::new(0.0, 3.0, 0.0), sun);
        assert!(open > 0.99, "{open}");
        assert!(inside < 0.5, "{inside}");
        // Ground in the ball's shadow (behind it, away from the sun).
        let shadowed = Vec3::new(0.0, 3.0, 0.0) - sun * (3.0 / sun.y);
        assert!(o.sun(shadowed, sun) < o.sun(Vec3::new(6.0, 0.0, -6.0), sun));
        assert!(o.sky(Vec3::new(0.0, 2.0, 0.0)) < o.sky(Vec3::new(8.0, 2.0, 8.0)));
    }
}
