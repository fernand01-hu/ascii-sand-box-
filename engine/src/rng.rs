//! PCG32 random number generator (O'Neill, pcg-random.org).
//!
//! Implemented here instead of pulling a crate so the sequence for a given
//! seed can never change under us: same seed, same scene, forever.
use crate::fm;

#[derive(Clone, Debug)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64, stream: u64) -> Self {
        let mut r = Pcg32 { state: 0, inc: (stream << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }

    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }

    /// Uniform in [0, 1).
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }

    /// Uniform in [lo, hi).
    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next_f32()
    }

    /// Uniform integer in [0, n). `n` must be > 0.
    pub fn below(&mut self, n: u32) -> u32 {
        ((self.next_u32() as u64 * n as u64) >> 32) as u32
    }

    /// Standard normal (Box-Muller).
    pub fn normal(&mut self) -> f32 {
        let u1 = 1.0 - self.next_f32(); // (0, 1], so ln is finite
        let u2 = self.next_f32();
        (-2.0 * fm::ln(u1)).sqrt() * fm::cos(std::f32::consts::TAU * u2)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic() {
        let mut a = Pcg32::new(42, 7);
        let mut b = Pcg32::new(42, 7);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn seeds_differ() {
        let mut a = Pcg32::new(1, 7);
        let mut b = Pcg32::new(2, 7);
        let same = (0..100).filter(|_| a.next_u32() == b.next_u32()).count();
        assert!(same < 3);
    }

    #[test]
    fn ranges_hold() {
        let mut r = Pcg32::new(3, 1);
        for _ in 0..100_000 {
            let f = r.next_f32();
            assert!((0.0..1.0).contains(&f));
            assert!(r.below(5) < 5);
            assert!(r.normal().is_finite());
        }
    }

    #[test]
    fn normal_has_unit_variance() {
        let mut r = Pcg32::new(9, 2);
        let n = 200_000;
        let (mut s, mut s2) = (0.0f64, 0.0f64);
        for _ in 0..n {
            let v = r.normal() as f64;
            s += v;
            s2 += v * v;
        }
        let mean = s / n as f64;
        let var = s2 / n as f64 - mean * mean;
        assert!(mean.abs() < 0.01, "mean {mean}");
        assert!((var - 1.0).abs() < 0.02, "var {var}");
    }
}
