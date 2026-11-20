//! ASCII scene engine.
//!
//! Pipeline: STL bytes -> `stl::parse` -> `Mesh::from_triangles` (clean,
//! normalize, smooth normals) -> `cards::generate` (one glyph card per sample).
//!
//! The pure-Rust API (`load_mesh`, `cards::generate`) is what the tests use;
//! the `Engine` type below is the thin WebAssembly wrapper the browser calls.
//!
//! Test scenes live in `testbed` and only exist with the `testbed` feature.

pub mod cards;
pub mod math;
pub mod mesh;
pub mod noise;
pub mod rng;
pub mod scenery;
pub mod stl;

#[cfg(feature = "testbed")]
pub mod testbed;

use wasm_bindgen::prelude::*;

pub use cards::{CardParams, GlyphRule, STRIDE};
pub use mesh::Mesh;

/// Parse and normalize an STL in one step.
pub fn load_mesh(bytes: &[u8], z_up: bool) -> Result<Mesh, String> {
    let tris = stl::parse(bytes).map_err(|e| e.to_string())?;
    Mesh::from_triangles(tris, z_up).map_err(|e| e.to_string())
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Floats per card in buffers returned by `Engine::generate`.
#[wasm_bindgen(js_name = cardStride)]
pub fn card_stride() -> u32 {
    STRIDE as u32
}

/// The charset exactly as the engine will index it (visible, unique, ordered).
/// The renderer must build its glyph atlas from this string.
#[wasm_bindgen(js_name = normalizeCharset)]
pub fn normalize_charset(charset: &str) -> Result<String, JsError> {
    cards::normalize_charset(charset).map_err(|e| JsError::new(&e.to_string()))
}

/// Default charset, ordered light to dense.
#[wasm_bindgen(js_name = defaultCharset)]
pub fn default_charset() -> String {
    cards::DEFAULT_CHARSET.to_string()
}

/// Numeric settings for one card generation pass. The charset is passed
/// separately to `Engine::generate`.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct CardConfig {
    pub seed: u32,
    #[wasm_bindgen(js_name = glyphSize)]
    pub glyph_size: f32,
    #[wasm_bindgen(js_name = sizeFactor)]
    pub size_factor: f32,
    /// 0 random, 1 cells, 2 noise (see `GlyphRule`).
    #[wasm_bindgen(js_name = glyphRule)]
    pub glyph_rule: u32,
    #[wasm_bindgen(js_name = patternScale)]
    pub pattern_scale: f32,
    #[wasm_bindgen(js_name = glyphAspect)]
    pub glyph_aspect: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    #[wasm_bindgen(js_name = colorJitter)]
    pub color_jitter: f32,
    pub twist: f32,
    pub tilt: f32,
    #[wasm_bindgen(js_name = alphaMin)]
    pub alpha_min: f32,
    #[wasm_bindgen(js_name = alphaMax)]
    pub alpha_max: f32,
}

#[wasm_bindgen]
impl CardConfig {
    #[wasm_bindgen(constructor)]
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
#[wasm_bindgen]
#[derive(Default)]
pub struct Engine {
    mesh: Option<Mesh>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { mesh: None }
    }

    /// Parse an STL and make it the current mesh. On error the previous mesh is kept.
    #[wasm_bindgen(js_name = loadStl)]
    pub fn load_stl(&mut self, bytes: &[u8], z_up: bool) -> Result<(), JsError> {
        self.mesh = Some(load_mesh(bytes, z_up).map_err(|e| JsError::new(&e))?);
        Ok(())
    }

    #[wasm_bindgen(js_name = hasMesh)]
    pub fn has_mesh(&self) -> bool {
        self.mesh.is_some()
    }

    #[wasm_bindgen(js_name = triangleCount)]
    pub fn triangle_count(&self) -> u32 {
        self.mesh.as_ref().map_or(0, |m| m.tris.len() as u32)
    }

    #[wasm_bindgen(js_name = droppedTriangles)]
    pub fn dropped_triangles(&self) -> u32 {
        self.mesh.as_ref().map_or(0, |m| m.dropped as u32)
    }

    /// Flat xyz positions of the normalized mesh (9 floats per triangle).
    #[wasm_bindgen(js_name = meshPositions)]
    pub fn mesh_positions(&self) -> Vec<f32> {
        self.mesh.as_ref().map_or_else(Vec::new, Mesh::flat_positions)
    }

