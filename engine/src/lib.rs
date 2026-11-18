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
    let mut body = Vec::with_capacity(s.body.len() * 9);
    let mut body_normals = Vec::with_capacity(s.body.len() * 9);
    for t in &s.body {
        let n = (t[1] - t[0]).cross(t[2] - t[0]).try_normalize().unwrap_or(math::Vec3::Y);
        for v in t {
            body.extend_from_slice(&[v.x, v.y, v.z]);
            body_normals.extend_from_slice(&[n.x, n.y, n.z]);
        }
    }
    Ok(SceneryScene {
        cards: s.cards,
        body,
        body_normals,
        camera: vec![s.target.x, s.target.y, s.target.z, s.eye.x, s.eye.y, s.eye.z, s.fov],
        glyph: s.glyph,
    })
}

/// Every character scenery uses, in atlas order.
#[wasm_bindgen(js_name = sceneryCharset)]
pub fn scenery_charset() -> String {
    scenery::style::charset()
}

/// Shader material table: 8 floats per material (spec, shininess, trans,
/// wrap, billboard, twist, alphaLit, haze), indexed by material id.
#[wasm_bindgen(js_name = sceneryMaterials)]
pub fn scenery_materials() -> Vec<f32> {
    scenery::skin::material_table()
}

/// Sun direction scenery shadows are baked with.
#[wasm_bindgen(js_name = scenerySunDir)]
pub fn scenery_sun_dir() -> Vec<f32> {
    let s = scenery::light::sun_dir();
    vec![s.x, s.y, s.z]
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
