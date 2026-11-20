//! Frame trace for hunting stutters (desktop): `ASCII_TRACE=FILE` appends one
//! JSON line per second (frame rate, worst and 99th-percentile frame) and one
//! per slow frame (`ASCII_SPIKE_MS`, default 25) with where its time went.
//! Lines are flushed as written, so the file can be followed live.

use std::fmt::Write as _;
use std::io::Write;
use web_time::Instant;

/// Where one frame's time went (ms) and what it carried.
#[derive(Default, Clone, Copy)]
pub struct Frame {
    pub tasks: f64,
    pub update: f64,
    pub apply: f64,
    pub acquire: f64,
    pub render: f64,
    pub submit: f64,
    pub present: f64,
    pub set_cards: u32,
    pub card_mb: f64,
    pub bodies: u32,
    pub removed: u32,
    pub chunks_in: u32,
    /// GPU time of the previous frame: submit to done (ms; 0 if unknown).
    pub gpu_prev: f64,
    /// Time spent outside this frame's work since the previous one ended
    /// (event loop, vsync wait, OS).
    pub gap: f64,
    /// GPU time of the card evaluation pass, the underpaint pass and the
    /// whole frame (ms), latest read back (a frame or two old).
    pub passes: [f64; 3],
}

/// Times the GPU work of each frame: from submit to the queue reporting it done.
#[derive(Default)]
pub struct GpuTimer {
    done: std::sync::Arc<std::sync::Mutex<Option<(Instant, Instant)>>>,
}

impl GpuTimer {
    /// Call right after submitting a frame.
    pub fn submitted(&self, queue: &wgpu::Queue) {
        let submit = Instant::now();
        let slot = self.done.clone();
        queue.on_submitted_work_done(move || {
            if let Ok(mut s) = slot.lock() {
                *s = Some((submit, Instant::now()));
            }
        });
    }

    /// GPU time (ms) of the last frame that finished, once.
    pub fn take(&self, device: &wgpu::Device) -> f64 {
        let _ = device.poll(wgpu::PollType::Poll);
        self.done.lock().ok().and_then(|mut s| s.take()).map_or(0.0, |(a, b)| (b - a).as_secs_f64() * 1000.0)
    }
}

pub struct Trace {
    out: std::io::BufWriter<std::fs::File>,
    spike_ms: f64,
    start: Instant,
    last_frame: Option<Instant>,
    last_end: Option<Instant>,
    pub gpu: GpuTimer,
    pub last_passes: [f64; 3],
    pass_sum: [f64; 3],
    pass_max: [f64; 3],
    pass_n: f64,
    second: Instant,
    dts: Vec<f64>,
    gpus: Vec<f64>,
    drawn: u64,
    line: String,
}

pub fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

impl Trace {
    pub fn from_env() -> Option<Trace> {
        let path = std::env::var("ASCII_TRACE").ok()?;
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| eprintln!("[ascii] trace {path}: {e}")).ok()?;
        let spike_ms = std::env::var("ASCII_SPIKE_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(25.0);
        eprintln!("[ascii] tracing frames to {path} (spikes over {spike_ms} ms)");
        let now = Instant::now();
        Some(Trace { out: std::io::BufWriter::new(file), spike_ms, start: now, last_frame: None, last_end: None, gpu: GpuTimer::default(), last_passes: [0.0; 3], pass_sum: [0.0; 3], pass_max: [0.0; 3], pass_n: 0.0, second: now, dts: Vec::new(), gpus: Vec::new(), drawn: 0, line: String::new() })
    }

    /// A frame starts now: returns the time since the previous one (ms) and
    /// the time since the previous one ended.
    pub fn frame_start(&mut self) -> (f64, f64) {
        let now = Instant::now();
        let gap = self.last_end.map_or(0.0, |l| (now - l).as_secs_f64() * 1000.0);
        let dt = self.last_frame.map_or(0.0, |l| (now - l).as_secs_f64() * 1000.0);
        self.last_frame = Some(now);
        (dt, gap)
    }

    /// No frame was drawn (idle): the next gap is not a stutter.
    pub fn idle(&mut self) {
        self.last_frame = None;
        self.last_end = None;
    }

    fn emit(&mut self) {
        let _ = self.out.write_all(self.line.as_bytes());
        let _ = self.out.write_all(b"\n");
        let _ = self.out.flush();
    }

