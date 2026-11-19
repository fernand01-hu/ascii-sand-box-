//! The shell, the same on every platform: a winit window (a canvas on the
//! web), mouse and keyboard mapped onto the core's abstract input, a wgpu
//! surface, and a frame loop. The few differences (GPU start-up is async in a
//! browser, the loop is paced by the display there) are marked `wasm32`.

use crate::{log, Pool};
use ascii_core::input::{Command, Gallery, InputState, Pointer, Preset};
use ascii_core::Session;
use ascii_render::Renderer;
use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;
use web_time::{Duration, Instant};
use winit::application::ApplicationHandler;
#[cfg(not(target_arch = "wasm32"))]
use winit::dpi::LogicalSize;
use winit::event::{DeviceEvent, ElementState, MouseButton, MouseScrollDelta, WindowEvent};
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::keyboard::{Key, KeyCode, NamedKey, PhysicalKey};
use winit::window::{CursorGrabMode, Window, WindowId};

pub struct Options {
    /// What to show at start.
    pub start: Vec<Command>,
    pub world: Option<(u32, bool)>,
    pub perf: bool,
    pub size: (u32, u32),
    /// Seconds a rebuilt world chunk takes to dissolve into the new one.
    pub fade_secs: f32,
    /// `immediate` or `mailbox` instead of vsync (desktop).
    pub present: Option<String>,
    /// The page's canvas (web).
    #[cfg(target_arch = "wasm32")]
    pub canvas: Option<web_sys::HtmlCanvasElement>,
}

type Task = Box<dyn FnOnce(&mut Session<Pool>)>;
/// Gets the captured frame as RGBA8 rows (top first) and its size.
pub type CaptureDone = Box<dyn FnOnce(Result<(Vec<u8>, (u32, u32)), String>)>;

/// What the app is showing, refreshed every frame (test hooks read it).
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub status: Option<ascii_core::session::Status>,
    pub stats: ascii_core::session::Stats,
    pub playing: bool,
    /// Wind, rain, blown leaves (0..1).
    pub weather: [f32; 3],
    /// Background colour (0..1), to tell drawn pixels from empty ones.
    pub background: [f32; 3],
}

thread_local! {
    /// Work from outside the event loop (the web page: dropped files, test
    /// hooks), run on the session at the next frame.
    static TASKS: RefCell<Vec<Task>> = const { RefCell::new(Vec::new()) };
    static CAPTURES: RefCell<Vec<((u32, u32), CaptureDone)>> = const { RefCell::new(Vec::new()) };
    static SNAPSHOT: RefCell<Snapshot> = RefCell::new(Snapshot::default());
}

/// Queue a command for the running app.
pub fn send(c: Command) {
    with_session(move |s| s.command(c));
}

/// Run `f` on the session at the next frame.
pub fn with_session(f: impl FnOnce(&mut Session<Pool>) + 'static) {
    TASKS.with(|q| q.borrow_mut().push(Box::new(f)));
}

/// Render the next frame off-screen at `size` too, and hand it to `done`.
pub fn capture(size: (u32, u32), done: CaptureDone) {
    CAPTURES.with(|q| q.borrow_mut().push((size, done)));
}

pub fn snapshot() -> Snapshot {
    SNAPSHOT.with(|s| s.borrow().clone())
}

struct Gfx {
    window: Arc<Window>,
    surface: wgpu::Surface<'static>,
    config: wgpu::SurfaceConfiguration,
    view_format: wgpu::TextureFormat,
    renderer: Renderer,
    device: wgpu::Device,
    queue: wgpu::Queue,
}

struct Perf {
    enabled: bool,
    since: Instant,
    frames: u32,
    worst: Duration,
    last_frame: Instant,
}

/// The GPU comes up asynchronously in a browser: it lands here.
type GfxSlot = Rc<RefCell<Option<Result<Gfx, String>>>>;

struct App {
    opts: Options,
    pool: Option<Pool>,
    gfx: Option<Gfx>,
    pending_gfx: GfxSlot,
    session: Option<Session<Pool>>,
    started: bool,
    /// Frames being read back.
    reading: Vec<(ascii_render::Capture, CaptureDone)>,
    clock: Instant,
    keys: HashSet<KeyCode>,
    events: Vec<ascii_core::RenderEvent>,
    buttons: (bool, bool),
    cursor: Option<(f64, f64)>,
    grabbed: bool,
    occluded: bool,
    perf: Perf,
    last_draws: ascii_render::RenderStats,
    failed: bool,
    /// The last redraw had nothing new to draw.
    idle: bool,
    force_redraw: bool,
    last_poll: Instant,
}

