//! Background work (scene generation, chunk building) described as plain
//! jobs. The core defines what a job computes (`Worker::run`); a platform
//! shell decides where it runs by implementing `JobExecutor` (a thread pool on
//! desktop, Web Workers on the web). The core is generic over the executor,
//! so there is no dynamic dispatch on the hot path.

use crate::chunks::{chunk_cards, ChunkRec};
use crate::input::{Gallery, Preset};
use crate::render_data::{materials_from_table, MaterialDef};
use crate::CARD_STRIDE;
use ascii_engine as eng;

pub type JobId = u64;

#[derive(Clone, Debug)]
pub enum JobKind {
    /// Parse an STL and place cards on it.
    Stl { bytes: Vec<u8>, z_up: bool, settings: eng::CardConfig, charset: String },
    Gallery { category: Gallery, seed: u32, aspect: f32 },
    Scene { preset: Preset, seed: u32, aspect: f32 },
    WorldInit { seed: u32, day: bool, aspect: f32 },
    Chunk { seed: u32, day: bool, cx: i32, cz: i32, eye: [f32; 3], aspect: f32 },
}

#[derive(Clone, Debug)]
pub struct Job {
    pub id: JobId,
    pub kind: JobKind,
}

pub struct JobDone {
    pub id: JobId,
    /// Wall time the job took on its worker, measured by the executor.
    pub elapsed_ms: f64,
    pub output: Result<Output, String>,
}

/// Cards split into culling chunks.
pub struct CardData {
    pub cards: Vec<f32>,
    pub chunks: Vec<ChunkRec>,
}

pub struct ModelOut {
    pub positions: Vec<f32>,
    pub triangles: u32,
    pub dropped: u32,
    pub charset: String,
    pub cards: CardData,
}

pub struct WalkOut {
    pub heights: Vec<f32>,
    pub n: u32,
    pub size: f32,
    pub water: f32,
    pub water_mask: Vec<u8>,
    pub colliders: Vec<f32>,
}

/// A landscape or a gallery sheet.
pub struct SceneOut {
    pub is_scene: bool,
    pub cards: CardData,
    pub body: Vec<f32>,
    pub charset: String,
    pub materials: Vec<MaterialDef>,
    pub sun_dir: [f32; 3],
    /// target xyz, eye xyz, fov.
    pub camera: [f32; 7],
    pub day: bool,
    pub wind_dir: [f32; 2],
    pub leaf_box: [f32; 3],
    pub rain_box: [f32; 3],
    pub walk: Option<WalkOut>,
}

pub struct WorldOut {
    pub seed: u32,
    pub day: bool,
    pub cards: CardData,
    pub charset: String,
    pub materials: Vec<MaterialDef>,
    pub sun_dir: [f32; 3],
    pub chunk_size: f32,
    pub grid: u32,
    pub water: f32,
    pub spawn: [f32; 3],
}

pub struct ChunkOut {
    pub cx: i32,
    pub cz: i32,
    pub eye: [f32; 3],
    pub cards: CardData,
    pub body: Vec<f32>,
    pub heights: Vec<f32>,
    pub colliders: Vec<f32>,
}

pub enum Output {
    Model(ModelOut),
    Scene(Box<SceneOut>),
    World(WorldOut),
    Chunk(Box<ChunkOut>),
}

/// Where jobs run. `submit` must not block; `poll` appends finished jobs.
pub trait JobExecutor {
    fn submit(&mut self, job: Job);
    fn poll(&mut self, out: &mut Vec<JobDone>);
    /// Number of jobs that can run at once.
    fn workers(&self) -> usize;
    /// Drop jobs that have not started yet (a new scene replaces them).
    fn cancel_queued(&mut self);
}

/// Per-thread state for running jobs: the engine and the world's generator
/// (each chunk-building thread owns one; builds are deterministic).
#[derive(Default)]
pub struct Worker {
    engine: eng::Engine,
    world: Option<(u32, bool, eng::InfiniteWorld)>,
}

fn chunked(cards: Vec<f32>, all_global: bool) -> CardData {
    let c = chunk_cards(&cards, CARD_STRIDE, all_global);
    CardData { cards: c.cards, chunks: c.chunks }
}

fn finish_scene(s: eng::SceneryScene, is_scene: bool, sun: [f32; 3]) -> SceneOut {
    let day = s.env[0] > 0.5;
    let walk = s.walk.map(|w| WalkOut { heights: w.heights, n: w.n, size: w.size, water: w.water, water_mask: w.water_mask, colliders: w.colliders });
    SceneOut {
        is_scene,
        cards: chunked(s.cards, true),
        body: s.body,
        charset: eng::scenery_charset(),
        materials: materials_from_table(&eng::scenery_materials(), eng::material_floats() as usize),
        sun_dir: sun,
        camera: s.camera,
        day,
        wind_dir: [s.env[1], s.env[2]],
        leaf_box: [s.env[3], s.env[4], s.env[5]],
        rain_box: [s.env[6], s.env[7], s.env[8]],
        walk,
    }
}

