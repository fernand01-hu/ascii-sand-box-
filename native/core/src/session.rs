//! The session: the product core of the app (port of `App` + the parts of
//! `Viewer` that are not drawing). It owns the camera, the player, the
//! weather, the world streamer and the job bookkeeping, and turns finished
//! jobs into `RenderEvent`s. Shells drive it with `command`, `pointer`,
//! `resize` and `update`, then read `drain_events` and `frame_params`.

use crate::glyphs::{glyph_aspect, GLYPH_HEIGHT};
use crate::input::{Command, InputState, Pointer};
use crate::jobs::{CardData, Job, JobDone, JobExecutor, JobId, JobKind, Output, SceneOut, WalkOut};
use crate::orbit::Orbit;
use crate::physics::{GridGround, GridWorld, Ground};
use crate::player::Player;
use crate::render_data::*;
use crate::streamer::{WorldInfo, WorldStreamer};
use crate::weather::{scene_weather, Environment, CALM};
use ascii_engine::CardConfig;
use glam::{DMat4, DVec3};
use std::collections::HashMap;

pub const DEFAULT_CHARSET: &str = ":-=+*xoO#%&8@BMW";

/// The webapp's default card settings (`defaultSettings()` in app.ts).
pub fn default_settings() -> CardConfig {
    CardConfig {
        seed: 7,
        glyph_size: 0.045,
        size_factor: 1.6,
        glyph_rule: 1,
        pattern_scale: 0.22,
        glyph_aspect: glyph_aspect(GLYPH_HEIGHT),
        r: 0.78,
        g: 0.62,
        b: 0.45,
        color_jitter: 0.12,
        twist: 0.25,
        tilt: 0.15,
        alpha_min: 0.8,
        alpha_max: 1.0,
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Loading,
    Ready,
    Error(String),
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub model: String,
    pub cards: u64,
    pub triangles: u32,
    /// Last scene/model generation time on its worker, ms.
    pub generate_ms: f64,
    pub chunks_built: u32,
    pub chunks_loaded: usize,
    pub chunks_pending: usize,
    /// Slowest and mean chunk build time seen, ms.
    pub chunk_ms_max: f64,
    pub chunk_ms_mean: f64,
}

enum Purpose {
    Load { token: u64, name: String },
    Chunk { epoch: u64, cx: i32, cz: i32 },
}

/// The ground the player walks on.
enum GroundKind {
    None,
    Grid(Box<GridGround>),
    World(Box<WorldStreamer>),
}

impl Ground for GroundKind {
    fn height(&self, x: f64, z: f64) -> f64 {
        match self {
            GroundKind::None => f64::NAN,
            GroundKind::Grid(g) => g.height(x, z),
            GroundKind::World(w) => w.height(x, z),
        }
    }
    fn is_water(&self, x: f64, z: f64) -> bool {
        match self {
            GroundKind::None => false,
            GroundKind::Grid(g) => g.is_water(x, z),
            GroundKind::World(w) => w.is_water(x, z),
        }
    }
    fn in_bounds(&self, x: f64, z: f64) -> bool {
        match self {
            GroundKind::None => false,
            GroundKind::Grid(g) => g.in_bounds(x, z),
            GroundKind::World(w) => w.in_bounds(x, z),
        }
    }
    fn colliders_near<F: FnMut(f64, f64, f64, f64)>(&self, x: f64, z: f64, f: F) {
        match self {
            GroundKind::None => {}
            GroundKind::Grid(g) => g.colliders_near(x, z, f),
            GroundKind::World(w) => w.colliders_near(x, z, f),
        }
    }
}

pub struct Session<E: JobExecutor> {
    exec: E,
    events: Vec<RenderEvent>,
    done_buf: Vec<JobDone>,
    settings: CardConfig,
    atlas_charset: String,
    // camera
    orbit: Orbit,
    fov_deg: f64,
    near: f64,
    far: f64,
    viewport: (u32, u32),
    player: Option<Player>,
    ground: GroundKind,
    // look
    lighting: Lighting,
    env: Environment,
    background: [f32; 3],
    coverage: bool,
    depth_bias: f32,
    // clock
    animate: bool,
    time: f64,
    frozen: Option<f64>,
    last_now: Option<f64>,
    epoch: u64,
    // jobs
    latest: u64,
    next_id: JobId,
    pending: HashMap<JobId, Purpose>,
    status: Status,
    stats: Stats,
    chunk_ms_sum: f64,
    chunk_ms_n: u64,
}

impl<E: JobExecutor> Session<E> {
    pub fn new(exec: E, viewport: (u32, u32)) -> Self {
        let mut s = Session {
            exec,
            events: Vec::new(),
            done_buf: Vec::new(),
            settings: default_settings(),
            atlas_charset: String::new(),
            orbit: Orbit::default(),
            fov_deg: 35.0,
            near: 0.01,
            far: 100.0,
            viewport,
            player: None,
            ground: GroundKind::None,
            lighting: Lighting::model(),
            env: CALM,
            background: DUSK_BACKGROUND,
            coverage: false,
            depth_bias: 0.75,
            animate: false,
            time: 0.0,
            frozen: None,
            last_now: None,
            epoch: 0,
            latest: 0,
            next_id: 1,
            pending: HashMap::new(),
            status: Status::Loading,
            stats: Stats::default(),
            chunk_ms_sum: 0.0,
            chunk_ms_n: 0,
        };
        s.events.push(RenderEvent::SetAtlas { charset: DEFAULT_CHARSET.to_string() });
        s.atlas_charset = DEFAULT_CHARSET.to_string();
        s
    }

    pub fn status(&self) -> &Status {
        &self.status
    }

    pub fn stats(&self) -> Stats {
        let mut s = self.stats.clone();
        if let GroundKind::World(w) = &self.ground {
            s.chunks_built = w.built;
            s.chunks_loaded = w.loaded_count();
            s.chunks_pending = w.pending();
        }
        s.chunk_ms_mean = if self.chunk_ms_n > 0 { self.chunk_ms_sum / self.chunk_ms_n as f64 } else { 0.0 };
        s
    }

    pub fn playing(&self) -> bool {
        self.player.is_some()
    }

    pub fn player(&self) -> Option<&Player> {
        self.player.as_ref()
    }

    pub fn player_mut(&mut self) -> Option<&mut Player> {
        self.player.as_mut()
    }

    pub fn environment(&self) -> &Environment {
        &self.env
    }

    pub fn executor_mut(&mut self) -> &mut E {
        &mut self.exec
    }

    pub fn resize(&mut self, w: u32, h: u32) {
        self.viewport = (w.max(1), h.max(1));
    }

    fn aspect(&self) -> f64 {
        f64::from(self.viewport.0) / f64::from(self.viewport.1)
    }

    pub fn camera_position(&self) -> DVec3 {
        self.player.as_ref().map_or(self.orbit.position, Player::eye)
    }

    /// Take the pending renderer updates (swap, so the buffer is reused).
    pub fn drain_events(&mut self, out: &mut Vec<RenderEvent>) {
        out.clear();
        std::mem::swap(out, &mut self.events);
    }

    // ---- commands -----------------------------------------------------------

    pub fn command(&mut self, cmd: Command) {
        match cmd {
            Command::LoadStl { bytes, name } => self.load_stl(bytes, name),
            Command::Gallery(g) => {
                let aspect = glyph_aspect(GLYPH_HEIGHT);
                self.start(format!("gallery-{}", g.name()), JobKind::Gallery { category: g, seed: 1, aspect });
            }
            Command::Scene(p) => {
                let aspect = glyph_aspect(GLYPH_HEIGHT);
                self.start(format!("scene-{}", p.name()), JobKind::Scene { preset: p, seed: 1, aspect });
            }
            Command::World => self.show_world(1, false),
            Command::TogglePlay => {
                if self.player.is_some() {
                    self.stop_playing();
                } else {
                    self.play();
                }
            }
            Command::CycleWind => self.env.cycle_wind(),
            Command::ToggleRain => self.env.toggle_rain(),
            Command::ToggleLeaves => self.env.toggle_leaves(),
            Command::FreezeTime(t) => {
                self.frozen = t;
                if let Some(t) = t {
                    self.time = t;
                }
            }
        }
    }

    /// Show the infinite world with an explicit seed (command line, tests).
    pub fn show_world(&mut self, seed: u32, day: bool) {
        let aspect = glyph_aspect(GLYPH_HEIGHT);
        self.start("world".to_string(), JobKind::WorldInit { seed, day, aspect });
    }

    pub fn show_scene(&mut self, preset: crate::input::Preset, seed: u32) {
        let aspect = glyph_aspect(GLYPH_HEIGHT);
        self.start(format!("scene-{}", preset.name()), JobKind::Scene { preset, seed, aspect });
    }

    pub fn show_gallery(&mut self, g: crate::input::Gallery, seed: u32) {
        let aspect = glyph_aspect(GLYPH_HEIGHT);
        self.start(format!("gallery-{}", g.name()), JobKind::Gallery { category: g, seed, aspect });
    }

    pub fn load_stl(&mut self, bytes: Vec<u8>, name: String) {
        let kind = JobKind::Stl { bytes, z_up: true, settings: self.settings.clone(), charset: DEFAULT_CHARSET.to_string() };
        self.start(name, kind);
    }

    fn start(&mut self, name: String, kind: JobKind) {
        self.latest += 1;
        self.exec.cancel_queued();
        // Streamed chunks of the old world are pointless now.
        self.pending.retain(|_, p| matches!(p, Purpose::Load { .. }));
        self.status = Status::Loading;
        self.stats.model = name.clone();
        let id = self.next_id;
        self.next_id += 1;
        self.pending.insert(id, Purpose::Load { token: self.latest, name });
        self.exec.submit(Job { id, kind });
    }

    pub fn pointer(&mut self, p: Pointer) {
        let h = f64::from(self.viewport.1);
        match p {
            Pointer::Rotate { dx, dy } if self.orbit.enabled => self.orbit.rotate(dx, dy, h),
            Pointer::Pan { dx, dy } if self.orbit.enabled => self.orbit.pan(dx, dy, h),
            Pointer::Zoom(d) if self.orbit.enabled => self.orbit.zoom(d),
            Pointer::Look { dx, dy } => {
                if let Some(pl) = &mut self.player {
                    pl.look(dx, dy);
                }
            }
            _ => {}
        }
    }

    // ---- per-frame ----------------------------------------------------------

    /// Advance everything to `now` (seconds, any monotonic origin).
    pub fn update(&mut self, now: f64, input: &InputState) {
        let dt = self.last_now.map_or(0.0, |l| (now - l).clamp(0.0, 0.1));
        self.last_now = Some(now);
        self.poll_jobs();
        if let Some(p) = &mut self.player {
            p.update(&self.ground, input, dt);
        }
        if self.orbit.enabled {
            self.orbit.update();
        }
        if self.animate && self.frozen.is_none() {
            self.time += dt;
        }
        if let GroundKind::World(w) = &mut self.ground {
            let eye = self.player.as_ref().map_or(self.orbit.position, Player::eye);
            let epoch = self.epoch;
            let pending = &mut self.pending;
            w.update(&mut self.exec, &mut self.next_id, &mut self.events, |id, cx, cz| {
                pending.insert(id, Purpose::Chunk { epoch, cx, cz });
            }, eye, now, false);
        }
    }

    fn poll_jobs(&mut self) {
        self.exec.poll(&mut self.done_buf);
        let done = std::mem::take(&mut self.done_buf);
        for d in done {
            let Some(purpose) = self.pending.remove(&d.id) else { continue };
            match purpose {
                Purpose::Chunk { epoch, cx, cz } => {
                    if epoch != self.epoch {
                        continue;
                    }
                    if let GroundKind::World(w) = &mut self.ground {
                        let out = match d.output {
                            Ok(Output::Chunk(c)) => Some(c),
                            Err(e) => {
                                eprintln!("[ascii] world chunk failed: {e}");
                                None
                            }
                            _ => None,
                        };
                        if out.is_some() {
                            self.chunk_ms_sum += d.elapsed_ms;
                            self.chunk_ms_n += 1;
                            self.stats.chunk_ms_max = self.stats.chunk_ms_max.max(d.elapsed_ms);
                        }
                        w.on_chunk(cx, cz, out, &mut self.events);
                    }
                }
                Purpose::Load { token, name } => {
                    if token != self.latest {
                        continue;
                    }
                    match d.output {
                        Ok(out) => {
                            self.stats.generate_ms = d.elapsed_ms;
                            self.apply(out, &name);
                            self.status = Status::Ready;
                        }
                        Err(e) => {
                            eprintln!("[ascii] could not load {name}: {e}");
                            self.status = Status::Error(e);
                        }
                    }
                }
            }
        }
        self.done_buf = Vec::new();
    }

    // ---- applying results ---------------------------------------------------

    fn set_atlas(&mut self, charset: &str) {
        if self.atlas_charset != charset {
            self.atlas_charset = charset.to_string();
            self.events.push(RenderEvent::SetAtlas { charset: charset.to_string() });
        }
    }

    fn set_cards(&mut self, c: CardData) {
        self.stats.cards = c.cards.len() as u64 / crate::CARD_STRIDE as u64;
        self.events.push(RenderEvent::ClearCards);
        self.events.push(RenderEvent::SetCards { key: 0, cards: c.cards, chunks: c.chunks });
    }

    fn reset_environment(&mut self, animate: bool, background: [f32; 3]) {
        self.env = CALM;
        self.animate = animate;
        self.background = background;
    }

    /// Back to nothing: stop walking, forget the walkable ground, drop bodies.
    fn leave_scene(&mut self) {
        self.stop_playing();
        self.epoch += 1;
        if let GroundKind::World(w) = &mut self.ground {
            w.dispose(&mut self.events);
        }
        self.ground = GroundKind::None;
        self.events.push(RenderEvent::ClearBodies);
    }

    fn apply(&mut self, out: Output, name: &str) {
        match out {
            Output::Model(m) => {
                self.leave_scene();
                self.reset_environment(false, DUSK_BACKGROUND);
                self.set_atlas(&m.charset);
                self.events.push(RenderEvent::SetMaterials(vec![SURFACE_MATERIAL]));
                self.lighting = Lighting::model();
                self.stats.triangles = m.triangles;
                // setMesh: body, blended cards, orbit all the way round, frame it.
                self.coverage = false;
                self.depth_bias = 0.75;
                self.orbit.max_polar = std::f64::consts::PI;
                self.frame(&m.positions);
                self.events.push(RenderEvent::SetBody { key: 0, positions: m.positions });
                self.set_cards(m.cards);
                eprintln!("[ascii] {name}: {} triangles ({} dropped), {} cards", m.triangles, m.dropped, self.stats.cards);
            }
            Output::Scene(s) => self.apply_scene(*s, name),
            Output::World(w) => self.apply_world(w),
            Output::Chunk(_) => {}
        }
    }

    fn apply_scene(&mut self, s: SceneOut, name: &str) {
        self.leave_scene();
        let day = s.day;
        let bg = if s.is_scene && day { DAY_BACKGROUND } else { DUSK_BACKGROUND };
        self.reset_environment(s.is_scene, bg);
        if s.is_scene {
            let haze = if day { [176.0 / 255.0, 194.0 / 255.0, 214.0 / 255.0] } else { [74.0 / 255.0, 72.0 / 255.0, 104.0 / 255.0] };
            self.env.wind_dir = s.wind_dir;
            self.env.leaf_box = s.leaf_box;
            self.env.rain_box = s.rain_box;
            self.env.fog_dist = 420.0;
            self.env.fog = 1.0;
            self.env.haze_color = haze;
        }
        self.set_atlas(&s.charset);
        self.events.push(RenderEvent::SetMaterials(s.materials));
        self.lighting = if s.is_scene && day { Lighting::day(s.sun_dir) } else { Lighting::dusk(s.sun_dir) };
        self.stats.triangles = (s.body.len() / 9) as u32;
        let has_body = !s.body.is_empty();
        let [tx, ty, tz, ex, ey, ez, fov] = s.camera.map(f64::from);
        self.free_scene(DVec3::new(tx, ty, tz), DVec3::new(ex, ey, ez), fov, if s.is_scene { Some(3000.0) } else { None }, has_body);
        if has_body {
            self.events.push(RenderEvent::SetBody { key: 0, positions: s.body });
        }
        self.set_cards(s.cards);
        if let Some(w) = s.walk {
            self.ground = GroundKind::Grid(Box::new(GridGround::new(walk_world(w))));
        }
        if s.is_scene {
            let preset = name.trim_start_matches("scene-");
            let (wind, rain, leaves) = scene_weather(preset);
            self.env.set(Some(wind), Some(rain), Some(leaves));
        }
        eprintln!("[ascii] {name}: {} cards, {} body triangles", self.stats.cards, self.stats.triangles);
    }

    fn apply_world(&mut self, w: crate::jobs::WorldOut) {
        self.leave_scene();
        let day = w.day;
        let bg = if day { DAY_BACKGROUND } else { DUSK_BACKGROUND };
        self.reset_environment(true, bg);
        let haze = if day { [176.0 / 255.0, 194.0 / 255.0, 214.0 / 255.0] } else { [74.0 / 255.0, 72.0 / 255.0, 104.0 / 255.0] };
        self.env.wind_dir = [0.89, -0.45];
        self.env.leaf_box = [0.0, 0.0, 90.0];
        self.env.rain_box = [36.0, 24.0, 36.0];
        self.env.fog_dist = 140.0; // thick enough that the edge of the loaded area melts away
        self.env.fog = 1.0;
        self.env.haze_color = haze;
        self.set_atlas(&w.charset);
        self.events.push(RenderEvent::SetMaterials(w.materials));
        self.lighting = if day { Lighting::day(w.sun_dir) } else { Lighting::dusk(w.sun_dir) };
        self.set_cards(w.cards);
        let [sx, sy, sz] = w.spawn.map(f64::from);
        self.free_scene(DVec3::new(sx, sy + 1.0, sz - 30.0), DVec3::new(sx, sy + 7.0, sz), 50.0, Some(3000.0), false);
        self.orbit.max_distance = 400.0;
        let seed = w.seed;
        let mut streamer = WorldStreamer::new(
            WorldInfo { chunk_size: f64::from(w.chunk_size), grid: w.grid as usize, water: f64::from(w.water) },
            seed,
            day,
            glyph_aspect(GLYPH_HEIGHT),
            self.exec.workers(),
        );
        let epoch = self.epoch;
        let pending = &mut self.pending;
        streamer.update(&mut self.exec, &mut self.next_id, &mut self.events, |id, cx, cz| {
            pending.insert(id, Purpose::Chunk { epoch, cx, cz });
        }, self.orbit.position, 0.0, true);
        self.ground = GroundKind::World(Box::new(streamer));
        self.env.set(Some(0.3), Some(0.0), Some(0.5));
        eprintln!("[ascii] world seed {seed}: streaming chunks of {} m round ({:.0}, {:.0})", w.chunk_size, sx, sz);
    }
}

fn walk_world(w: WalkOut) -> GridWorld {
    GridWorld {
        heights: w.heights,
        n: w.n as usize,
        size: f64::from(w.size),
        water: if w.water.is_nan() { None } else { Some(f64::from(w.water)) },
        water_mask: w.water_mask,
        colliders: w.colliders,
    }
}

impl<E: JobExecutor> Session<E> {
    /// Free-standing scene: camera placed explicitly, orbit kept above the ground
    /// (`setFreeScene`).
    fn free_scene(&mut self, target: DVec3, eye: DVec3, fov: f64, far: Option<f64>, has_body: bool) {
        self.coverage = true;
        self.depth_bias = if has_body { 0.75 } else { 0.0 };
        self.fov_deg = fov;
        self.orbit.fov_deg = fov;
        let dist = eye.distance(target);
        self.orbit.set_view(eye, target);
        self.near = dist / 200.0;
        self.far = far.unwrap_or(dist * 20.0);
        self.orbit.min_distance = dist * 0.15;
        self.orbit.max_distance = dist * 3.0;
        self.orbit.max_polar = std::f64::consts::PI * 0.495; // don't orbit under the ground
        self.orbit.enabled = true;
        self.orbit.update();
    }

    /// Frame an STL model's bounding sphere (`Viewer.frame`).
    fn frame(&mut self, positions: &[f32]) {
        let (mut lo, mut hi) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
        for v in positions.chunks_exact(3) {
            for a in 0..3 {
                lo[a] = lo[a].min(v[a]);
                hi[a] = hi[a].max(v[a]);
            }
        }
        let c = DVec3::new(f64::from(lo[0] + hi[0]) * 0.5, f64::from(lo[1] + hi[1]) * 0.5, f64::from(lo[2] + hi[2]) * 0.5);
        let mut r2 = 0.0f64;
        for v in positions.chunks_exact(3) {
            r2 = r2.max(c.distance_squared(DVec3::new(f64::from(v[0]), f64::from(v[1]), f64::from(v[2]))));
        }
        let r = r2.sqrt().max(1e-3);
        self.fov_deg = 35.0;
        self.orbit.fov_deg = 35.0;
        let fov = 35.0f64.to_radians();
        let fit = fov.min(2.0 * ((fov / 2.0).tan() * self.aspect()).atan());
        let dist = (r / (fit / 2.0).sin()) * 1.05;
        let dir = DVec3::new(0.55, 0.32, 1.0).normalize();
        self.orbit.set_view(c + dir * dist, c);
        self.near = dist / 100.0;
        self.far = dist * 20.0;
        self.orbit.min_distance = r * 1.08;
        self.orbit.max_distance = dist * 6.0;
        self.orbit.enabled = true;
        self.orbit.update();
    }

    /// Walk through the current landscape (key P). False if there is nothing to walk on.
    pub fn play(&mut self) -> bool {
        if self.player.is_some() || matches!(self.ground, GroundKind::None) {
            return false;
        }
        let cam = self.orbit.position;
        let t = self.orbit.target;
        let yaw = (-(t.x - cam.x)).atan2(-(t.z - cam.z));
        self.player = Some(Player::new(&self.ground, cam.x, cam.z, yaw));
        self.orbit.enabled = false;
        self.near = 0.05;
        true
    }

    /// Back to orbiting, around a point in front of where the player stood.
    pub fn stop_playing(&mut self) {
        let Some(p) = self.player.take() else { return };
        let eye = p.eye();
        let dir = p.forward();
        self.orbit.set_view(eye, eye + dir * 20.0);
        self.orbit.enabled = true;
        self.near = 0.2;
        self.orbit.update();
    }

    fn view_matrix(&self) -> DMat4 {
        match &self.player {
            Some(p) => p.view_matrix(),
            None => self.orbit.view_matrix(),
        }
    }

    /// Per-frame render parameters.
    pub fn frame_params(&self) -> FrameParams {
        let view = self.view_matrix();
        let proj = DMat4::perspective_rh(self.fov_deg.to_radians(), self.aspect(), self.near, self.far);
        let cam = self.camera_position();
        FrameParams {
            view: view.as_mat4().to_cols_array(),
            proj: proj.as_mat4().to_cols_array(),
            camera_pos: [cam.x as f32, cam.y as f32, cam.z as f32],
            fov_y: self.fov_deg.to_radians() as f32,
            viewport: [self.viewport.0, self.viewport.1],
            time: self.time as f32,
            lighting: self.lighting,
            env: self.env,
            background: self.background,
            coverage: self.coverage,
            depth_bias: self.depth_bias,
            alpha_gain: if self.coverage { 1.6 } else { 1.0 },
            underpaint: true,
            underpaint_strength: 0.2,
            underpaint_card_alpha: 0.7,
        }
    }
}