fn pick_format(caps: &wgpu::SurfaceCapabilities) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
    use wgpu::TextureFormat as F;
    // The shaders write final display values, so use a plain 8-bit non-sRGB view.
    // The first listed is the one the platform prefers (no extra copy in a browser).
    let surface_format = caps
        .formats
        .iter()
        .copied()
        .find(|f| matches!(f, F::Bgra8Unorm | F::Rgba8Unorm))
        .or_else(|| caps.formats.iter().copied().find(|f| matches!(f, F::Bgra8UnormSrgb | F::Rgba8UnormSrgb)))
        .unwrap_or(caps.formats[0]);
    (surface_format, surface_format.remove_srgb_suffix())
}

async fn create_gfx(window: Arc<Window>, present: Option<String>) -> Result<Gfx, String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
    let surface = instance.create_surface(window.clone()).map_err(|e| e.to_string())?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), force_fallback_adapter: false })
        .await
        .map_err(|e| format!("no GPU adapter (this needs WebGPU in a browser): {e}"))?;
    let limits = adapter.limits();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("ascii"),
            required_limits: wgpu::Limits {
                max_buffer_size: limits.max_buffer_size.min(1 << 30),
                // Card sets are bound whole as storage buffers (per-card evaluation).
                max_storage_buffer_binding_size: limits.max_storage_buffer_binding_size.min(1 << 30),
                ..wgpu::Limits::default()
            },
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    device.set_device_lost_callback(|reason, msg| log!("[ascii] GPU device lost ({reason:?}): {msg}"));
    #[cfg(target_arch = "wasm32")]
    device.on_uncaptured_error(Arc::new(|e| log!("[ascii] GPU error: {e}")));
    let caps = surface.get_capabilities(&adapter);
    let (surface_format, view_format) = pick_format(&caps);
    let size = window.inner_size();
    let present_mode = match present.as_deref() {
        Some("immediate") if caps.present_modes.contains(&wgpu::PresentMode::Immediate) => wgpu::PresentMode::Immediate,
        Some("mailbox") if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) => wgpu::PresentMode::Mailbox,
        _ => wgpu::PresentMode::Fifo, // vsync
    };
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format: surface_format,
        width: size.width.max(1),
        height: size.height.max(1),
        present_mode,
        desired_maximum_frame_latency: 2,
        // Glyph cards write alpha < 1: the window must stay opaque.
        alpha_mode: if caps.alpha_modes.contains(&wgpu::CompositeAlphaMode::Opaque) { wgpu::CompositeAlphaMode::Opaque } else { caps.alpha_modes[0] },
        view_formats: if view_format == surface_format { vec![] } else { vec![view_format] },
    };
    surface.configure(&device, &config);
    log!("[ascii] {} ({:?}), {:?}", adapter.get_info().name, adapter.get_info().backend, config.present_mode);
    let renderer = Renderer::new(device.clone(), queue.clone(), view_format);
    Ok(Gfx { window, surface, config, view_format, renderer, device, queue })
}

impl App {
    /// Open the window and start bringing up the GPU.
    fn init(&mut self, el: &ActiveEventLoop) -> Result<(), String> {
        let attrs = Window::default_attributes().with_title("ASCII Scene");
        // Desktop: a window of the asked size. Web: the page's canvas, sized by its CSS.
        #[cfg(not(target_arch = "wasm32"))]
        let attrs = attrs.with_inner_size(LogicalSize::new(self.opts.size.0, self.opts.size.1));
        #[cfg(target_arch = "wasm32")]
        let attrs = {
            use winit::platform::web::WindowAttributesExtWebSys;
            attrs.with_canvas(self.opts.canvas.take()).with_focusable(true).with_prevent_default(true)
        };
        let window = Arc::new(el.create_window(attrs).map_err(|e| e.to_string())?);
        let fut = create_gfx(window, self.opts.present.take());
        #[cfg(not(target_arch = "wasm32"))]
        {
            *self.pending_gfx.borrow_mut() = Some(pollster::block_on(fut));
        }
        #[cfg(target_arch = "wasm32")]
        {
            let slot = self.pending_gfx.clone();
            wasm_bindgen_futures::spawn_local(async move {
                let r = fut.await;
                if let Ok(g) = &r {
                    g.window.request_redraw();
                }
                *slot.borrow_mut() = Some(r);
            });
        }
        Ok(())
    }

