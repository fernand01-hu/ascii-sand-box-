//! ASCII scene engine.
//!
//! Pipeline: STL bytes -> `stl::parse` -> `Mesh::from_triangles` (clean,
//! normalize, smooth normals) -> `cards::generate` (one glyph card per sample).
//!
//! This file is the platform-neutral Rust API (`Engine`, `CardConfig`,
//! `build_scene`, `build_gallery`, `InfiniteWorld`): plain types, `String`
//! errors, no wasm-bindgen. The WebAssembly bindings the browser calls live in
//! `wasm.rs`, behind the `wasm` feature, and wrap these same types.
//!
//! Test scenes live in `testbed` and only exist with the `testbed` feature.

pub mod cards;
pub mod fm;
pub mod math;
pub mod mesh;
pub mod noise;
pub mod rng;
pub mod scenery;
pub mod stl;

#[cfg(feature = "testbed")]
pub mod testbed;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use cards::{CardParams, GlyphRule, STRIDE};
pub use mesh::Mesh;

/// Parse and normalize an STL in one step.
pub fn load_mesh(bytes: &[u8], z_up: bool) -> Result<Mesh, String> {
    let tris = stl::parse(bytes).map_err(|e| e.to_string())?;
    Mesh::from_triangles(tris, z_up).map_err(|e| e.to_string())
}

/// Floats per card in buffers returned by `Engine::generate`.
pub fn card_stride() -> u32 {
    STRIDE as u32
}

/// The charset exactly as the engine will index it (visible, unique, ordered).
pub fn normalize_charset(charset: &str) -> Result<String, String> {
    cards::normalize_charset(charset).map_err(|e| e.to_string())
}

/// Default charset, ordered light to dense.
pub fn default_charset() -> String {
    cards::DEFAULT_CHARSET.to_string()
}

/// Numeric settings for one card generation pass. The charset is passed
/// separately to `Engine::generate`.
#[derive(Clone, Debug)]
pub struct CardConfig {
    pub seed: u32,
    pub glyph_size: f32,
    pub size_factor: f32,
    /// 0 random, 1 cells, 2 noise (see `GlyphRule`).
    pub glyph_rule: u32,
    pub pattern_scale: f32,
    pub glyph_aspect: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub color_jitter: f32,
    pub twist: f32,
    pub tilt: f32,
    pub alpha_min: f32,
    pub alpha_max: f32,
}

impl CardConfig {
    pub fn new() -> CardConfig {
        let p = CardParams::default();
        CardConfig {
            seed: p.seed,
            glyph_size: p.glyph_size,
            size_factor: p.size_factor,
            glyph_rule: p.glyph_rule as u32,
            pattern_scale: p.pattern_scale,
            glyph_aspect: p.glyph_aspect,
            r: p.color[0],
            g: p.color[1],
            b: p.color[2],
            color_jitter: p.color_jitter,
            twist: p.twist,
            tilt: p.tilt,
            alpha_min: p.alpha_min,
            alpha_max: p.alpha_max,
        }
    }
}

impl Default for CardConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl CardConfig {
    pub fn to_params(&self, charset: &str) -> Result<CardParams, cards::ParamError> {
        Ok(CardParams {
            seed: self.seed,
            glyph_size: self.glyph_size,
            size_factor: self.size_factor,
            charset: charset.to_string(),
            glyph_rule: GlyphRule::from_u32(self.glyph_rule)?,
            pattern_scale: self.pattern_scale,
            glyph_aspect: self.glyph_aspect,
            color: [self.r, self.g, self.b],
            color_jitter: self.color_jitter,
            twist: self.twist,
            tilt: self.tilt,
            alpha_min: self.alpha_min,
            alpha_max: self.alpha_max,
        })
    }
}

/// Holds the current mesh so cards can be regenerated with new settings
/// without re-parsing the file.
#[derive(Default)]
pub struct Engine {
    mesh: Option<Mesh>,
}

impl Engine {
    pub fn new() -> Engine {
        Engine { mesh: None }
    }

    /// Parse an STL and make it the current mesh. On error the previous mesh is kept.
    pub fn load_stl(&mut self, bytes: &[u8], z_up: bool) -> Result<(), String> {
        self.mesh = Some(load_mesh(bytes, z_up)?);
        Ok(())
    }

    pub fn has_mesh(&self) -> bool {
        self.mesh.is_some()
    }

    pub fn triangle_count(&self) -> u32 {
        self.mesh.as_ref().map_or(0, |m| m.tris.len() as u32)
    }

    pub fn dropped_triangles(&self) -> u32 {
        self.mesh.as_ref().map_or(0, |m| m.dropped as u32)
    }

