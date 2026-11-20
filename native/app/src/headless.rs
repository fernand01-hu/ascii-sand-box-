//! Off-screen tools: `shot` (render one frame to a PNG), `golden` (compare
//! against the webapp's reference thumbnails), `bench` (generation and render
//! timings). They use the same core and renderer as the window, with a real
//! GPU or a software Vulkan driver (`WGPU_BACKEND=vulkan`).

use crate::pool::{default_workers, ThreadPool};
use ascii_core::input::{Command, Gallery, InputState, Preset};
use ascii_core::session::Status;
use ascii_core::Session;
use ascii_render::headless::{content_diff, open_gpu, read_golden, thumbnail, Gpu, Headless};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub enum SourceKind {
    Model(usize),
    Stl(std::path::PathBuf),
    Scene(Preset),
    Gallery(Gallery),
    World { seed: u32, day: bool },
}

pub struct Shot {
    pub commands: Vec<Command>,
    pub size: (u32, u32),
    pub time: Option<f64>,
    pub walk_seconds: f64,
    /// Wheel movement before the shot, browser pixels (positive: zoom out).
    pub zoom: f64,
}

fn start(session: &mut Session<ThreadPool>, src: &SourceKind) -> Result<(), String> {
    match src {
        SourceKind::Model(i) => {
            let (name, bytes) = crate::models::MODELS.get(*i).ok_or("model index 0..3")?;
            session.command(Command::LoadStl { bytes: bytes.to_vec(), name: (*name).to_string() });
        }
        SourceKind::Stl(p) => {
            let bytes = std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?;
            session.command(Command::LoadStl { bytes, name: p.file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned()) });
        }
        SourceKind::Scene(p) => session.show_scene(*p, 1),
        SourceKind::Gallery(g) => session.show_gallery(*g, 1),
        SourceKind::World { seed, day } => session.show_world(*seed, *day),
    }
    Ok(())
}

/// Chunks of the full view disc (radius 9), as the streamer counts them.
fn disc_chunks() -> usize {
    let r = 9i32;
    (-r..=r).flat_map(|z| (-r..=r).map(move |x| (x, z))).filter(|(x, z)| x * x + z * z <= r * r + 1).count()
}

pub struct Run {
    pub session: Session<ThreadPool>,
    pub clock: Instant,
}

impl Run {
    pub fn new(size: (u32, u32), workers: usize) -> Self {
        Run { session: Session::new(ThreadPool::new(workers), size), clock: Instant::now() }
    }

    pub fn now(&self) -> f64 {
        self.clock.elapsed().as_secs_f64()
    }

    /// Pump the session until the scene is loaded (and, for the world, streamed in).
    pub fn wait_ready(&mut self, src: &SourceKind, timeout: Duration) -> Result<(), String> {
        let t0 = Instant::now();
        let input = InputState::default();
        loop {
            let now = self.now();
            self.session.update(now, &input);
            match self.session.status() {
                Status::Error(e) => return Err(e.clone()),
                Status::Ready => {
                    if !matches!(src, SourceKind::World { .. }) {
                        return Ok(());
                    }
                    let s = self.session.stats();
                    if s.chunks_pending == 0 && s.chunks_loaded >= disc_chunks() {
                        return Ok(());
                    }
                }
                Status::Loading => {}
            }
            if t0.elapsed() > timeout {
                return Err(format!("timed out after {timeout:?}: {:?}", self.session.stats()));
            }
            std::thread::sleep(Duration::from_millis(4));
        }
    }
}

pub fn write_png(path: &std::path::Path, rgba: &[u8], size: (u32, u32)) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), size.0, size.1);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut w = enc.write_header().map_err(|e| e.to_string())?;
    w.write_image_data(rgba).map_err(|e| e.to_string())
}

