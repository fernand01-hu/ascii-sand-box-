//! Test scenes. Not part of the product: compiled only with the `testbed`
//! feature (dev and test builds), never into the production WASM.
//!
//! * `pine`: the procedural pine from `pine_ascii.py`, used as a demanding
//!   stress test (80k+ cards, baked shadows, several materials, billboards).

pub mod pine;