impl Worker {
    pub fn new() -> Self {
        Self::default()
    }

    fn world(&mut self, seed: u32, day: bool) -> &mut eng::InfiniteWorld {
        let stale = !matches!(&self.world, Some((s, d, _)) if *s == seed && *d == day);
        if stale {
            self.world = Some((seed, day, eng::InfiniteWorld::new(seed, day)));
        }
        &mut self.world.as_mut().expect("just set").2
    }

    pub fn run(&mut self, kind: &JobKind) -> Result<Output, String> {
        match kind {
            JobKind::Stl { bytes, z_up, settings, charset } => {
                self.engine.load_stl(bytes, *z_up)?;
                let positions = self.engine.mesh_positions();
                let charset = eng::normalize_charset(charset)?;
                let cards = self.engine.generate(settings, &charset)?;
                Ok(Output::Model(ModelOut {
                    positions,
                    triangles: self.engine.triangle_count(),
                    dropped: self.engine.dropped_triangles(),
                    charset,
                    cards: chunked(cards, true),
                }))
            }
            JobKind::Gallery { category, seed, aspect } => {
                let s = eng::build_gallery(category.name(), *seed, *aspect)?;
                Ok(Output::Scene(Box::new(finish_scene(s, false, eng::scenery_sun_dir()))))
            }
            JobKind::Scene { preset, seed, aspect } => {
                let s = eng::build_scene(preset.name(), *seed, *aspect)?;
                let day = s.env[0] > 0.5;
                Ok(Output::Scene(Box::new(finish_scene(s, true, eng::scene_sun_dir(day)))))
            }
            JobKind::WorldInit { seed, day, aspect } => {
                let world = self.world(*seed, *day);
                let cards = world.sky_cards(*aspect);
                let [chunk_size, grid, water] = eng::world_consts();
                let spawn = find_spawn(world, water);
                Ok(Output::World(WorldOut {
                    seed: *seed,
                    day: *day,
                    cards: chunked(cards, true),
                    charset: eng::scenery_charset(),
                    materials: materials_from_table(&eng::scenery_materials(), eng::material_floats() as usize),
                    sun_dir: eng::scene_sun_dir(*day),
                    chunk_size,
                    grid: grid as u32,
                    water,
                    spawn,
                }))
            }
            JobKind::Chunk { seed, day, cx, cz, eye, aspect } => {
                let c = self.world(*seed, *day).build_chunk(*cx, *cz, *eye, *aspect);
                Ok(Output::Chunk(Box::new(ChunkOut {
                    cx: *cx,
                    cz: *cz,
                    eye: *eye,
                    cards: chunked(c.cards, false),
                    body: c.body,
                    heights: c.heights,
                    colliders: c.colliders,
                })))
            }
        }
    }
}

/// A dry, fairly flat place near the origin to start from (port of the
/// search in `worker.ts`; coordinates pass through f32 as they do into WASM).
pub fn find_spawn(world: &eng::InfiniteWorld, water: f32) -> [f32; 3] {
    let h = |x: f64, z: f64| f64::from(world.height(x as f32, z as f32));
    let mut spawn = [0.0, h(0.0, 0.0) as f32, 0.0];
    let mut r = 0.0f64;
    while r < 400.0 {
        for k in 0..24 {
            let a = (f64::from(k) / 24.0) * std::f64::consts::PI * 2.0;
            let (x, z) = (r * a.cos(), r * a.sin());
            let hh = h(x, z);
            let slope = (h(x + 2.0, z) - h(x - 2.0, z)).abs() + (h(x, z + 2.0) - h(x, z - 2.0)).abs();
            if hh > f64::from(water) + 1.0 && hh < 20.0 && slope < 1.2 {
                spawn = [x as f32, hh as f32, z as f32];
                return spawn;
            }
        }
        r += 4.0;
    }
    spawn
}

/// Runs every job immediately on the calling thread. For tests and tools.
#[derive(Default)]
pub struct InlineExecutor {
    worker: Worker,
    done: Vec<JobDone>,
}

impl InlineExecutor {
    pub fn new() -> Self {
        Self::default()
    }
}

impl JobExecutor for InlineExecutor {
    fn submit(&mut self, job: Job) {
        let output = self.worker.run(&job.kind);
        self.done.push(JobDone { id: job.id, elapsed_ms: 0.0, output });
    }
    fn poll(&mut self, out: &mut Vec<JobDone>) {
        out.append(&mut self.done);
    }
    fn workers(&self) -> usize {
        1
    }
    fn cancel_queued(&mut self) {}
}