    /// Flat xyz normals matching `meshPositions`.
    #[wasm_bindgen(js_name = meshNormals)]
    pub fn mesh_normals(&self) -> Vec<f32> {
        self.mesh.as_ref().map_or_else(Vec::new, Mesh::flat_normals)
    }

    /// Card records, `cardStride()` floats each. Glyph indices refer to
    /// `normalizeCharset(charset)`.
    pub fn generate(&self, config: &CardConfig, charset: &str) -> Result<Vec<f32>, JsError> {
        let mesh = self.mesh.as_ref().ok_or_else(|| JsError::new("no mesh loaded"))?;
        let params = config.to_params(charset).map_err(|e| JsError::new(&e.to_string()))?;
        cards::generate(mesh, &params).map_err(|e| JsError::new(&e.to_string()))
    }
}

// ---- scenery assets -------------------------------------------------------------

/// A built scenery scene: cards, an opaque body and a suggested camera.
#[wasm_bindgen]
pub struct SceneryScene {
    cards: Vec<f32>,
    body: Vec<f32>,
    body_normals: Vec<f32>,
    camera: Vec<f32>,
    glyph: f32,
    env: Vec<f32>,
}

#[wasm_bindgen]
impl SceneryScene {
    /// Card records (`cardStride()` floats each). Moves the buffer out.
    #[wasm_bindgen(js_name = takeCards)]
    pub fn take_cards(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.cards)
    }

    /// Opaque body triangles (9 floats each) that hide what is behind them.
    #[wasm_bindgen(js_name = takeBody)]
    pub fn take_body(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.body)
    }

    #[wasm_bindgen(js_name = takeBodyNormals)]
    pub fn take_body_normals(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.body_normals)
    }

    /// target xyz, eye xyz, vertical fov in degrees.
    pub fn camera(&self) -> Vec<f32> {
        self.camera.clone()
    }

    /// Glyph height in metres.
    pub fn glyph(&self) -> f32 {
        self.glyph
    }

    /// daytime (0/1), wind direction x, z, leaf box min x, min z, size,
    /// rain box x, y, z.
    pub fn env(&self) -> Vec<f32> {
        self.env.clone()
    }
}

fn body_buffers(body: &[[math::Vec3; 3]]) -> (Vec<f32>, Vec<f32>) {
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

/// Every object kind's generator parameters as JSON, one list per kind in
/// kind-code order (see `objectKinds`): name, label, min, max, step, default.
#[wasm_bindgen(js_name = objectParams)]
pub fn object_params() -> String {
    scenery::params::params_json()
}

/// One object (kind code, seed, parameter values) on a small studio floor,
/// for the object brush's live preview; glyphs sized for a `frame_px` tall view.
#[wasm_bindgen(js_name = buildObjectPreview)]
pub fn build_object_preview(kind_code: u32, seed: u32, params: &[f32], glyph_aspect: f32, frame_px: f32) -> Result<SceneryScene, JsError> {
    let kind = scenery::library::Kind::from_code(kind_code).ok_or_else(|| JsError::new(&format!("unknown object kind {kind_code}")))?;
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err(JsError::new("glyph_aspect must be a positive number"));
    }
    let asset = scenery::params::make_asset(kind, seed, params);
    let s = scenery::gallery::build_single(&asset, glyph_aspect, frame_px, seed);
    let (body, body_normals) = body_buffers(&s.body);
    let w = scenery::sky::wind_dir();
    let rb = scenery::sky::RAIN_BOX;
    Ok(SceneryScene {
        cards: s.cards,
        body,
        body_normals,
        camera: vec![s.target.x, s.target.y, s.target.z, s.eye.x, s.eye.y, s.eye.z, s.fov],
        glyph: s.glyph,
        env: vec![0.0, w[0], w[1], 0.0, 0.0, 0.0, rb[0], rb[1], rb[2]],
    })
}

