//! WebAssembly bindings (feature `wasm`): a thin wrapper over the native API
//! in `lib.rs`. JS names are unchanged from before the split.

use crate as native;
use wasm_bindgen::prelude::*;

fn err(e: String) -> JsError {
    JsError::new(&e)
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Floats per card in buffers returned by `Engine::generate`.
#[wasm_bindgen(js_name = cardStride)]
pub fn card_stride() -> u32 {
    native::card_stride()
}

#[wasm_bindgen(js_name = normalizeCharset)]
pub fn normalize_charset(charset: &str) -> Result<String, JsError> {
    native::normalize_charset(charset).map_err(err)
}

#[wasm_bindgen(js_name = defaultCharset)]
pub fn default_charset() -> String {
    native::default_charset()
}

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
        let c = native::CardConfig::new();
        CardConfig {
            seed: c.seed,
            glyph_size: c.glyph_size,
            size_factor: c.size_factor,
            glyph_rule: c.glyph_rule,
            pattern_scale: c.pattern_scale,
            glyph_aspect: c.glyph_aspect,
            r: c.r,
            g: c.g,
            b: c.b,
            color_jitter: c.color_jitter,
            twist: c.twist,
            tilt: c.tilt,
            alpha_min: c.alpha_min,
            alpha_max: c.alpha_max,
        }
    }
}

impl Default for CardConfig {
    fn default() -> Self {
        Self::new()
    }
}

impl CardConfig {
    fn to_native(&self) -> native::CardConfig {
        native::CardConfig {
            seed: self.seed,
            glyph_size: self.glyph_size,
            size_factor: self.size_factor,
            glyph_rule: self.glyph_rule,
            pattern_scale: self.pattern_scale,
            glyph_aspect: self.glyph_aspect,
            r: self.r,
            g: self.g,
            b: self.b,
            color_jitter: self.color_jitter,
            twist: self.twist,
            tilt: self.tilt,
            alpha_min: self.alpha_min,
            alpha_max: self.alpha_max,
        }
    }
}

#[wasm_bindgen]
#[derive(Default)]
pub struct Engine {
    inner: native::Engine,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { inner: native::Engine::new() }
    }

    #[wasm_bindgen(js_name = loadStl)]
    pub fn load_stl(&mut self, bytes: &[u8], z_up: bool) -> Result<(), JsError> {
        self.inner.load_stl(bytes, z_up).map_err(err)
    }

    #[wasm_bindgen(js_name = hasMesh)]
    pub fn has_mesh(&self) -> bool {
        self.inner.has_mesh()
    }

    #[wasm_bindgen(js_name = triangleCount)]
    pub fn triangle_count(&self) -> u32 {
        self.inner.triangle_count()
    }

    #[wasm_bindgen(js_name = droppedTriangles)]
    pub fn dropped_triangles(&self) -> u32 {
        self.inner.dropped_triangles()
    }

    #[wasm_bindgen(js_name = meshPositions)]
    pub fn mesh_positions(&self) -> Vec<f32> {
        self.inner.mesh_positions()
    }

    #[wasm_bindgen(js_name = meshNormals)]
    pub fn mesh_normals(&self) -> Vec<f32> {
        self.inner.mesh_normals()
    }

    pub fn generate(&self, config: &CardConfig, charset: &str) -> Result<Vec<f32>, JsError> {
        self.inner.generate(&config.to_native(), charset).map_err(err)
    }
}

#[wasm_bindgen]
pub struct SceneryScene {
    inner: native::SceneryScene,
}

#[wasm_bindgen]
impl SceneryScene {
    #[wasm_bindgen(js_name = takeCards)]
    pub fn take_cards(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.cards)
    }
    #[wasm_bindgen(js_name = takeBody)]
    pub fn take_body(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.body)
    }
    #[wasm_bindgen(js_name = takeBodyNormals)]
    pub fn take_body_normals(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.body_normals)
    }
    /// target xyz, eye xyz, vertical fov in degrees.
    pub fn camera(&self) -> Vec<f32> {
        self.inner.camera.to_vec()
    }
    pub fn glyph(&self) -> f32 {
        self.inner.glyph
    }
    #[wasm_bindgen(js_name = takeHeights)]
    pub fn take_heights(&mut self) -> Vec<f32> {
        self.inner.walk.as_mut().map_or_else(Vec::new, |w| std::mem::take(&mut w.heights))
    }
    /// n, size (metres), water level (NaN without a lake).
    #[wasm_bindgen(js_name = walkInfo)]
    pub fn walk_info(&self) -> Vec<f32> {
        self.inner.walk.as_ref().map_or_else(Vec::new, |w| vec![w.n as f32, w.size, w.water])
    }
    #[wasm_bindgen(js_name = takeWaterMask)]
    pub fn take_water_mask(&mut self) -> Vec<u8> {
        self.inner.walk.as_mut().map_or_else(Vec::new, |w| std::mem::take(&mut w.water_mask))
    }
    #[wasm_bindgen(js_name = takeColliders)]
    pub fn take_colliders(&mut self) -> Vec<f32> {
        self.inner.walk.as_mut().map_or_else(Vec::new, |w| std::mem::take(&mut w.colliders))
    }
    pub fn env(&self) -> Vec<f32> {
        self.inner.env.to_vec()
    }
}

