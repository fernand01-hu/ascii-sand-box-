//! Math functions whose results must not depend on the platform.
//!
//! The libm that `f32::sin` and friends call differs between operating
//! systems and from the one compiled into WebAssembly, and the procedural
//! generators (erosion in particular) amplify last-bit differences into
//! different landscapes. With the `libm` feature these go through the pure
//! Rust `libm` crate instead, so a seed gives the same scene on every target.
//! Without it (the WebAssembly build) they are the standard library calls.

pub trait Det: Copy {
    fn dsin(self) -> Self;
    fn dcos(self) -> Self;
    fn dtan(self) -> Self;
    fn dasin(self) -> Self;
    fn dacos(self) -> Self;
    fn datan(self) -> Self;
    fn datan2(self, x: Self) -> Self;
    fn dexp(self) -> Self;
    fn dln(self) -> Self;
    fn dpowf(self, e: Self) -> Self;
    fn dhypot(self, y: Self) -> Self;
    fn dtanh(self) -> Self;
    fn dsin_cos(self) -> (Self, Self);
}

macro_rules! det_impl {
    ($t:ty, $sin:ident, $cos:ident, $tan:ident, $asin:ident, $acos:ident, $atan:ident, $atan2:ident, $exp:ident, $log:ident, $pow:ident, $hypot:ident, $tanh:ident) => {
        #[cfg(feature = "libm")]
        impl Det for $t {
            fn dsin(self) -> Self { libm::$sin(self) }
            fn dcos(self) -> Self { libm::$cos(self) }
            fn dtan(self) -> Self { libm::$tan(self) }
            fn dasin(self) -> Self { libm::$asin(self) }
            fn dacos(self) -> Self { libm::$acos(self) }
            fn datan(self) -> Self { libm::$atan(self) }
            fn datan2(self, x: Self) -> Self { libm::$atan2(self, x) }
            fn dexp(self) -> Self { libm::$exp(self) }
            fn dln(self) -> Self { libm::$log(self) }
            fn dpowf(self, e: Self) -> Self { libm::$pow(self, e) }
            fn dhypot(self, y: Self) -> Self { libm::$hypot(self, y) }
            fn dtanh(self) -> Self { libm::$tanh(self) }
            fn dsin_cos(self) -> (Self, Self) { (libm::$sin(self), libm::$cos(self)) }
        }
        #[cfg(not(feature = "libm"))]
        impl Det for $t {
            fn dsin(self) -> Self { self.sin() }
            fn dcos(self) -> Self { self.cos() }
            fn dtan(self) -> Self { self.tan() }
            fn dasin(self) -> Self { self.asin() }
            fn dacos(self) -> Self { self.acos() }
            fn datan(self) -> Self { self.atan() }
            fn datan2(self, x: Self) -> Self { self.atan2(x) }
            fn dexp(self) -> Self { self.exp() }
            fn dln(self) -> Self { self.ln() }
            fn dpowf(self, e: Self) -> Self { self.powf(e) }
            fn dhypot(self, y: Self) -> Self { self.hypot(y) }
            fn dtanh(self) -> Self { self.tanh() }
            fn dsin_cos(self) -> (Self, Self) { self.sin_cos() }
        }
    };
}
det_impl!(f32, sinf, cosf, tanf, asinf, acosf, atanf, atan2f, expf, logf, powf, hypotf, tanhf);
det_impl!(f64, sin, cos, tan, asin, acos, atan, atan2, exp, log, pow, hypot, tanh);

#[inline(always)]
pub fn sin<T: Det>(x: T) -> T { x.dsin() }
#[inline(always)]
pub fn cos<T: Det>(x: T) -> T { x.dcos() }
#[inline(always)]
pub fn tan<T: Det>(x: T) -> T { x.dtan() }
#[inline(always)]
pub fn asin<T: Det>(x: T) -> T { x.dasin() }
#[inline(always)]
pub fn acos<T: Det>(x: T) -> T { x.dacos() }
#[inline(always)]
pub fn atan<T: Det>(x: T) -> T { x.datan() }
#[inline(always)]
pub fn atan2<T: Det>(y: T, x: T) -> T { y.datan2(x) }
#[inline(always)]
pub fn exp<T: Det>(x: T) -> T { x.dexp() }
#[inline(always)]
pub fn ln<T: Det>(x: T) -> T { x.dln() }
#[inline(always)]
pub fn powf<T: Det>(x: T, e: T) -> T { x.dpowf(e) }
#[inline(always)]
pub fn hypot<T: Det>(x: T, y: T) -> T { x.dhypot(y) }
#[inline(always)]
pub fn tanh<T: Det>(x: T) -> T { x.dtanh() }
#[inline(always)]
pub fn sin_cos<T: Det>(x: T) -> (T, T) { x.dsin_cos() }
