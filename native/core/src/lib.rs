//! Platform-independent core of the native port.
//!
//! Everything that decides what the scene is and how the player moves lives
//! here: the session state machine, orbit and walking cameras, physics,
//! weather, world streaming, job scheduling and the data handed to a
//! renderer. Nothing in this crate knows about windows, GPUs, files or
//! threads: platform shells feed it abstract input, an injected clock and a
//! `JobExecutor`, and read back `RenderEvent`s and `FrameParams`.
//!
//! Rules: no `cfg(target_os)`, no `std::time`, no `std::thread` here.

pub mod chunks;
pub mod glyphs;
pub mod input;
pub mod jobs;
pub mod orbit;
pub mod physics;
pub mod player;
pub mod render_data;
pub mod session;
pub mod streamer;
pub mod weather;

pub use input::{Command, InputState};
pub use jobs::{InlineExecutor, JobExecutor};
pub use render_data::{FrameParams, RenderEvent};
pub use session::Session;

/// Floats per card; must match the engine and the renderer's vertex layout.
pub const CARD_STRIDE: usize = ascii_engine::STRIDE;