/// Render `src` once and return the RGBA image.
pub fn render_one(gpu: &Gpu, src: &SourceKind, shot: &Shot) -> Result<(Vec<u8>, Run, ascii_render::RenderStats), String> {
    let mut run = Run::new(shot.size, default_workers());
    if let Some(t) = shot.time {
        run.session.command(Command::FreezeTime(Some(t)));
    }
    start(&mut run.session, src)?;
    run.wait_ready(src, Duration::from_secs(600))?;
    for c in &shot.commands {
        run.session.command(c.clone());
    }
    if shot.zoom != 0.0 {
        let mut t = run.now();
        for _ in 0..20 {
            run.session.pointer(ascii_core::input::Pointer::Zoom(shot.zoom / 20.0));
            for _ in 0..30 {
                t += 1.0 / 60.0;
                run.session.update(t, &InputState::default());
            }
        }
        run.wait_ready(src, Duration::from_secs(600))?;
    }
    if shot.walk_seconds > 0.0 {
        run.session.command(Command::TogglePlay);
        let walk = InputState { forward: 1.0, ..Default::default() };
        let mut t = run.now();
        let end = t + shot.walk_seconds;
        while t < end {
            t += 1.0 / 60.0;
            run.session.update(t, &walk);
        }
    }
    let mut head = Headless::new(gpu, shot.size);
    let mut events = Vec::new();
    run.session.drain_events(&mut events);
    head.renderer.apply_events(&mut events);
    let params = run.session.frame_params();
    let (rgba, stats) = head.render_rgba(&params);
    Ok((rgba, run, stats))
}

fn parse_size(s: &str) -> Result<(u32, u32), String> {
    let (w, h) = s.split_once('x').ok_or("size is WxH")?;
    Ok((w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?))
}

/// `shot`: argv after the subcommand.
pub fn shot_cmd(args: &[String]) -> Result<(), String> {
    let (mut src, mut out) = (None, std::path::PathBuf::from("shot.png"));
    let mut shot = Shot { commands: Vec::new(), size: (1000, 800), time: None, walk_seconds: 0.0, zoom: 0.0 };
    let mut it = args.iter();
    let mut seed = 1u32;
    let mut day = false;
    let mut world = false;
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--out" => out = val()?.into(),
            "--size" => shot.size = parse_size(&val()?)?,
            "--time" => shot.time = Some(val()?.parse().map_err(|_| "bad time")?),
            "--model" => src = Some(SourceKind::Model(val()?.parse().map_err(|_| "model 0..3")?)),
            "--stl" => src = Some(SourceKind::Stl(val()?.into())),
            "--scene" => src = Some(SourceKind::Scene(crate::args::preset(&val()?)?)),
            "--gallery" => src = Some(SourceKind::Gallery(crate::args::gallery(&val()?)?)),
            "--world" => world = true,
            "--seed" => seed = val()?.parse().map_err(|_| "bad seed")?,
            "--day" => day = true,
            "--wind" => shot.commands.push(Command::CycleWind),
            "--storm" => {
                shot.commands.extend([Command::CycleWind, Command::CycleWind]);
            }
            "--rain" => shot.commands.push(Command::ToggleRain),
            "--leaves" => shot.commands.push(Command::ToggleLeaves),
            "--walk" => shot.walk_seconds = val()?.parse().map_err(|_| "bad seconds")?,
            "--zoom" => shot.zoom = val()?.parse().map_err(|_| "bad zoom")?,
            other => return Err(format!("unknown option {other}")),
        }
    }
    if world {
        src = Some(SourceKind::World { seed, day });
    }
    let src = src.ok_or("shot needs --model/--stl/--scene/--gallery/--world")?;
    let gpu = open_gpu()?;
    eprintln!("adapter: {} ({:?})", gpu.adapter_info.name, gpu.adapter_info.backend);
    let t0 = Instant::now();
    let (rgba, run, stats) = render_one(&gpu, &src, &shot)?;
    write_png(&out, &rgba, shot.size)?;
    let s = run.session.stats();
    eprintln!("wrote {} in {:.1}s: {} cards, {} instances drawn in {} draw calls, {} chunks", out.display(), t0.elapsed().as_secs_f64(), s.cards, stats.instances, stats.draw_calls, s.chunks_loaded);
    Ok(())
}

