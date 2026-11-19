//! Weather and wind state (port of the `Environment` in `render/cards.ts`).
//! The shader animates everything from these few numbers and the clock.

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Environment {
    /// Wind direction in the ground plane (x, z); normalized when used.
    pub wind_dir: [f32; 2],
    pub wind: f32,
    pub rain: f32,
    pub leaves: f32,
    /// Distance haze: e-folding distance in metres and strength (0 = off).
    pub fog_dist: f32,
    pub fog: f32,
    pub haze_color: [f32; 3],
    /// Box (x, y, z sizes) rain falls in, following the camera.
    pub rain_box: [f32; 3],
    /// Blown leaves travel in a box of side [2] round the camera.
    pub leaf_box: [f32; 3],
}

pub const CALM: Environment = Environment {
    wind_dir: [1.0, 0.0],
    wind: 0.0,
    rain: 0.0,
    leaves: 0.0,
    fog_dist: 420.0,
    fog: 0.0,
    haze_color: [120.0 / 255.0, 112.0 / 255.0, 140.0 / 255.0],
    rain_box: [36.0, 24.0, 36.0],
    leaf_box: [0.0, 0.0, 1.0],
};

impl Environment {
    /// Set any of wind / rain / leaves (clamped to 0..1).
    pub fn set(&mut self, wind: Option<f32>, rain: Option<f32>, leaves: Option<f32>) {
        let c = |v: Option<f32>, d: f32| v.unwrap_or(d).clamp(0.0, 1.0);
        self.wind = c(wind, self.wind);
        self.rain = c(rain, self.rain);
        self.leaves = c(leaves, self.leaves);
    }

    /// Key W: calm -> breeze -> storm -> calm.
    pub fn cycle_wind(&mut self) {
        let w = self.wind;
        self.set(Some(if w < 0.2 { 0.35 } else if w < 0.6 { 0.85 } else { 0.0 }), None, None);
    }

    /// Key R.
    pub fn toggle_rain(&mut self) {
        let r = if self.rain > 0.0 { 0.0 } else { 1.0 };
        self.set(None, Some(r), None);
    }

    /// Key B.
    pub fn toggle_leaves(&mut self) {
        let l = if self.leaves > 0.0 { 0.0 } else { 0.8 };
        self.set(None, None, Some(l));
    }
}

/// Weather each landscape starts with (wind, rain, leaves).
pub fn scene_weather(preset: &str) -> (f32, f32, f32) {
    match preset {
        "meadow" => (0.35, 0.0, 0.5),
        "forest" => (0.25, 0.0, 0.7),
        "lake" => (0.2, 0.0, 0.3),
        "valley" => (0.4, 0.0, 0.4),
        _ => (0.6, 0.0, 0.2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wind_cycles_like_the_webapp() {
        let mut e = CALM;
        e.cycle_wind();
        assert_eq!(e.wind, 0.35);
        e.cycle_wind();
        assert_eq!(e.wind, 0.85);
        e.cycle_wind();
        assert_eq!(e.wind, 0.0);
    }
}
