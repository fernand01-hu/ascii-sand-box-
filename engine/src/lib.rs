//! ASCII scene engine.
//!
//! Pipeline: STL bytes -> `stl::parse` -> `Mesh::from_triangles` (clean,
//! normalize, smooth normals) -> `cards::generate` (one glyph card per sample).
//!
//! The pure-Rust API (`load_mesh`, `cards::generate`) is what the tests use;
//! the `Engine` type below is the thin WebAssembly wrapper the browser calls.

pub mod cards;
pub mod math;
pub mod mesh;
pub mod rng;
pub mod stl;

use wasm_bindgen::prelude::*;

pub use cards::{CardParams, STRIDE};
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

/// Settings for one card generation pass. Plain numbers so JS can set them directly.
#[wasm_bindgen]
#[derive(Clone, Debug)]
pub struct CardConfig {
    pub seed: u32,
    pub count: u32,
    #[wasm_bindgen(js_name = sizeFactor)]
    pub size_factor: f32,
    #[wasm_bindgen(js_name = glyphCount)]
    pub glyph_count: u32,
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
        CardParams::default().into()
    }
}

impl Default for CardConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl From<CardParams> for CardConfig {
    fn from(p: CardParams) -> Self {
        CardConfig {
            seed: p.seed,
            count: p.count,
            size_factor: p.size_factor,
            glyph_count: p.glyph_count,
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

impl From<&CardConfig> for CardParams {
    fn from(c: &CardConfig) -> Self {
        CardParams {
            seed: c.seed,
            count: c.count,
            size_factor: c.size_factor,
            glyph_count: c.glyph_count,
            glyph_aspect: c.glyph_aspect,
            color: [c.r, c.g, c.b],
            color_jitter: c.color_jitter,
            twist: c.twist,
            tilt: c.tilt,
            alpha_min: c.alpha_min,
            alpha_max: c.alpha_max,
        }
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

    /// Card records, `cardStride()` floats each.
    pub fn generate(&self, config: &CardConfig) -> Result<Vec<f32>, JsError> {
        let mesh = self.mesh.as_ref().ok_or_else(|| JsError::new("no mesh loaded"))?;
        cards::generate(mesh, &config.into()).map_err(|e| JsError::new(&e.to_string()))
    }
}

pub mod pine;

/// Every character the procedural pine uses, in atlas order.
#[wasm_bindgen(js_name = pineCharset)]
pub fn pine_charset() -> String {
    pine::charset()
}

/// The procedural pine from `pine_ascii.py` as card records (`cardStride()` floats each).
#[wasm_bindgen(js_name = generatePine)]
pub fn generate_pine(seed: u32, glyph_aspect: f32) -> Result<Vec<f32>, JsError> {
    if !(glyph_aspect > 0.0 && glyph_aspect.is_finite()) {
        return Err(JsError::new("glyph_aspect must be a positive number"));
    }
    Ok(pine::generate(seed, glyph_aspect))
}

/// Sun direction the pine's shadows were baked with; the renderer must match it.
#[wasm_bindgen(js_name = pineSunDir)]
pub fn pine_sun_dir() -> Vec<f32> {
    let s = pine::sun_dir();
    vec![s.x, s.y, s.z]
}