    /// Record a drawn frame that came `dt` ms after the previous one.
    pub fn frame(&mut self, dt: f64, f: &Frame, s: &ascii_core::session::Stats, cam: [f64; 3], playing: bool, drawn: u64) {
        if f.gpu_prev > 0.0 {
            self.gpus.push(f.gpu_prev);
        }
        self.drawn = drawn;
        for k in 0..3 {
            self.pass_sum[k] += f.passes[k];
            self.pass_max[k] = self.pass_max[k].max(f.passes[k]);
        }
        self.pass_n += 1.0;
        let t = self.start.elapsed().as_secs_f64();
        self.last_end = Some(Instant::now());
        if dt > 0.0 {
            self.dts.push(dt);
        }
        if dt > self.spike_ms {
            self.line.clear();
            let _ = write!(
                self.line,
                r#"{{"t":{t:.3},"kind":"spike","dt":{dt:.1},"tasks":{:.2},"update":{:.2},"apply":{:.2},"acquire":{:.2},"render":{:.2},"submit":{:.2},"present":{:.2},"gpu_prev":{:.2},"eval":{:.2},"under":{:.2},"frame":{:.2},"gap":{:.2},"set_cards":{},"card_mb":{:.2},"bodies":{},"removed":{},"chunks_in":{},"loaded":{},"pending":{},"built":{},"cam":[{:.1},{:.1},{:.1}],"playing":{playing}}}"#,
                f.tasks, f.update, f.apply, f.acquire, f.render, f.submit, f.present, f.gpu_prev, f.passes[0], f.passes[1], f.passes[2], f.gap, f.set_cards, f.card_mb, f.bodies, f.removed, f.chunks_in, s.chunks_loaded, s.chunks_pending, s.chunks_built, cam[0], cam[1], cam[2]
            );
            self.emit();
        }
        if self.second.elapsed().as_secs_f64() >= 1.0 && !self.dts.is_empty() {
            let secs = self.second.elapsed().as_secs_f64();
            self.second = Instant::now();
            let n = self.dts.len();
            self.dts.sort_by(f64::total_cmp);
            let worst = self.dts[n - 1];
            let p99 = self.dts[((n - 1) as f64 * 0.99).round() as usize];
            let over = self.dts.iter().filter(|d| **d > self.spike_ms).count();
            self.dts.clear();
            let gn = self.gpus.len().max(1) as f64;
            let gpu_mean = self.gpus.iter().sum::<f64>() / gn;
            let gpu_max = self.gpus.iter().copied().fold(0.0, f64::max);
            self.gpus.clear();
            let pn = self.pass_n.max(1.0);
            let [se, su, ss] = self.pass_sum.map(|v| v / pn);
            let [me, mu, ms] = self.pass_max;
            self.pass_sum = [0.0; 3];
            self.pass_max = [0.0; 3];
            self.pass_n = 0.0;
            self.line.clear();
            let _ = write!(
                self.line,
                r#"{{"t":{t:.3},"kind":"second","fps":{:.1},"worst":{worst:.1},"p99":{p99:.1},"spikes":{over},"gpu_mean":{gpu_mean:.1},"gpu_max":{gpu_max:.1},"eval":[{se:.1},{me:.1}],"under":[{su:.1},{mu:.1}],"frame":[{ss:.1},{ms:.1}],"drawn":{},"cards":{},"loaded":{},"pending":{},"built":{},"chunk_ms_mean":{:.0},"cam":[{:.1},{:.1},{:.1}],"playing":{playing}}}"#,
                n as f64 / secs, self.drawn, s.cards, s.chunks_loaded, s.chunks_pending, s.chunks_built, s.chunk_ms_mean, cam[0], cam[1], cam[2]
            );
            self.emit();
        }
    }
}

/// Settings read from `ASCII_TUNE=FILE` (`key = value` lines, `#` comments),
/// read again whenever the file changes: try a change on the running app.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tune {
    /// Walk on its own (running, turning slowly).
    pub autowalk: Option<bool>,
    /// Dissolve time of rebuilt chunks, seconds.
    pub fade: Option<f32>,
    /// Force the underpaint pass on or off.
    pub underpaint: Option<bool>,
    /// Haze e-folding distance, m.
    pub fog: Option<f32>,
}

pub struct TuneFile {
    path: String,
    stamp: Option<std::time::SystemTime>,
    checked: Instant,
}

impl TuneFile {
    pub fn from_env() -> Option<TuneFile> {
        let path = std::env::var("ASCII_TUNE").ok()?;
        eprintln!("[ascii] live settings from {path}");
        Some(TuneFile { path, stamp: None, checked: Instant::now() })
    }

    /// The settings, when the file changed since the last look (twice a second).
    pub fn poll(&mut self) -> Option<Tune> {
        if self.stamp.is_some() && self.checked.elapsed().as_secs_f64() < 0.5 {
            return None;
        }
        self.checked = Instant::now();
        let stamp = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        if stamp.is_none() || stamp == self.stamp {
            return None;
        }
        self.stamp = stamp;
        let text = std::fs::read_to_string(&self.path).ok()?;
        let mut t = Tune::default();
        for line in text.lines() {
            let line = line.split('#').next().unwrap_or("").trim();
            let Some((k, v)) = line.split_once('=') else { continue };
            let (k, v) = (k.trim(), v.trim());
            let flag = matches!(v, "1" | "true" | "on" | "yes");
            match k {
                "autowalk" => t.autowalk = Some(flag),
                "fade" => t.fade = v.parse().ok(),
                "underpaint" => t.underpaint = Some(flag),
                "fog" => t.fog = v.parse().ok(),
                _ => eprintln!("[ascii] tune: unknown setting {k}"),
            }
        }
        eprintln!("[ascii] tune: {t:?}");
        Some(t)
    }
}
