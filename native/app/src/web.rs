//! The browser side of the shell: start-up from the page, a job executor on
//! Web Workers, and the entry point those workers run. Each worker holds its
//! own instance of this same module; jobs and results cross as bytes
//! (`ascii_core::wire`), transferred, not copied.

use crate::shell::{self, Options};
use ascii_core::input::Command;
use ascii_core::jobs::{Job, JobDone, JobExecutor, Worker};
use ascii_core::wire;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

/// Show a start-up error on the page (no GPU, no WebGPU).
pub fn show_error(msg: &str) {
    let Some(doc) = web_sys::window().and_then(|w| w.document()) else { return };
    if let Ok(el) = doc.create_element("pre") {
        el.set_text_content(Some(&format!("ASCII Scene could not start: {msg}")));
        let _ = el.set_attribute("style", "position:fixed;left:16px;top:16px;right:16px;color:#e8d8c0;font:14px monospace;white-space:pre-wrap");
        if let Some(body) = doc.body() {
            let _ = body.append_child(&el);
        }
    }
}

/// Start the app on `canvas`, building in the background on `workers`
/// (Web Workers that run `worker.js`).
#[wasm_bindgen]
pub fn start(canvas: web_sys::HtmlCanvasElement, workers: Vec<web_sys::Worker>, perf: bool) -> Result<(), JsValue> {
    let (name, bytes) = crate::models::MODELS[0];
    let opts = Options {
        // Opening scene: the torus knot.
        start: vec![Command::LoadStl { bytes: bytes.to_vec(), name: name.to_string() }],
        world: None,
        perf,
        size: (canvas.client_width().max(1) as u32, canvas.client_height().max(1) as u32),
        fade_secs: 0.8,
        present: None,
        canvas: Some(canvas),
    };
    shell::run(opts, WebPool::new(workers)).map_err(|e| JsValue::from_str(&e))
}

/// Load an STL file the page was given (drag and drop).
#[wasm_bindgen]
pub fn load_stl(bytes: Vec<u8>, name: String) {
    shell::send(Command::LoadStl { bytes, name });
}

thread_local! {
    static WORKER: RefCell<Option<Worker>> = const { RefCell::new(None) };
}

/// Run one job inside a Web Worker: job bytes in, result bytes out.
#[wasm_bindgen]
pub fn worker_run(job: &[u8]) -> Vec<u8> {
    let t0 = web_time::Instant::now();
    let (id, output) = match wire::decode_job(job) {
        Ok(j) => (j.id, WORKER.with(|w| w.borrow_mut().get_or_insert_with(Worker::new).run(&j.kind))),
        Err(e) => (u64::MAX, Err(e)),
    };
    wire::encode_done(&JobDone { id, elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0, output })
}

type Inbox = Rc<RefCell<Vec<(usize, Vec<u8>)>>>;

/// Jobs spread over Web Workers, one job per worker at a time.
pub struct WebPool {
    workers: Vec<web_sys::Worker>,
    busy: Vec<bool>,
    queue: VecDeque<Job>,
    done: Inbox,
    _handlers: Vec<Closure<dyn FnMut(web_sys::MessageEvent)>>,
}

impl WebPool {
    pub fn new(workers: Vec<web_sys::Worker>) -> Self {
        let done: Inbox = Rc::new(RefCell::new(Vec::new()));
        let handlers = workers
            .iter()
            .enumerate()
            .map(|(i, w)| {
                let done = done.clone();
                let h = Closure::<dyn FnMut(web_sys::MessageEvent)>::new(move |e: web_sys::MessageEvent| {
                    done.borrow_mut().push((i, js_sys::Uint8Array::new(&e.data()).to_vec()));
                });
                w.set_onmessage(Some(h.as_ref().unchecked_ref()));
                h
            })
            .collect();
        let busy = vec![false; workers.len()];
        WebPool { workers, busy, queue: VecDeque::new(), done, _handlers: handlers }
    }

    fn pump(&mut self) {
        for (i, w) in self.workers.iter().enumerate() {
            if self.busy[i] {
                continue;
            }
            let Some(job) = self.queue.pop_front() else { return };
            let bytes = js_sys::Uint8Array::from(wire::encode_job(&job).as_slice());
            let transfer = js_sys::Array::of1(&bytes.buffer());
            if let Err(e) = w.post_message_with_transfer(&bytes, &transfer) {
                crate::log!("[ascii] worker {i}: {e:?}");
                continue;
            }
            self.busy[i] = true;
        }
    }
}

impl JobExecutor for WebPool {
    fn submit(&mut self, job: Job) {
        self.queue.push_back(job);
        self.pump();
    }

    fn poll(&mut self, out: &mut Vec<JobDone>) {
        let done = std::mem::take(&mut *self.done.borrow_mut());
        for (i, bytes) in done {
            self.busy[i] = false;
            match wire::decode_done(&bytes) {
                Ok(d) => out.push(d),
                Err(e) => crate::log!("[ascii] worker {i}: {e}"),
            }
        }
        self.pump();
    }

    fn workers(&self) -> usize {
        self.workers.len()
    }

    fn cancel_queued(&mut self) {
        self.queue.clear();
    }
}

// ---- Hooks for tests and the console (`window.__ascii` in dev and test
// builds). They queue work for the next frame; answers come back as promises.

type Session = ascii_core::Session<crate::Pool>;

fn set(o: &js_sys::Object, k: &str, v: impl Into<JsValue>) {
    let _ = js_sys::Reflect::set(o, &k.into(), &v.into());
}