    /// The GPU is up: start the session.
    fn take_gfx(&mut self) -> Result<(), String> {
        let Some(r) = self.pending_gfx.borrow_mut().take() else { return Ok(()) };
        let mut g = r?;
        // Streamed chunks dissolve into their rebuilt version instead of popping.
        g.renderer.fade_secs = self.opts.fade_secs;
        let pool = self.pool.take().ok_or("started twice")?;
        let mut session = Session::new(pool, (g.config.width, g.config.height));
        for c in self.opts.start.drain(..) {
            session.command(c);
        }
        if let Some((seed, day)) = self.opts.world {
            session.show_world(seed, day);
        }
        if !self.perf.enabled {
            log!("[ascii] F3 toggles the perf log");
        }
        self.session = Some(session);
        self.gfx = Some(g);
        self.force_redraw = true;
        Ok(())
    }

    fn input_state(&self) -> InputState {
        let k = |a: KeyCode, b: KeyCode| self.keys.contains(&a) || self.keys.contains(&b);
        let axis = |pos: bool, neg: bool| f64::from(i32::from(pos) - i32::from(neg));
        InputState {
            forward: axis(k(KeyCode::KeyW, KeyCode::ArrowUp), k(KeyCode::KeyS, KeyCode::ArrowDown)),
            right: axis(k(KeyCode::KeyD, KeyCode::ArrowRight), k(KeyCode::KeyA, KeyCode::ArrowLeft)),
            run: k(KeyCode::ShiftLeft, KeyCode::ShiftRight),
            jump: self.keys.contains(&KeyCode::Space),
        }
    }

    fn grab(&mut self, on: bool) {
        let Some(g) = &self.gfx else { return };
        if on {
            let ok = g.window.set_cursor_grab(CursorGrabMode::Locked).or_else(|_| g.window.set_cursor_grab(CursorGrabMode::Confined)).is_ok();
            g.window.set_cursor_visible(!ok);
            self.grabbed = ok;
        } else {
            let _ = g.window.set_cursor_grab(CursorGrabMode::None);
            g.window.set_cursor_visible(true);
            self.grabbed = false;
        }
    }

    fn command_for(&self, key: &Key) -> Option<Command> {
        let Key::Character(c) = key else { return None };
        let playing = self.session.as_ref().is_some_and(Session::playing);
        let c = c.to_lowercase();
        if c == "p" {
            return Some(Command::TogglePlay);
        }
        if playing {
            return None; // WASD etc. belong to the player
        }
        let g = |g| Some(Command::Gallery(g));
        let s = |p| Some(Command::Scene(p));
        match c.as_str() {
            "1" | "2" | "3" | "4" => {
                let i = c.parse::<usize>().ok()? - 1;
                let (name, bytes) = crate::models::MODELS[i];
                Some(Command::LoadStl { bytes: bytes.to_vec(), name: name.to_string() })
            }
            "6" => g(Gallery::Rocks),
            "7" => g(Gallery::Plants),
            "8" => g(Gallery::Bushes),
            "9" => g(Gallery::Trees),
            "m" => s(Preset::Meadow),
            "f" => s(Preset::Forest),
            "l" => s(Preset::Lake),
            "v" => s(Preset::Valley),
            "a" => s(Preset::Alpine),
            "i" => Some(Command::World),
            "w" => Some(Command::CycleWind),
            "r" => Some(Command::ToggleRain),
            "b" => Some(Command::ToggleLeaves),
            _ => None,
        }
    }

