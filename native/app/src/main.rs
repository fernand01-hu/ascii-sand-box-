mod args;
mod headless;
mod models;
mod pool;
mod window;

const USAGE: &str = "ascii-scene [FILE.stl] [--world [--seed N] [--day]] [--scene NAME] [--gallery NAME] [--perf] [--size WxH]
  keys: 1-4 models, 6-9 galleries, M F L V A landscapes, I world, P walk, W wind, R rain, B leaves,
        F3 perf log, Esc release mouse; drop an .stl on the window
  tools: ascii-scene shot|golden|bench ... (off-screen, see native/README.md)";

fn parse_window(argv: &[String]) -> Result<window::Options, String> {
    use ascii_core::input::Command;
    let mut o = window::Options { start: Vec::new(), world: None, perf: std::env::var_os("ASCII_PERF").is_some(), size: (1000, 800) };
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
    if o.start.is_empty() && o.world.is_none() {
        // Opening scene, like the webapp: the torus knot.
        let (name, bytes) = models::MODELS[0];
        o.start.push(Command::LoadStl { bytes: bytes.to_vec(), name: name.to_string() });
    }
    Ok(o)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let result = match argv.first().map(String::as_str) {
        Some("shot") => headless::shot_cmd(&argv[1..]),
        Some("golden") => headless::golden_cmd(&argv[1..]),
        _ => parse_window(&argv).and_then(window::run),
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