    /// Flat xyz positions of the normalized mesh (9 floats per triangle).
    pub fn mesh_positions(&self) -> Vec<f32> {
        self.mesh.as_ref().map_or_else(Vec::new, Mesh::flat_positions)
    }

    /// Flat xyz normals matching `mesh_positions`.
    pub fn mesh_normals(&self) -> Vec<f32> {
        self.mesh.as_ref().map_or_else(Vec::new, Mesh::flat_normals)
    }

    /// Card records, `card_stride()` floats each. Glyph indices refer to
    /// `normalize_charset(charset)`.
    pub fn generate(&self, config: &CardConfig, charset: &str) -> Result<Vec<f32>, String> {
        let mesh = self.mesh.as_ref().ok_or_else(|| "no mesh loaded".to_string())?;
        let params = config.to_params(charset).map_err(|e| e.to_string())?;
        cards::generate(mesh, &params).map_err(|e| e.to_string())
    }
}

// ---- scenery assets -------------------------------------------------------------

/// What the player physics needs from a landscape.
pub struct Walk {
    /// Terrain heights (row-major n x n).
    pub heights: Vec<f32>,
    pub n: u32,
    /// Metres per side.
    pub size: f32,
    /// Water level (NaN without a lake).
    pub water: f32,
    pub water_mask: Vec<u8>,
    /// x, z, radius, top y per entry.
    pub colliders: Vec<f32>,
}

/// A built scenery scene: cards, an opaque body and a suggested camera.
pub struct SceneryScene {
    /// Card records (`card_stride()` floats each).
    pub cards: Vec<f32>,
    /// Opaque body triangles (9 floats each) that hide what is behind them.
    pub body: Vec<f32>,
    pub body_normals: Vec<f32>,
    /// target xyz, eye xyz, vertical fov in degrees.
    pub camera: [f32; 7],
    /// Glyph height in metres.
    pub glyph: f32,
    /// daytime (0/1), wind direction x, z, leaf box min x, min z, size, rain box x, y, z.
    pub env: [f32; 9],
    pub walk: Option<Walk>,
}

pub fn body_buffers(body: &[[math::Vec3; 3]]) -> (Vec<f32>, Vec<f32>) {
    let mut pos = Vec::with_capacity(body.len() * 9);
    let mut nrm = Vec::with_capacity(body.len() * 9);
    for t in body {
        let n = (t[1] - t[0]).cross(t[2] - t[0]).try_normalize().unwrap_or(math::Vec3::Y);
        for v in t {
            pos.extend_from_slice(&[v.x, v.y, v.z]);
            nrm.extend_from_slice(&[n.x, n.y, n.z]);
        }
    }
    (pos, nrm)
}

/// A whole landscape: "meadow", "forest", "lake", "valley" or "alpine".
/// Build share `part` of `parts` of the infinite world's assets (trees,
/// bushes, plants, rocks at every level of detail) into the process-wide
/// cache, so chunk builds find them ready.
pub fn warm_world_assets(seed: u32, part: usize, parts: usize) -> usize {
    scenery::scatter::warm_world_assets(seed, part, parts)
}

pub fn build_scene(preset: &str, seed: u32, glyph_aspect: f32) -> Result<SceneryScene, String> {
    let p = scenery::scene::ScenePreset::parse(preset)
        .ok_or_else(|| format!("unknown scene {preset:?} (meadow, forest, lake, valley, alpine)"))?;
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err("glyph_aspect must be a positive number".to_string());
    }
    let s = scenery::scene::build_scene(p, seed, glyph_aspect);
    let (body, body_normals) = body_buffers(&s.body);
    let rb = scenery::landscape::RAIN_BOX;
    Ok(SceneryScene {
        cards: s.cards,
        body,
        body_normals,
        camera: [s.target.x, s.target.y, s.target.z, s.eye.x, s.eye.y, s.eye.z, s.fov],
        glyph: 0.0,
        env: [f32::from(s.day), s.wind[0], s.wind[1], s.leaf_box[0], s.leaf_box[1], s.leaf_box[2], rb[0], rb[1], rb[2]],
        walk: Some(Walk {
            heights: s.heights,
            n: s.grid_n as u32,
            size: s.grid_size,
            water: s.water.unwrap_or(f32::NAN),
            water_mask: s.water_mask,
            colliders: s.colliders.iter().flatten().copied().collect(),
        }),
    })
}