/// A gallery sheet of procedural assets: "rocks", "plants", "bushes" or "trees".
#[wasm_bindgen(js_name = buildGallery)]
pub fn build_gallery(category: &str, seed: u32, glyph_aspect: f32) -> Result<SceneryScene, JsError> {
    let cat = scenery::gallery::Category::parse(category)
        .ok_or_else(|| JsError::new(&format!("unknown gallery {category:?} (rocks, plants, bushes, trees)")))?;
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err(JsError::new("glyph_aspect must be a positive number"));
    }
    let s = scenery::gallery::build_gallery(cat, seed, glyph_aspect);
    let (body, body_normals) = body_buffers(&s.body);
    let w = scenery::sky::wind_dir();
    let rb = scenery::sky::RAIN_BOX;
    Ok(SceneryScene {
        cards: s.cards,
        body,
        body_normals,
        camera: vec![s.target.x, s.target.y, s.target.z, s.eye.x, s.eye.y, s.eye.z, s.fov],
        glyph: s.glyph,
        env: vec![0.0, w[0], w[1], 0.0, 0.0, 0.0, rb[0], rb[1], rb[2]],
    })
}

/// Material names, comma-separated, indexed by material id (for the glyph inspector).
#[wasm_bindgen(js_name = materialNames)]
pub fn material_names() -> String {
    scenery::style::MAT_NAMES.join(",")
}

/// Every character scenery uses, in atlas order.
#[wasm_bindgen(js_name = sceneryCharset)]
pub fn scenery_charset() -> String {
    scenery::style::charset()
}

/// Shader material table: `materialFloats()` floats per material, indexed by
/// material id (see `scenery::skin::material_table`).
#[wasm_bindgen(js_name = sceneryMaterials)]
pub fn scenery_materials() -> Vec<f32> {
    scenery::skin::material_table()
}

#[wasm_bindgen(js_name = materialFloats)]
pub fn material_floats() -> u32 {
    scenery::skin::MATERIAL_FLOATS as u32
}

/// Sun direction for the canvas (`day` selects the preset).
#[wasm_bindgen(js_name = sceneSunDir)]
pub fn scene_sun_dir(day: bool) -> Vec<f32> {
    let s = scenery::sky::sun_for(day);
    vec![s.x, s.y, s.z]
}

/// Sun direction scenery shadows are baked with.
#[wasm_bindgen(js_name = scenerySunDir)]
pub fn scenery_sun_dir() -> Vec<f32> {
    let s = scenery::light::sun_dir();
    vec![s.x, s.y, s.z]
}

// ---- the canvas ------------------------------------------------------------------

/// Chunk size (m), physics grid (samples - 1 per side), ground height,
/// tile size (m), tiles per chunk side, floats per placed object.
#[wasm_bindgen(js_name = worldConsts)]
pub fn world_consts() -> Vec<f32> {
    use scenery::canvas;
    vec![canvas::CHUNK, canvas::GRID as f32, canvas::GROUND, canvas::TILE, canvas::TILES as f32, canvas::OBJECT_FLOATS as f32]
}

/// Placeable object kinds, comma-separated; a kind's code is its index.
#[wasm_bindgen(js_name = objectKinds)]
pub fn object_kinds() -> String {
    scenery::library::Kind::all().iter().map(|k| k.name()).collect::<Vec<_>>().join(",")
}

/// Ground paints, comma-separated; a paint's code (the tile byte) is its index.
#[wasm_bindgen(js_name = groundKinds)]
pub fn ground_kinds() -> String {
    scenery::canvas::Ground::ALL.iter().map(|g| g.name()).collect::<Vec<_>>().join(",")
}

/// The blank canvas: an endless flat map of '#' rows, built chunk by chunk
/// around the viewer, under the sky and weather.
#[wasm_bindgen]
pub struct CanvasWorld {
    inner: scenery::canvas::Canvas,
}

