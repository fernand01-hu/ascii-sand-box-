//! Ken Perlin's improved noise (2002) with a seeded permutation table, and the
//! fBm sum used everywhere in the generators. Port of `scenery/core.py`.

use crate::math::Vec3;
use crate::rng::Pcg32;

pub struct Perlin {
    p: [u8; 512],
}

fn fade(t: f32) -> f32 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn grad(h: u8, x: f32, y: f32, z: f32) -> f32 {
    let h = h & 15;
    let u = if h < 8 { x } else { y };
    let v = if h < 4 {
        y
    } else if h == 12 || h == 14 {
        x
    } else {
        z
    };
    (if h & 1 != 0 { -u } else { u }) + (if h & 2 != 0 { -v } else { v })
}

impl Perlin {
    pub fn new(seed: u64) -> Perlin {
        let mut rng = Pcg32::new(seed, 0x9e71_5eed);
        let mut perm: Vec<u8> = (0..=255).collect();
        for i in (1..256).rev() {
            let j = rng.below(i as u32 + 1) as usize;
            perm.swap(i, j);
        }
        let mut p = [0u8; 512];
        for i in 0..512 {
            p[i] = perm[i & 255];
        }
        Perlin { p }
    }

    /// About [-1, 1].
    pub fn noise3(&self, x: f32, y: f32, z: f32) -> f32 {
        let (fx, fy, fz) = (x.floor(), y.floor(), z.floor());
        let (xi, yi, zi) = ((fx as i64 & 255) as usize, (fy as i64 & 255) as usize, (fz as i64 & 255) as usize);
        let (x, y, z) = (x - fx, y - fy, z - fz);
        let (u, v, w) = (fade(x), fade(y), fade(z));
        let p = &self.p;
        let a = p[xi] as usize + yi;
        let (aa, ab) = (p[a] as usize + zi, p[a + 1] as usize + zi);
        let b = p[xi + 1] as usize + yi;
        let (ba, bb) = (p[b] as usize + zi, p[b + 1] as usize + zi);
        lerp(
            lerp(
                lerp(grad(p[aa], x, y, z), grad(p[ba], x - 1.0, y, z), u),
                lerp(grad(p[ab], x, y - 1.0, z), grad(p[bb], x - 1.0, y - 1.0, z), u),
                v,
            ),
            lerp(
                lerp(grad(p[aa + 1], x, y, z - 1.0), grad(p[ba + 1], x - 1.0, y, z - 1.0), u),
                lerp(grad(p[ab + 1], x, y - 1.0, z - 1.0), grad(p[bb + 1], x - 1.0, y - 1.0, z - 1.0), u),
                v,
            ),
            w,
        )
    }

    pub fn noise(&self, p: Vec3) -> f32 {
        self.noise3(p.x, p.y, p.z)
    }

    /// Fractal sum, normalized to about [-1, 1].
    pub fn fbm(&self, x: f32, y: f32, z: f32, octaves: u32) -> f32 {
        let (mut tot, mut amp, mut f, mut norm) = (0.0, 1.0, 1.0, 0.0);
        for i in 0..octaves {
            let fi = i as f32;
            tot += amp * self.noise3(x * f + 17.1 * fi, y * f + 3.7 * fi, z * f + 9.2 * fi);
            norm += amp;
            amp *= 0.5;
            f *= 2.0;
        }
        tot / norm
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_continuity_and_seeding() {
        let n = Perlin::new(1);
        let mut prev = n.noise3(0.0, 0.31, 0.77);
        let mut max_abs = 0.0f32;
        for i in 1..20_000 {
            let v = n.noise3(i as f32 * 0.002, 0.31, 0.77);
            assert!(v.abs() <= 1.1, "{v}");
            assert!((v - prev).abs() < 0.02, "noise must be continuous");
            max_abs = max_abs.max(v.abs());
            prev = v;
        }
        assert!(max_abs > 0.4, "noise should use its range");
        assert_ne!(Perlin::new(1).noise3(0.5, 0.5, 0.5), Perlin::new(2).noise3(0.5, 0.5, 0.5));
        assert_eq!(n.noise3(3.0, 4.0, 5.0), 0.0, "zero at lattice points");
    }
}
