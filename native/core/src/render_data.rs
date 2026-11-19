//! What the core hands to a renderer, independent of any graphics API:
//! rare `RenderEvent`s (new buffers) and a small `FrameParams` per frame.

use crate::chunks::ChunkRec;
use crate::weather::Environment;

/// Shader material table size.
pub const MAX_MATERIALS: usize = 64;

/// Per-material shading, indexed by the material id packed in each card
/// (see `cards.ts` for the meaning of each field).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MaterialDef {
    pub spec: f32,
    pub shininess: f32,
    pub trans: f32,
    pub wrap: f32,
    pub billboard: f32,
    pub twist: f32,
    pub alpha_lit: f32,
    pub haze: f32,
    pub flex: f32,
    pub flow: f32,
    pub fog: f32,
    /// Chain of cards along a branch (thinned along one dimension with distance).
    pub chain: f32,
}

/// Material 0: cards lying on a model's surface.
pub const SURFACE_MATERIAL: MaterialDef = MaterialDef {
    spec: 0.25,
    shininess: 18.0,
    trans: 0.15,
    wrap: 0.25,
    billboard: 0.0,
    twist: 0.0,
    alpha_lit: 0.0,
    haze: 0.0,
    flex: 0.0,
    flow: 0.0,
    fog: 0.0,
    chain: 0.0,
};

/// Engine material table (`floats` per material) -> material defs.
pub fn materials_from_table(t: &[f32], floats: usize) -> Vec<MaterialDef> {
    let g = |i: usize, k: usize| t.get(i + k).copied().unwrap_or(0.0);
    (0..t.len() / floats)
        .map(|m| {
            let i = m * floats;
            MaterialDef {
                spec: g(i, 0),
                shininess: g(i, 1),
                trans: g(i, 2),
                wrap: g(i, 3),
                billboard: g(i, 4).trunc(),
                twist: g(i, 5),
                alpha_lit: g(i, 6),
                haze: g(i, 7),
                flex: g(i, 8),
                flow: g(i, 9),
                fog: g(i, 10),
                chain: g(i, 11),
            }
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Lighting {
    pub sun_dir: [f32; 3],
    pub sun_color: [f32; 3],
    pub sky_color: [f32; 3],
    pub glint_color: [f32; 3],
    /// Tone curve: colour = 1 - exp(-exposure * radiance).
    pub exposure: f32,
    pub sky_gain: f32,
    pub ambient: f32,
    pub hemi: f32,
}

fn norm(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-12);
    [v[0] / l, v[1] / l, v[2] / l]
}

impl Lighting {
    /// STL models.
    pub fn model() -> Self {
        Lighting {
            sun_dir: norm([-0.6, 0.55, 0.6]),
            sun_color: [1.3, 0.92, 0.58],
            sky_color: [0.46, 0.52, 0.8],
            glint_color: [1.0, 0.86, 0.62],
            exposure: 2.2,
            sky_gain: 0.5,
            ambient: 0.03,
            hemi: 1.0,
        }
    }
    /// Scenery `dusk` preset.
    pub fn dusk(sun_dir: [f32; 3]) -> Self {
        Lighting {
            sun_dir: norm(sun_dir),
            sun_color: [1.3, 0.92, 0.58],
            sky_color: [0.46, 0.52, 0.8],
            glint_color: [1.0, 0.86, 0.62],
            exposure: 3.0,
            sky_gain: 0.95,
            ambient: 0.05,
            hemi: 0.0,
        }
    }
    /// Scenery `day` preset.
    pub fn day(sun_dir: [f32; 3]) -> Self {
        Lighting {
            sun_dir: norm(sun_dir),
            sun_color: [1.15, 1.08, 0.95],
            sky_color: [0.55, 0.68, 0.95],
            glint_color: [1.0, 0.98, 0.92],
            exposure: 2.2,
            sky_gain: 0.95,
            ambient: 0.05,
            hemi: 0.0,
        }
    }
}

/// Key of the main card set / body (a scene's cards, a world's sky, rain and leaves).
/// Streamed chunk keys never take this value (see `streamer::chunk_key`).
pub const MAIN_SET: u64 = u64::MAX;

/// Continuous detail for a card set whose glyphs were sized for `eye` (one
/// glyph ~ a fixed number of pixels at each card's distance from it). Each
/// frame the renderer grows the cards that are now farther and hides a random
/// share of them, so glyphs keep their size on screen and the same coverage;
/// nearer than built, cards stay as they are until the set is rebuilt.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CardLod {
    pub eye: [f32; 3],
    /// Distance under which glyph sizes stop shrinking (the engine's `near`).
    pub near: f32,
    /// Cards fade out toward this horizontal distance from the camera (0: never).
    pub far: f32,
}

/// Big, infrequent updates to the renderer's GPU state.
pub enum RenderEvent {
    /// Rebuild the glyph atlas from this (engine-normalized) charset.
    SetAtlas { charset: String },
    SetMaterials(Vec<MaterialDef>),
    /// Add or replace a set of cards (`CARD_STRIDE` floats each) with its culling chunks.
    /// `lod`: the cards were sized for that eye; the renderer keeps their detail
    /// right for the current one (see `CardLod`).
    SetCards { key: u64, cards: Vec<f32>, chunks: Vec<ChunkRec>, lod: Option<CardLod> },
    RemoveCards { key: u64 },
    ClearCards,
    /// Opaque occluder triangles (9 floats each).
    SetBody { key: u64, positions: Vec<f32> },
    RemoveBody { key: u64 },
    ClearBodies,
}

/// Everything the renderer needs each frame (small, plain data).
#[derive(Clone, Debug)]
pub struct FrameParams {
    /// Column-major, f32 (converted from the core's f64 camera).
    pub view: [f32; 16],
    pub proj: [f32; 16],
    pub camera_pos: [f32; 3],
    /// Vertical field of view in radians (for LOD or debug use).
    pub fov_y: f32,
    pub viewport: [u32; 2],
    /// Animation clock, seconds.
    pub time: f32,
    pub lighting: Lighting,
    pub env: Environment,
    /// Background colour as written to the screen (no colour conversion).
    pub background: [f32; 3],
    /// false: blended cards without depth writes (STL models); true: alpha-to-coverage.
    pub coverage: bool,
    /// Cards are pulled toward the eye by this fraction of their size.
    pub depth_bias: f32,
    pub alpha_gain: f32,
    pub underpaint: bool,
    pub underpaint_strength: f32,
    pub underpaint_card_alpha: f32,
}

/// Dusk background, `0x090c13`.
pub const DUSK_BACKGROUND: [f32; 3] = [9.0 / 255.0, 12.0 / 255.0, 19.0 / 255.0];
pub const DAY_BACKGROUND: [f32; 3] = [34.0 / 255.0, 44.0 / 255.0, 58.0 / 255.0];