#[wasm_bindgen]
impl CanvasWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, day: bool) -> CanvasWorld {
        CanvasWorld { inner: scenery::canvas::Canvas::new(seed, day) }
    }

    pub fn day(&self) -> bool {
        self.inner.day
    }

    /// Ground height at (x, z), m.
    pub fn height(&self, _x: f32, _z: f32) -> f32 {
        scenery::canvas::GROUND
    }

    /// Sky dome, rain and blown leaves (all follow the camera).
    #[wasm_bindgen(js_name = skyCards)]
    pub fn sky_cards(&self, glyph_aspect: f32) -> Vec<f32> {
        self.inner.sky_cards(glyph_aspect)
    }

    /// Chunk (cx, cz) with glyphs sized for an eye at (ex, ey, ez). `tiles`:
    /// empty (all canvas) or tiles x tiles ground codes, row-major from the
    /// chunk corner; `objects`: the placed objects whose base is in this
    /// chunk, `OBJECT_FLOATS` each (see `worldConsts`); `heights`: empty
    /// (flat) or 33 x 33 ground heights, 1 m apart from the corner.
    #[wasm_bindgen(js_name = buildChunk)]
    #[allow(clippy::too_many_arguments)]
    pub fn build_chunk(&mut self, cx: i32, cz: i32, ex: f32, ey: f32, ez: f32, glyph_aspect: f32, tiles: &[u8], objects: &[f32], heights: &[f32]) -> Result<WorldChunk, JsError> {
        use scenery::canvas::{ChunkData, HEIGHTS, OBJECT_FLOATS, TILES};
        if !heights.is_empty() && (heights.len() != HEIGHTS * HEIGHTS || !heights.iter().all(|h| h.is_finite())) {
            return Err(JsError::new(&format!("heights must be empty or {} finite values", HEIGHTS * HEIGHTS)));
        }
        if !tiles.is_empty() && tiles.len() != TILES * TILES {
            return Err(JsError::new(&format!("tiles must be empty or {} bytes, got {}", TILES * TILES, tiles.len())));
        }
        if !objects.len().is_multiple_of(OBJECT_FLOATS) {
            return Err(JsError::new(&format!("objects must be {OBJECT_FLOATS} floats each, got {}", objects.len())));
        }
        let c = self.inner.build_chunk(cx, cz, math::Vec3::new(ex, ey, ez), glyph_aspect, ChunkData { tiles, objects, heights });
        let (body, body_normals) = body_buffers(&c.body);
        Ok(WorldChunk {
            cards: c.cards,
            body,
            body_normals,
            heights: c.heights,
            colliders: c.colliders.iter().flatten().copied().collect(),
            placed: c.placed as u32,
            bounds: c.bounds.iter().flatten().copied().collect(),
        })
    }
}

#[wasm_bindgen]
pub struct WorldChunk {
    cards: Vec<f32>,
    body: Vec<f32>,
    body_normals: Vec<f32>,
    heights: Vec<f32>,
    colliders: Vec<f32>,
    placed: u32,
    bounds: Vec<f32>,
}

#[wasm_bindgen]
impl WorldChunk {
    /// Objects drawn (records with an unknown kind are skipped).
    pub fn placed(&self) -> u32 {
        self.placed
    }

    /// Per object drawn: record index, then its world box (min x, y, z,
    /// max x, y, z): 7 floats each.
    #[wasm_bindgen(js_name = takeBounds)]
    pub fn take_bounds(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.bounds)
    }
    #[wasm_bindgen(js_name = takeCards)]
    pub fn take_cards(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.cards)
    }
    #[wasm_bindgen(js_name = takeBody)]
    pub fn take_body(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.body)
    }
    #[wasm_bindgen(js_name = takeBodyNormals)]
    pub fn take_body_normals(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.body_normals)
    }
    /// (GRID + 1)^2 heights, 1 m apart, from the chunk's corner.
    #[wasm_bindgen(js_name = takeHeights)]
    pub fn take_heights(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.heights)
    }
    /// x, z, radius, top y per collider.
    #[wasm_bindgen(js_name = takeColliders)]
    pub fn take_colliders(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.colliders)
    }
}

// ---- testbed scenes (dev/test builds only) ------------------------------------

/// Every character the procedural pine uses, in atlas order.
#[cfg(feature = "testbed")]
#[wasm_bindgen(js_name = pineCharset)]
pub fn pine_charset() -> String {
    testbed::pine::charset()
}

/// The procedural pine from `pine_ascii.py` as card records (`cardStride()` floats each).
#[cfg(feature = "testbed")]
#[wasm_bindgen(js_name = generatePine)]
pub fn generate_pine(seed: u32, glyph_aspect: f32) -> Result<Vec<f32>, JsError> {
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err(JsError::new("glyph_aspect must be a positive number"));
    }
    Ok(testbed::pine::generate(seed, glyph_aspect))
}

/// Sun direction the pine's shadows were baked with; the renderer must match it.
#[cfg(feature = "testbed")]
#[wasm_bindgen(js_name = pineSunDir)]
pub fn pine_sun_dir() -> Vec<f32> {
    let s = testbed::pine::sun_dir();
    vec![s.x, s.y, s.z]
}