/// A gallery sheet of procedural assets: "rocks", "plants", "bushes" or "trees".
pub fn build_gallery(category: &str, seed: u32, glyph_aspect: f32) -> Result<SceneryScene, String> {
    let cat = scenery::gallery::Category::parse(category)
        .ok_or_else(|| format!("unknown gallery {category:?} (rocks, plants, bushes, trees)"))?;
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err("glyph_aspect must be a positive number".to_string());
    }
    let s = scenery::gallery::build_gallery(cat, seed, glyph_aspect);
    let (body, body_normals) = body_buffers(&s.body);
    let w = scenery::scene::wind_dir();
    let rb = scenery::landscape::RAIN_BOX;
    Ok(SceneryScene {
        cards: s.cards,
        body,
        body_normals,
        camera: [s.target.x, s.target.y, s.target.z, s.eye.x, s.eye.y, s.eye.z, s.fov],
        glyph: s.glyph,
        env: [0.0, w[0], w[1], 0.0, 0.0, 0.0, rb[0], rb[1], rb[2]],
        walk: None,
    })
}

/// Every character scenery uses, in atlas order.
pub fn scenery_charset() -> String {
    scenery::style::charset()
}

/// Shader material table: `material_floats()` floats per material, indexed by
/// material id (see `scenery::skin::material_table`).
pub fn scenery_materials() -> Vec<f32> {
    scenery::skin::material_table()
}

pub fn material_floats() -> u32 {
    scenery::skin::MATERIAL_FLOATS as u32
}

/// Sun direction a scene was baked with (`day` selects the preset).
pub fn scene_sun_dir(day: bool) -> [f32; 3] {
    let s = scenery::scene::sun_for(day);
    [s.x, s.y, s.z]
}

/// Sun direction scenery shadows are baked with.
pub fn scenery_sun_dir() -> [f32; 3] {
    let s = scenery::light::sun_dir();
    [s.x, s.y, s.z]
}

// ---- the infinite world ----------------------------------------------------------

/// Chunk size (m), physics grid (samples - 1 per side), water level.
pub fn world_consts() -> [f32; 3] {
    [scenery::world::CHUNK, scenery::world::GRID as f32, scenery::world::WATER]
}

/// An endless landscape, built chunk by chunk around the viewer. Each thread
/// that builds chunks owns one (they are deterministic and independent).
pub struct InfiniteWorld {
    pub inner: scenery::world::World,
}

impl InfiniteWorld {
    pub fn new(seed: u32, day: bool) -> InfiniteWorld {
        InfiniteWorld { inner: scenery::world::World::new(seed, day) }
    }

    pub fn day(&self) -> bool {
        self.inner.day
    }

    /// Ground height at (x, z), m.
    pub fn height(&self, x: f32, z: f32) -> f32 {
        self.inner.gen.height(x, z)
    }

    /// Sky dome, rain and blown leaves (all follow the camera).
    pub fn sky_cards(&self, glyph_aspect: f32) -> Vec<f32> {
        self.inner.sky_cards(glyph_aspect)
    }

    /// Chunk (cx, cz) with glyphs sized for an eye at `eye`.
    pub fn build_chunk(&mut self, cx: i32, cz: i32, eye: [f32; 3], glyph_aspect: f32) -> WorldChunk {
        let c = self.inner.build_chunk(cx, cz, math::Vec3::new(eye[0], eye[1], eye[2]), glyph_aspect);
        let (body, body_normals) = body_buffers(&c.body);
        WorldChunk { cards: c.cards, body, body_normals, heights: c.heights, colliders: c.colliders.iter().flatten().copied().collect() }
    }
}

pub struct WorldChunk {
    pub cards: Vec<f32>,
    pub body: Vec<f32>,
    pub body_normals: Vec<f32>,
    /// (GRID + 1)^2 heights, 1 m apart, from the chunk's corner.
    pub heights: Vec<f32>,
    /// x, z, radius, top y per collider.
    pub colliders: Vec<f32>,
}

// ---- testbed scenes (dev/test builds only) ------------------------------------

/// Every character the procedural pine uses, in atlas order.
#[cfg(feature = "testbed")]
pub fn pine_charset() -> String {
    testbed::pine::charset()
}

/// The procedural pine from `pine_ascii.py` as card records (`card_stride()` floats each).
#[cfg(feature = "testbed")]
pub fn generate_pine(seed: u32, glyph_aspect: f32) -> Result<Vec<f32>, String> {
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err("glyph_aspect must be a positive number".to_string());
    }
    Ok(testbed::pine::generate(seed, glyph_aspect))
}

/// Sun direction the pine's shadows were baked with; the renderer must match it.
#[cfg(feature = "testbed")]
pub fn pine_sun_dir() -> [f32; 3] {
    let s = testbed::pine::sun_dir();
    [s.x, s.y, s.z]
}
