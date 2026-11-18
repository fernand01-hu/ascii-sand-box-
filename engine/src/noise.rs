//! Seeded 3D noise for choosing glyphs from the surface itself.
//! Hash-based (no tables), so any seed works and results never change.

use crate::math::Vec3;

fn hash(x: i64, y: i64, z: i64, seed: u64) -> u64 {
    let mut h = (x as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (y as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
        ^ (z as u64).wrapping_mul(0x1656_67B1_9E37_79F9)
        ^ seed.wrapping_mul(0x27D4_EB2F_1656_67C5);
    h ^= h >> 33;
    h = h.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
    h ^= h >> 33;
    h = h.wrapping_mul(0xC4CE_B9FE_1A85_EC53);
    h ^ (h >> 33)
}

fn unit_f32(bits: u64) -> f32 {
    (bits & 0xFF_FFFF) as f32 / 16_777_215.0
}

/// Cellular (Worley) noise: distances to the nearest and second-nearest
/// feature point, in cell units. `f2 - f1` is ~0 on the cracks between cells
/// and grows toward cell centres — the "plates and fissures" of the pine bark.
pub fn worley(p: Vec3, seed: u64) -> (f32, f32) {
    let (ix, iy, iz) = (p.x.floor() as i64, p.y.floor() as i64, p.z.floor() as i64);
    let (mut f1, mut f2) = (f32::INFINITY, f32::INFINITY);
    for dx in -1..=1 {
        for dy in -1..=1 {
            for dz in -1..=1 {
                let (cx, cy, cz) = (ix + dx, iy + dy, iz + dz);
                let h = hash(cx, cy, cz, seed);
                let feature = Vec3::new(
                    cx as f32 + unit_f32(h),
                    cy as f32 + unit_f32(h >> 21),
                    cz as f32 + unit_f32(h >> 42),
                );
                let d = (p - feature).length();
                if d < f1 {
                    f2 = f1;
                    f1 = d;
                } else if d < f2 {
                    f2 = d;
                }
            }
        }
    }
    (f1, f2)
}

/// Smooth value noise in [0, 1].
pub fn value(p: Vec3, seed: u64) -> f32 {
    let (ix, iy, iz) = (p.x.floor() as i64, p.y.floor() as i64, p.z.floor() as i64);
    let f = |t: f32| t * t * (3.0 - 2.0 * t);
    let (fx, fy, fz) = (f(p.x - p.x.floor()), f(p.y - p.y.floor()), f(p.z - p.z.floor()));
    let v = |dx: i64, dy: i64, dz: i64| unit_f32(hash(ix + dx, iy + dy, iz + dz, seed));
    let lerp = |a: f32, b: f32, t: f32| a + (b - a) * t;
    let x00 = lerp(v(0, 0, 0), v(1, 0, 0), fx);
    let x10 = lerp(v(0, 1, 0), v(1, 1, 0), fx);
    let x01 = lerp(v(0, 0, 1), v(1, 0, 1), fx);
    let x11 = lerp(v(0, 1, 1), v(1, 1, 1), fx);
    lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz)
}

/// Two octaves of value noise, roughly [0, 1].
pub fn fbm(p: Vec3, seed: u64) -> f32 {
    (value(p, seed) * 2.0 + value(p * 2.03, seed ^ 0x55)) / 3.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn worley_is_ordered_and_bounded() {
        for i in 0..2000 {
            let p = Vec3::new(i as f32 * 0.137, i as f32 * -0.071, i as f32 * 0.029);
            let (f1, f2) = worley(p, 3);
            assert!(f1 <= f2 && f1 >= 0.0 && f2 < 2.0, "{f1} {f2}");
        }
    }

    #[test]
    fn value_noise_in_range_continuous_and_seeded() {
        let mut prev = value(Vec3::new(0.0, 0.3, 0.7), 1);
        for i in 1..5000 {
            let p = Vec3::new(i as f32 * 0.001, 0.3, 0.7);
            let v = value(p, 1);
            assert!((0.0..=1.0).contains(&v));
            assert!((v - prev).abs() < 0.02, "noise must be continuous");
            prev = v;
        }
        let a: Vec<f32> = (0..50).map(|i| value(Vec3::new(i as f32 * 0.7, 0.0, 0.0), 1)).collect();
        let b: Vec<f32> = (0..50).map(|i| value(Vec3::new(i as f32 * 0.7, 0.0, 0.0), 2)).collect();
        assert_ne!(a, b);
    }
}
