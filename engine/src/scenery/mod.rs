//! Procedural scenery assets: rocks, leaf plants, bushes and trees, built from
//! the `scenery` reference package (Python) and rendered as ASCII cards.
//!
//! Pipeline: generator (seed, kind) -> `Asset` (wood, sprites, surfels,
//! solids) -> `Skinner` (cards, view-independent) -> `Occlusion` (baked
//! sun/sky visibility). `gallery` lays out a sheet of assets on studio ground.

pub mod asset;
pub mod bushes;
pub mod colonize;
pub mod gallery;
pub mod landscape;
pub mod light;
pub mod perlin;
pub mod plants;
pub mod rocks;
pub mod scatter;
pub mod scene;
pub mod skin;
pub mod style;
pub mod terrain;
pub mod trees;