#[wasm_bindgen(js_name = buildScene)]
pub fn build_scene(preset: &str, seed: u32, glyph_aspect: f32) -> Result<SceneryScene, JsError> {
    native::build_scene(preset, seed, glyph_aspect).map(|inner| SceneryScene { inner }).map_err(err)
}

#[wasm_bindgen(js_name = buildGallery)]
pub fn build_gallery(category: &str, seed: u32, glyph_aspect: f32) -> Result<SceneryScene, JsError> {
    native::build_gallery(category, seed, glyph_aspect).map(|inner| SceneryScene { inner }).map_err(err)
}

#[wasm_bindgen(js_name = sceneryCharset)]
pub fn scenery_charset() -> String {
    native::scenery_charset()
}

#[wasm_bindgen(js_name = sceneryMaterials)]
pub fn scenery_materials() -> Vec<f32> {
    native::scenery_materials()
}

#[wasm_bindgen(js_name = materialFloats)]
pub fn material_floats() -> u32 {
    native::material_floats()
}

#[wasm_bindgen(js_name = sceneSunDir)]
pub fn scene_sun_dir(day: bool) -> Vec<f32> {
    native::scene_sun_dir(day).to_vec()
}

#[wasm_bindgen(js_name = scenerySunDir)]
pub fn scenery_sun_dir() -> Vec<f32> {
    native::scenery_sun_dir().to_vec()
}

#[wasm_bindgen(js_name = worldConsts)]
pub fn world_consts() -> Vec<f32> {
    native::world_consts().to_vec()
}

#[wasm_bindgen]
pub struct InfiniteWorld {
    inner: native::InfiniteWorld,
}

#[wasm_bindgen]
impl InfiniteWorld {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u32, day: bool) -> InfiniteWorld {
        InfiniteWorld { inner: native::InfiniteWorld::new(seed, day) }
    }
    pub fn day(&self) -> bool {
        self.inner.day()
    }
    pub fn height(&self, x: f32, z: f32) -> f32 {
        self.inner.height(x, z)
    }
    #[wasm_bindgen(js_name = skyCards)]
    pub fn sky_cards(&self, glyph_aspect: f32) -> Vec<f32> {
        self.inner.sky_cards(glyph_aspect)
    }
    #[wasm_bindgen(js_name = buildChunk)]
    #[allow(clippy::too_many_arguments)]
    pub fn build_chunk(&mut self, cx: i32, cz: i32, ex: f32, ey: f32, ez: f32, glyph_aspect: f32) -> WorldChunk {
        WorldChunk { inner: self.inner.build_chunk(cx, cz, [ex, ey, ez], glyph_aspect) }
    }
}

#[wasm_bindgen]
pub struct WorldChunk {
    inner: native::WorldChunk,
}

#[wasm_bindgen]
impl WorldChunk {
    #[wasm_bindgen(js_name = takeCards)]
    pub fn take_cards(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.cards)
    }
    #[wasm_bindgen(js_name = takeBody)]
    pub fn take_body(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.body)
    }
    #[wasm_bindgen(js_name = takeBodyNormals)]
    pub fn take_body_normals(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.body_normals)
    }
    #[wasm_bindgen(js_name = takeHeights)]
    pub fn take_heights(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.heights)
    }
    #[wasm_bindgen(js_name = takeColliders)]
    pub fn take_colliders(&mut self) -> Vec<f32> {
        std::mem::take(&mut self.inner.colliders)
    }
}

#[cfg(feature = "testbed")]
#[wasm_bindgen(js_name = pineCharset)]
pub fn pine_charset() -> String {
    native::pine_charset()
}

#[cfg(feature = "testbed")]
#[wasm_bindgen(js_name = generatePine)]
pub fn generate_pine(seed: u32, glyph_aspect: f32) -> Result<Vec<f32>, JsError> {
    native::generate_pine(seed, glyph_aspect).map_err(err)
}

#[cfg(feature = "testbed")]
#[wasm_bindgen(js_name = pineSunDir)]
pub fn pine_sun_dir() -> Vec<f32> {
    native::pine_sun_dir().to_vec()
}
