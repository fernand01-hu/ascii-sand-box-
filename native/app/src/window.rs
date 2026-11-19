//! The desktop shell: a winit window, mouse and keyboard mapped onto the
//! core's abstract input, a wgpu surface, and a frame loop. Everything
//! platform-specific the app needs lives here (and in `pool.rs`).

use crate::pool::{default_workers, ThreadPool};
use ascii_core::input::{Command, Gallery, InputState, Pointer, Preset};
use ascii_core::Session;
use ascii_render::Renderer;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use winit::application::ApplicationHandler;
use winit::dpi::PhysicalSize;
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

struct App {
    opts: Options,
    gfx: Option<Gfx>,
    session: Option<Session<ThreadPool>>,
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
}

fn pick_format(caps: &wgpu::SurfaceCapabilities) -> (wgpu::TextureFormat, wgpu::TextureFormat) {
    // The shaders write final display values, so use a non-sRGB view.
    let surface_format = caps.formats.iter().copied().find(|f| !f.is_srgb()).unwrap_or(caps.formats[0]);
    (surface_format, surface_format.remove_srgb_suffix())
}

impl App {
    fn init(&mut self, el: &ActiveEventLoop) -> Result<(), String> {
        let attrs = Window::default_attributes().with_title("ASCII Scene").with_inner_size(PhysicalSize::new(self.opts.size.0, self.opts.size.1));
        let window = Arc::new(el.create_window(attrs).map_err(|e| e.to_string())?);
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let surface = instance.create_surface(window.clone()).map_err(|e| e.to_string())?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions { power_preference: wgpu::PowerPreference::HighPerformance, compatible_surface: Some(&surface), force_fallback_adapter: false }))
            .map_err(|e| format!("no GPU adapter: {e}"))?;
        let limits = adapter.limits();
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("ascii"),
            required_limits: wgpu::Limits { max_buffer_size: limits.max_buffer_size.min(1 << 30), ..wgpu::Limits::default() },
            ..Default::default()
        }))
        .map_err(|e| e.to_string())?;
        let caps = surface.get_capabilities(&adapter);
        let (surface_format, view_format) = pick_format(&caps);
        let size = window.inner_size();
        let present_mode = match std::env::var("ASCII_PRESENT").as_deref() {
            Ok("immediate") if caps.present_modes.contains(&wgpu::PresentMode::Immediate) => wgpu::PresentMode::Immediate,
            Ok("mailbox") if caps.present_modes.contains(&wgpu::PresentMode::Mailbox) => wgpu::PresentMode::Mailbox,
            _ => wgpu::PresentMode::Fifo, // vsync
        };
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format: surface_format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode,
            desired_maximum_frame_latency: 2,
            alpha_mode: caps.alpha_modes[0],
            view_formats: if view_format == surface_format { vec![] } else { vec![view_format] },
        };
        surface.configure(&device, &config);
        eprintln!("[ascii] {} ({:?}), {:?}, {}", adapter.get_info().name, adapter.get_info().backend, config.present_mode, if self.perf.enabled { "perf log on" } else { "F3 toggles the perf log" });
        let renderer = Renderer::new(device.clone(), queue.clone(), view_format);
        let mut session = Session::new(ThreadPool::new(default_workers()), (config.width, config.height));
        for c in self.opts.start.drain(..) {
            session.command(c);
        }
        if let Some((seed, day)) = self.opts.world {
            session.show_world(seed, day);
        }
        self.session = Some(session);
        self.gfx = Some(Gfx { window, surface, config, view_format, renderer, device, queue });
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
        let input = self.input_state();
        let (Some(g), Some(session)) = (self.gfx.as_mut(), self.session.as_mut()) else { return };
        let now = self.clock.elapsed().as_secs_f64();
        session.update(now, &input);
        if !session.playing() && self.grabbed {
            // Walking ended (P): give the mouse back.
            let _ = g.window.set_cursor_grab(CursorGrabMode::None);
            g.window.set_cursor_visible(true);
            self.grabbed = false;
        }
        session.drain_events(&mut self.events);
        g.renderer.apply_events(&mut self.events);
        let params = session.frame_params();
        let frame = match g.surface.get_current_texture() {
            Ok(f) => f,
            Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                g.surface.configure(&g.device, &g.config);
                return;
            }
            Err(wgpu::SurfaceError::Timeout) => return,
            Err(e) => {
                eprintln!("[ascii] surface error: {e}");
                el.exit();
                return;
            }
        };
        let view = frame.texture.create_view(&wgpu::TextureViewDescriptor { format: Some(g.view_format), ..Default::default() });
        let mut enc = g.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
        self.last_draws = g.renderer.render(&mut enc, &view, (g.config.width, g.config.height), &params);
        g.queue.submit([enc.finish()]);
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
                eprintln!(
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

impl ApplicationHandler for App {
    fn resumed(&mut self, el: &ActiveEventLoop) {
        if self.gfx.is_none() {
            if let Err(e) = self.init(el) {
                eprintln!("error: {e}");
                self.failed = true;
                el.exit();
            }
        }
    }

    fn window_event(&mut self, el: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => el.exit(),
            WindowEvent::Occluded(o) => self.occluded = o,
            WindowEvent::Resized(size) => {
                if let (Some(g), Some(s)) = (self.gfx.as_mut(), self.session.as_mut()) {
                    g.config.width = size.width.max(1);
                    g.config.height = size.height.max(1);
                    g.surface.configure(&g.device, &g.config);
                    s.resize(g.config.width, g.config.height);
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
                        MouseScrollDelta::PixelDelta(p) => -p.y,
                    };
                    s.pointer(Pointer::Zoom(d));
                }
            }
            WindowEvent::DroppedFile(path) => match std::fs::read(&path) {
                Ok(bytes) => {
                    let name = path.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                    if let Some(s) = self.session.as_mut() {
                        s.command(Command::LoadStl { bytes, name });
                    }
                }
                Err(e) => eprintln!("[ascii] could not read {}: {e}", path.display()),
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
        if self.occluded {
            // Hidden: wake up rarely instead of spinning.
            el.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(250)));
        } else {
            el.set_control_flow(ControlFlow::Poll);
            if let Some(g) = &self.gfx {
                g.window.request_redraw();
            }
        }
    }
}

pub fn run(opts: Options) -> Result<(), String> {
    let el = EventLoop::new().map_err(|e| e.to_string())?;
    let perf_on = opts.perf;
    let mut app = App {
        opts,
        gfx: None,
        session: None,
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
    };
    el.run_app(&mut app).map_err(|e| e.to_string())?;
    if app.failed { Err("could not start".into()) } else { Ok(()) }
}