/// Run `f` on the session at the next frame and resolve with its answer.
fn ask(f: impl FnOnce(&mut Session) -> JsValue + 'static) -> js_sys::Promise {
    let mut f = Some(f);
    js_sys::Promise::new(&mut |resolve, _reject| {
        let f = f.take().expect("promise executor runs once");
        shell::with_session(move |s| {
            let _ = resolve.call1(&JsValue::NULL, &f(s));
        });
    })
}

/// What is on screen: status, model, card and chunk counts, weather.
#[wasm_bindgen]
pub fn state() -> JsValue {
    let s = shell::snapshot();
    let o = js_sys::Object::new();
    let (status, error) = match &s.status {
        None | Some(ascii_core::session::Status::Loading) => ("loading", None),
        Some(ascii_core::session::Status::Ready) => ("ready", None),
        Some(ascii_core::session::Status::Error(e)) => ("error", Some(e.clone())),
    };
    set(&o, "status", status);
    set(&o, "error", error.map_or(JsValue::NULL, JsValue::from));
    set(&o, "model", s.stats.model.as_str());
    set(&o, "cards", s.stats.cards as f64);
    set(&o, "triangles", s.stats.triangles);
    set(&o, "playing", s.playing);
    let w = js_sys::Object::new();
    set(&w, "wind", s.weather[0]);
    set(&w, "rain", s.weather[1]);
    set(&w, "leaves", s.weather[2]);
    set(&o, "weather", w);
    let world = js_sys::Object::new();
    set(&world, "loaded", s.stats.chunks_loaded as u32);
    set(&world, "pending", s.stats.chunks_pending as u32);
    set(&world, "built", s.stats.chunks_built);
    set(&o, "world", world);
    let bg = js_sys::Array::new();
    for c in s.background {
        bg.push(&JsValue::from(c));
    }
    set(&o, "background", bg);
    o.into()
}

/// Bundled model `index` (0-3).
#[wasm_bindgen]
pub fn load_model(index: usize) {
    if let Some((name, bytes)) = crate::models::MODELS.get(index) {
        shell::send(Command::LoadStl { bytes: bytes.to_vec(), name: (*name).to_string() });
    }
}

#[wasm_bindgen]
pub fn load_gallery(name: &str, seed: Option<u32>) -> Result<(), JsValue> {
    let g = crate::args::gallery(name).map_err(|e| JsValue::from_str(&e))?;
    shell::with_session(move |s| s.show_gallery(g, seed.unwrap_or(1)));
    Ok(())
}

#[wasm_bindgen]
pub fn load_scene(name: &str, seed: Option<u32>) -> Result<(), JsValue> {
    let p = crate::args::preset(name).map_err(|e| JsValue::from_str(&e))?;
    shell::with_session(move |s| s.show_scene(p, seed.unwrap_or(1)));
    Ok(())
}

#[wasm_bindgen]
pub fn load_world(seed: Option<u32>, day: Option<bool>) {
    shell::with_session(move |s| s.show_world(seed.unwrap_or(1), day.unwrap_or(false)));
}

/// Set wind, rain and blown leaves (0..1); leave one out to keep it.
#[wasm_bindgen]
pub fn set_environment(wind: Option<f32>, rain: Option<f32>, leaves: Option<f32>) {
    shell::with_session(move |s| s.set_weather(wind, rain, leaves));
}

/// Freeze the animation clock at `t` seconds, or let it run (no argument).
#[wasm_bindgen]
pub fn freeze_time(t: Option<f64>) {
    shell::send(Command::FreezeTime(t));
}

/// Start walking; resolves false when there is nothing to walk on.
#[wasm_bindgen]
pub fn play() -> js_sys::Promise {
    ask(|s| s.play().into())
}

#[wasm_bindgen]
pub fn stop_playing() {
    shell::with_session(Session::stop_playing);
}

/// Slide the orbit camera by (dx, dz) metres.
#[wasm_bindgen]
pub fn travel(dx: f64, dz: f64) {
    shell::with_session(move |s| s.travel(dx, dz));
}

/// Walk the player for `seconds` with fixed input; resolves with where it
/// went and how close to the ground it got (null when not playing).
#[wasm_bindgen]
pub fn walk(forward: f64, right: f64, run: bool, jump: bool, yaw: Option<f64>, seconds: f64) -> js_sys::Promise {
    ask(move |s| {
        let input = ascii_core::input::InputState { forward, right, run, jump };
        let Some(r) = s.walk_steps(&input, yaw, seconds) else { return JsValue::NULL };
        let o = js_sys::Object::new();
        set(&o, "minClearance", r.min_clearance);
        set(&o, "inWater", r.in_water);
        set(&o, "x", r.x);
        set(&o, "y", r.y);
        set(&o, "z", r.z);
        set(&o, "moved", r.moved);
        set(&o, "ground", r.ground);
        o.into()
    })
}

/// The next frame, rendered off-screen at `width` x `height`: resolves with
/// RGBA8 rows, top row first.
#[wasm_bindgen]
pub fn capture(width: u32, height: u32) -> js_sys::Promise {
    js_sys::Promise::new(&mut |resolve, reject| {
        shell::capture(
            (width.max(1), height.max(1)),
            Box::new(move |r| {
                let _ = match r {
                    Ok((px, _)) => resolve.call1(&JsValue::NULL, &js_sys::Uint8Array::from(px.as_slice())),
                    Err(e) => reject.call1(&JsValue::NULL, &JsValue::from_str(&e)),
                };
            }),
        );
    })
}
