//! First-person player: physics state plus mouse look. Input arrives as an
//! abstract `InputState` (from `input.rs`), never as raw keys.

use crate::input::InputState;
use crate::physics::{Ground, Input, Physics, PlayerState, PLAYER_EYE};
use glam::{DMat4, DVec3};

/// Mouse look sensitivity, radians per pixel.
pub const SENSITIVITY: f64 = 0.0022;

pub struct Player {
    pub physics: Physics,
    pub state: PlayerState,
}

impl Player {
    pub fn new<G: Ground>(g: &G, x: f64, z: f64, yaw: f64) -> Self {
        let physics = Physics::new();
        let state = physics.spawn(g, x, z, yaw);
        Player { physics, state }
    }

    /// Mouse look by raw pixel deltas (no-op unless the mouse is captured, which the shell decides).
    pub fn look(&mut self, dx: f64, dy: f64) {
        self.state.yaw -= dx * SENSITIVITY;
        self.state.pitch = (self.state.pitch - dy * SENSITIVITY).clamp(-1.45, 1.45);
    }

    pub fn update<G: Ground>(&mut self, g: &G, input: &InputState, dt: f64) {
        let i = Input { forward: input.forward, right: input.right, run: input.run, jump: input.jump };
        self.physics.update(g, &mut self.state, i, dt);
    }

    pub fn eye(&self) -> DVec3 {
        DVec3::new(self.state.x, self.state.y + PLAYER_EYE, self.state.z)
    }

    /// View direction (unit).
    pub fn forward(&self) -> DVec3 {
        let (p, y) = (self.state.pitch, self.state.yaw);
        DVec3::new(-y.sin() * p.cos(), p.sin(), -y.cos() * p.cos())
    }

    /// View matrix: camera rotation is Euler YXZ (yaw, then pitch), as in three.js.
    pub fn view_matrix(&self) -> DMat4 {
        let rot = glam::DQuat::from_euler(glam::EulerRot::YXZ, self.state.yaw, self.state.pitch, 0.0);
        DMat4::from_rotation_translation(rot, self.eye()).inverse()
    }
}