    fn redraw(&mut self, el: &ActiveEventLoop) {
        if self.gfx.is_none() {
            if let Err(e) = self.take_gfx() {
                self.fail(el, &e);
                return;
            }
        }
        let input = self.input_state();
        let (Some(g), Some(session)) = (self.gfx.as_mut(), self.session.as_mut()) else { return };
        let tasks = TASKS.with(|q| std::mem::take(&mut *q.borrow_mut()));
        for t in tasks {
            t(session);
        }
        let mut i = 0;
        while i < self.reading.len() {
            if let Some(r) = self.reading[i].0.try_take(&g.device) {
                let (c, done) = self.reading.swap_remove(i);
                let size = c.size();
                done(r.map(|px| (px, size)));
            } else {
                i += 1;
            }
        }
        let now = self.clock.elapsed().as_secs_f64();
        session.update(now, &input);
        SNAPSHOT.with(|snap| {
            let env = session.environment();
            *snap.borrow_mut() = Snapshot { status: Some(session.status().clone()), stats: session.stats(), playing: session.playing(), weather: [env.wind, env.rain, env.leaves], background: session.frame_params().background };
        });
        if !session.playing() && self.grabbed {
            // Walking ended (P): give the mouse back.
            let _ = g.window.set_cursor_grab(CursorGrabMode::None);
            g.window.set_cursor_visible(true);
            self.grabbed = false;
        }
        let changed = session.take_dirty();
        let capturing = CAPTURES.with(|q| !q.borrow().is_empty());
        self.idle = !changed && !self.force_redraw && !capturing;
        if self.idle {
            return;
        }
        self.force_redraw = false;
        session.drain_events(&mut self.events);
        g.renderer.set_clock(self.clock.elapsed().as_secs_f64());
        g.renderer.apply_events(&mut self.events);
        let params = session.frame_params();
        for (size, done) in CAPTURES.with(|q| std::mem::take(&mut *q.borrow_mut())) {
            self.reading.push((g.renderer.capture(size, &params), done));
        }
        let frame = match g.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                g.surface.configure(&g.device, &g.config);
                self.force_redraw = true;
                return;
            }
            Err(wgpu::SurfaceError::Timeout) => return,
            Err(e) => {
                self.fail(el, &format!("surface error: {e}"));
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(g.view_format), ..Default::default() });
        let mut enc = g.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        self.last_draws = g.renderer.render(&mut enc, &view, (g.config.width, g.config.height), &params);
        g.queue.submit([enc.finish()]);
        self.force_redraw |= g.renderer.fading();
        g.window.pre_present_notify();
        frame.present();

        // Performance journal.
        let p = &mut self.perf;
        let t = Instant::now();
        p.worst = p.worst.max(t - p.last_frame);
        p.last_frame = t;
        p.frames += 1;
        if t - p.since >= Duration::from_secs(1) {
            let secs = (t - p.since).as_secs_f64();
            let fps = f64::from(p.frames) / secs;
            let s = session.stats();
            g.window.set_title(&format!("ASCII Scene - {fps:.0} fps"));
            if p.enabled {
                log!(
                    "[perf] {fps:.1} fps, worst frame {:.1} ms | cards {} drawn {} in {} calls | chunks {} (+{} pending, {} built), build mean {:.0} ms max {:.0} ms",
                    p.worst.as_secs_f64() * 1000.0,
                    s.cards,
                    self.last_draws.instances,
                    self.last_draws.draw_calls,
                    s.chunks_loaded,
                    s.chunks_pending,
                    s.chunks_built,
                    s.chunk_ms_mean,
                    s.chunk_ms_max,
                );
            }
            p.since = t;
            p.frames = 0;
            p.worst = Duration::ZERO;
        }
    }
}