/// Golden reference entries: (file name, source, frozen time).
fn goldens() -> Vec<(&'static str, SourceKind, Option<f64>)> {
    use Gallery::*;
    use Preset::*;
    vec![
        ("1-torus-knot", SourceKind::Model(0), None),
        ("2-sphere", SourceKind::Model(1), None),
        ("3-ziggurat", SourceKind::Model(2), None),
        ("4-pine", SourceKind::Model(3), None),
        ("6-gallery-rocks", SourceKind::Gallery(Rocks), None),
        ("7-gallery-plants", SourceKind::Gallery(Plants), None),
        ("8-gallery-bushes", SourceKind::Gallery(Bushes), None),
        ("9-gallery-trees", SourceKind::Gallery(Trees), None),
        ("13-scene-meadow", SourceKind::Scene(Meadow), Some(3.0)),
        ("14-scene-lake", SourceKind::Scene(Lake), Some(3.0)),
        ("15-scene-valley", SourceKind::Scene(Valley), Some(3.0)),
    ]
}

/// `golden DIR [OUTDIR] [only] [--update]`: render each reference scene and
/// compare, or (`--update`) write the references from this renderer.
pub fn golden_cmd(args: &[String]) -> Result<(), String> {
    let update = args.iter().any(|a| a == "--update");
    let args: Vec<String> = args.iter().filter(|a| *a != "--update").cloned().collect();
    let dir = std::path::PathBuf::from(args.first().ok_or("golden needs the tests/golden directory")?);
    let out = std::path::PathBuf::from(args.get(1).map_or("golden-out", String::as_str));
    let only = args.get(2);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let gpu = open_gpu()?;
    eprintln!("adapter: {} ({:?})", gpu.adapter_info.name, gpu.adapter_info.backend);
    let size = (1000, 800);
    let mut worst = 0.0f64;
    for (name, src, time) in goldens() {
        if only.is_some_and(|o| !name.contains(o.as_str())) {
            continue;
        }
        let shot = Shot { commands: Vec::new(), size, time, walk_seconds: 0.0, zoom: 0.0 };
        let (rgba, _run, _stats) = render_one(&gpu, &src, &shot)?;
        write_png(&out.join(format!("{name}.png")), &rgba, size)?;
        let top_first = thumbnail(&rgba, size, 48, 36);
        // The webapp's thumbnails start at the bottom row (readPixels order).
        let mut thumb = Vec::with_capacity(top_first.len());
        for row in (0..36).rev() {
            thumb.extend_from_slice(&top_first[row * 48 * 3..(row + 1) * 48 * 3]);
        }
        if update {
            let data: Vec<String> = thumb.iter().map(|v| format!("{v}")).collect();
            std::fs::write(dir.join(format!("{name}.json")), format!("{{\"w\":48,\"h\":36,\"data\":[{}]}}\n", data.join(","))).map_err(|e| e.to_string())?;
            println!("{name}: reference written");
            continue;
        }
        let reference = read_golden(&dir.join(format!("{name}.json")))?;
        let d = content_diff(&thumb, &reference);
        worst = worst.max(d);
        println!("{name}: diff {d:.2} vs reference");
    }
    println!("worst diff {worst:.2}");
    Ok(())
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(f64::total_cmp);
    v[((v.len() - 1) as f64 * p).round() as usize]
}

