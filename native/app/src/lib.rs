//! ASCII Scene, one app for every platform: desktop (macOS, Linux, Windows)
//! and the web share this shell, the core (`ascii_core`) and the renderer
//! (`ascii_render`). Only the job executor and the start-up differ: threads
//! on desktop, Web Workers in the browser (`web.rs`).

pub mod args;
pub mod models;
pub mod shell;

#[cfg(not(target_arch = "wasm32"))]
pub mod headless;
#[cfg(not(target_arch = "wasm32"))]
pub mod pool;
#[cfg(not(target_arch = "wasm32"))]
pub mod trace;
#[cfg(target_arch = "wasm32")]
pub mod web;

/// The job executor of this platform.
#[cfg(not(target_arch = "wasm32"))]
pub type Pool = pool::ThreadPool;
#[cfg(target_arch = "wasm32")]
pub type Pool = web::WebPool;

/// A line for the log: stderr on desktop, the browser console on the web.
#[macro_export]
macro_rules! log {
    ($($t:tt)*) => {{
        #[cfg(not(target_arch = "wasm32"))]
        eprintln!($($t)*);
        #[cfg(target_arch = "wasm32")]
        web_sys::console::log_1(&format!($($t)*).into());
    }};
}
