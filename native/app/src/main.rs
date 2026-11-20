//! Desktop entry point: the window, or an off-screen tool.

#[cfg(not(target_arch = "wasm32"))]
use ascii_app::{args, headless, models, pool, shell as window};

const USAGE: &str = "ascii-scene [FILE.stl] [--world [--seed N] [--day]] [--scene NAME] [--gallery NAME] [--perf] [--size WxH]
  keys: 1-4 models, 6-9 galleries, M F L V A landscapes, I world, P walk, W wind, R rain, B leaves,
        F3 perf log, Esc release mouse; drop an .stl on the window
  tools: ascii-scene shot|golden|bench ... (off-screen, see native/README.md)";

#[cfg(not(target_arch = "wasm32"))]
fn parse_window(argv: &[String]) -> Result<window::Options, String> {
    use ascii_core::input::Command;
    let mut o = window::Options {
        start: Vec::new(),
        world: None,
        perf: std::env::var_os("ASCII_PERF").is_some(),
        size: (1000, 800),
        fade_secs: std::env::var("ASCII_FADE").ok().and_then(|v| v.parse().ok()).unwrap_or(0.8),
        present: std::env::var("ASCII_PRESENT").ok(),
        pose: None,
        pose_file: std::env::var("ASCII_POSE").ok(),
        autowalk: std::env::var_os("ASCII_AUTOWALK").is_some(),
    };
    let (mut seed, mut day, mut world) = (1u32, false, false);
    let mut it = argv.iter();
    while let Some(a) = it.next() {
        let mut val = || it.next().cloned().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "-h" | "--help" => return Err(USAGE.to_string()),
            "--world" => world = true,
            "--seed" => seed = val()?.parse().map_err(|_| "bad seed")?,
            "--day" => day = true,
            "--perf" => o.perf = true,
            "--scene" => o.start.push(Command::Scene(args::preset(&val()?)?)),
            "--gallery" => o.start.push(Command::Gallery(args::gallery(&val()?)?)),
            "--size" => {
                let v = val()?;
                let (w, h) = v.split_once('x').ok_or("size is WxH")?;
                o.size = (w.parse().map_err(|_| "bad width")?, h.parse().map_err(|_| "bad height")?);
            }
            path if !path.starts_with('-') => {
                let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
                let name = std::path::Path::new(path).file_name().map_or_else(String::new, |n| n.to_string_lossy().into_owned());
                o.start.push(Command::LoadStl { bytes, name });
            }
            other => return Err(format!("unknown option {other}\n{USAGE}")),
        }
    }
    if world {
        o.world = Some((seed, day));
    }
    // Development: ASCII_POSE=FILE reopens the world where the last run left it.
    if let Some(p) = o.pose_file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).and_then(|l| ascii_core::session::Pose::from_line(&l)) {
        eprintln!("[ascii] back in world {} at ({:.0}, {:.0})", p.seed, p.eye[0], p.eye[2]);
        o.start.clear();
        o.world = None;
        o.pose = Some(p);
        return Ok(o);
    }
    if o.start.is_empty() && o.world.is_none() {
        // Opening scene, like the webapp: the torus knot.
        let (name, bytes) = models::MODELS[0];
        o.start.push(Command::LoadStl { bytes: bytes.to_vec(), name: name.to_string() });
    }
    Ok(o)
}

#[cfg(target_arch = "wasm32")]
fn main() {}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let result = match argv.first().map(String::as_str) {
        Some("shot") => headless::shot_cmd(&argv[1..]),
        Some("golden") => headless::golden_cmd(&argv[1..]),
        Some("bench") => headless::bench_cmd(&argv[1..]),
        _ => parse_window(&argv).and_then(|o| window::run(o, pool::ThreadPool::new(pool::default_workers()))),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
