//! Procedural scenery assets: rocks, leaf plants, bushes and trees, built from
//! the `scenery` reference package (Python) and rendered as ASCII cards.
//!
//! Pipeline: generator (seed, kind) -> `Asset` (wood, sprites, surfels,
//! solids) -> `Skinner` (cards, view-independent) -> `Occlusion` (baked
//! sun/sky visibility). `gallery` lays out a sheet of assets on studio ground.
//! `canvas` is the map: an endless flat plane of '#' rows, built in chunks,
//! under the sky and weather from `sky`. `library` caches asset variants.

pub mod asset;
pub mod bushes;
pub mod canvas;
pub mod colonize;
pub mod gallery;
pub mod library;
pub mod light;
pub mod perlin;
pub mod plants;
pub mod rocks;
pub mod skin;
pub mod sky;
pub mod style;
pub mod trees;