/// `bench [workers]`: generation timings (single thread and the pool) and the
/// CPU cost of a world frame. Run it on the Mac for the numbers that matter;
/// the GPU figure on a software driver means nothing.
pub fn bench_cmd(args: &[String]) -> Result<(), String> {
    use ascii_engine as eng;
    let workers = args.iter().find_map(|a| a.parse().ok()).unwrap_or_else(default_workers);
    let aspect = ascii_core::glyphs::glyph_aspect(ascii_core::glyphs::GLYPH_HEIGHT);
    // `--stream`: only the streaming part, from a cold process (no asset built yet).
    let stream_only = args.iter().any(|a| a == "--stream");
    if !stream_only {
    println!("== engine, one thread ==");
    let t = Instant::now();
    let mut world = eng::InfiniteWorld::new(1, false);
    println!("world setup {:.1} ms; sky {:.0} ms", t.elapsed().as_secs_f64() * 1e3, {
        let t = Instant::now();
        let n = world.sky_cards(aspect).len() / 16;
        println!("sky cards {n}");
        t.elapsed().as_secs_f64() * 1e3
    });
    let eye = [16.0, 8.0, 16.0];
    let (mut ms, mut cards) = (Vec::new(), Vec::new());
    for cz in -4..4 {
        for cx in -4..4 {
            let t = Instant::now();
            let c = world.build_chunk(cx, cz, eye, aspect);
            ms.push(t.elapsed().as_secs_f64() * 1e3);
            cards.push((c.cards.len() / 16) as f64);
        }
    }
    println!("64 chunks (eye at the centre): mean {:.0} ms, p50 {:.0}, p95 {:.0}, max {:.0}; cards/chunk mean {:.0}", ms.iter().sum::<f64>() / 64.0, percentile(&mut ms.clone(), 0.5), percentile(&mut ms.clone(), 0.95), percentile(&mut ms, 1.0), cards.iter().sum::<f64>() / 64.0);
    for p in [Preset::Meadow, Preset::Lake, Preset::Valley] {
        let t = Instant::now();
        let s = eng::build_scene(p.name(), 1, aspect)?;
        println!("scene {}: {} cards in {:.0} ms", p.name(), s.cards.len() / 16, t.elapsed().as_secs_f64() * 1e3);
    }

    }
    println!("== world streaming, {workers} worker thread(s) ==");
    let mut run = Run::new((1000, 800), workers);
    let src = SourceKind::World { seed: 1, day: false };
    let t = Instant::now();
    run.session.show_world(1, false);
    run.wait_ready(&src, Duration::from_secs(900))?;
    let s = run.session.stats();
    println!("view disc ({} chunks) streamed in {:.1} s; chunk build mean {:.0} ms, max {:.0} ms on the workers", s.chunks_loaded, t.elapsed().as_secs_f64(), s.chunk_ms_mean, s.chunk_ms_max);
    if stream_only {
        return Ok(());
    }

    println!("== frame cost (world, {} cards) ==", s.cards);
    let gpu = open_gpu()?;
    println!("adapter: {} ({:?})", gpu.adapter_info.name, gpu.adapter_info.backend);
    let mut head = Headless::new(&gpu, (1000, 800));
    let mut events = Vec::new();
    run.session.drain_events(&mut events);
    let t = Instant::now();
    head.renderer.apply_events(&mut events);
    println!("uploading every chunk to the GPU: {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
    let params = run.session.frame_params();
    head.render_timed(&params); // warm up (pipelines, targets)
    let (mut cpu, mut total, mut stats) = (Vec::new(), Vec::new(), None);
    for _ in 0..30 {
        let (st, c, tt) = head.render_timed(&params);
        cpu.push(c.as_secs_f64() * 1e3);
        total.push(tt.as_secs_f64() * 1e3);
        stats = Some(st);
    }
    let st = stats.expect("frames");
    println!("{} instances drawn in {} draw calls; CPU build+submit mean {:.2} ms (p95 {:.2}); to GPU idle mean {:.0} ms", st.instances, st.draw_calls, cpu.iter().sum::<f64>() / 30.0, percentile(&mut cpu, 0.95), total.iter().sum::<f64>() / 30.0);
    Ok(())
}
