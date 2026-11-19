//! Abstract input: continuous state (what is held) and discrete commands
//! (what was pressed). A shell maps keys, mouse and files onto these; the
//! core never sees raw key codes.

use ascii_engine::scenery::{gallery::Category, scene::ScenePreset};

/// Continuous movement input, refreshed by the shell every frame.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputState {
    pub forward: f64,
    pub right: f64,
    pub run: bool,
    pub jump: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gallery {
    Rocks,
    Plants,
    Bushes,
    Trees,
}

impl Gallery {
    pub fn category(self) -> Category {
        match self {
            Gallery::Rocks => Category::Rocks,
            Gallery::Plants => Category::Plants,
            Gallery::Bushes => Category::Bushes,
            Gallery::Trees => Category::Trees,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Gallery::Rocks => "rocks",
            Gallery::Plants => "plants",
            Gallery::Bushes => "bushes",
            Gallery::Trees => "trees",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Meadow,
    Forest,
    Lake,
    Valley,
    Alpine,
}

impl Preset {
    pub fn name(self) -> &'static str {
        match self {
            Preset::Meadow => "meadow",
            Preset::Forest => "forest",
            Preset::Lake => "lake",
            Preset::Valley => "valley",
            Preset::Alpine => "alpine",
        }
    }
    pub fn engine(self) -> ScenePreset {
        ScenePreset::parse(self.name()).expect("known preset")
    }
}

/// Discrete user intents.
#[derive(Clone, Debug)]
pub enum Command {
    /// An STL dropped or given on the command line.
    LoadStl { bytes: Vec<u8>, name: String },
    Gallery(Gallery),
    Scene(Preset),
    /// The infinite world (key I).
    World,
    /// Toggle walking (key P).
    TogglePlay,
    CycleWind,
    ToggleRain,
    ToggleLeaves,
    /// Freeze the animation clock at t seconds (tests), or release it.
    FreezeTime(Option<f64>),
}

/// Pointer interaction for the orbit camera, in pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Pointer {
    Rotate { dx: f64, dy: f64 },
    Pan { dx: f64, dy: f64 },
    /// Wheel, in browser-style pixels (one notch = 100).
    Zoom(f64),
    /// Raw mouse movement for first-person look.
    Look { dx: f64, dy: f64 },
}