impl App {
    fn fail(&mut self, el: &ActiveEventLoop, e: &str) {
        log!("error: {e}");
        #[cfg(target_arch = "wasm32")]
        crate::web::show_error(e);
        self.failed = true;
        el.exit();
    }
}

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.gfx.is_none() && self.pool.is_some() && !self.started {
            self.started = true;
            if let Err(e) = self.init(el) {
                self.fail(el, &e);
            }
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Occluded(o) => {
                self.occluded = o;
                self.force_redraw = true;
            }
            WindowEvent::Resized(size) => {
                if let (Some(g), Some(s)) = (self.gfx.as_mut(), self.session.as_mut()) {
                    g.config.width = size.width.max(1);
                    g.config.height = size.height.max(1);
                    g.surface.configure(&g.device, &g.config);
                    s.resize(g.config.width, g.config.height);
                    self.force_redraw = true;
                }
            }
            WindowEvent::Focused(false) => self.keys.clear(),
            WindowEvent::KeyboardInput { event, .. } => {
                if let PhysicalKey::Code(code) = event.physical_key {
                    match event.state {
                        ElementState::Pressed => {
                            self.keys.insert(code);
                        }
                        ElementState::Released => {
                            self.keys.remove(&code);
                        }
                    }
                }
                if event.state == ElementState::Pressed && !event.repeat {
                    if event.logical_key == Key::Named(NamedKey::Escape) {
                        self.grab(false);
                    } else if event.logical_key == Key::Named(NamedKey::F3) {
                        self.perf.enabled = !self.perf.enabled;
                    } else if let Some(cmd) = self.command_for(&event.logical_key) {
                        let toggling_play = matches!(cmd, Command::TogglePlay);
                        if let Some(s) = self.session.as_mut() {
                            s.command(cmd);
                            if toggling_play {
                                let on = s.playing();
                                self.grab(on);
                            }
                        }
                    }
                }
            }
            WindowEvent::MouseInput { state, button, .. } => {
                let down = state == ElementState::Pressed;
                match button {
                    MouseButton::Left => {
                        self.buttons.0 = down;
                        if down && self.session.as_ref().is_some_and(Session::playing) && !self.grabbed {
                            self.grab(true);
                        }
                    }
                    MouseButton::Right => self.buttons.1 = down,
                    _ => {}
                }
            }
            WindowEvent::CursorMoved { position, .. } => {
                if let (Some((px, py)), Some(s)) = (self.cursor, self.session.as_mut()) {
                    let (dx, dy) = (position.x - px, position.y - py);
                    if self.buttons.0 {
                        s.pointer(Pointer::Rotate { dx, dy });
                    } else if self.buttons.1 {
                        s.pointer(Pointer::Pan { dx, dy });
                    }
                }
                self.cursor = Some((position.x, position.y));
            }
            WindowEvent::MouseWheel { delta, .. } => {
                if let Some(s) = self.session.as_mut() {
                    // Browser-style pixels: one wheel notch is 100.
                    let d = match delta {
                        MouseScrollDelta::LineDelta(_, y) => -f64::from(y) * 100.0,
                        // Physical pixels -> CSS-like pixels (the browser's deltaY).
                        MouseScrollDelta::PixelDelta(p) => -p.y / self.gfx.as_ref().map_or(1.0, |g| g.window.scale_factor()),
                    };
                    s.pointer(Pointer::Zoom(d));
                }
            }
            // On the web the page reads dropped files and `send`s them.
            WindowEvent::DroppedFile(path) => match std::fs::read(&path) {
                Ok(bytes) => {
                    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                    send(Command::LoadStl { bytes, name });
                }
                Err(e) => log!("[ascii] could not read {}: {e}", path.display()),
            },
            WindowEvent::RedrawRequested => {
                if !self.occluded {
                    self.redraw(el);
                }
            }
            _ => {}
        }
    }

    fn device_event(&mut self, _el: &ActiveEventLoop, _id: winit::event::DeviceId, event: DeviceEvent) {
        if let DeviceEvent::MouseMotion { delta } = event {
            if self.grabbed {
                if let Some(s) = self.session.as_mut() {
                    s.pointer(Pointer::Look { dx: delta.0, dy: delta.1 });
                }
            }
        }
    }

    fn about_to_wait(&mut self, el: &ActiveEventLoop) {
        if self.gfx.is_none() {
            // Waiting for the GPU (web): look again shortly.
            if self.pending_gfx.borrow().is_some() {
                self.force_redraw = true;
                if let Err(e) = self.take_gfx() {
                    self.fail(el, &e);
                    return;
                }
            }
            el.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(16)));
            return;
        }
        if self.occluded {
            // Hidden: wake up rarely instead of spinning.
            el.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250)));
        } else if self.idle {
            // Nothing moving: look for finished jobs and input at 60 Hz without drawing.
            let next = self.last_poll + Duration::from_millis(16);
            if Instant::now() >= next {
                self.last_poll = Instant::now();
                if let Some(g) = &self.gfx {
                    g.window.request_redraw();
                }
            }
            el.set_control_flow(ControlFlow::WaitUntil(self.last_poll + Duration::from_millis(16)));
        } else {
            // Drawing: presenting with vsync paces the loop on desktop; in a
            // browser, redraws follow the display (requestAnimationFrame).
            el.set_control_flow(if cfg!(target_arch = "wasm32") { ControlFlow::Wait } else { ControlFlow::Poll });
            if let Some(g) = &self.gfx {
                g.window.request_redraw();
            }
        }
    }
}

/// Run the app. Returns when the window closes (desktop); in a browser it
/// returns at once and the page keeps running it.
pub fn run(opts: Options, pool: Pool) -> Result<(), String> {
    let el = EventLoop::new().map_err(|e| e.to_string())?;
    let perf_on = opts.perf;
    #[allow(unused_mut)]
    let mut app = App {
        opts,
        pool: Some(pool),
        gfx: None,
        pending_gfx: Rc::new(RefCell::new(None)),
        session: None,
        started: false,
        reading: Vec::new(),
        clock: Instant::now(),
        keys: HashSet::new(),
        events: Vec::new(),
        buttons: (false, false),
        cursor: None,
        grabbed: false,
        occluded: false,
        perf: Perf { enabled: perf_on, since: Instant::now(), frames: 0, worst: Duration::ZERO, last_frame: Instant::now() },
        last_draws: Default::default(),
        failed: false,
        idle: false,
        force_redraw: true,
        last_poll: Instant::now(),
    };
    #[cfg(target_arch = "wasm32")]
    {
        use winit::platform::web::EventLoopExtWebSys;
        el.spawn_app(app);
        Ok(())
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        el.run_app(&mut app).map_err(|e| e.to_string())?;
        if app.failed { Err("could not start".into()) } else { Ok(()) }
    }
}
