//! Orbit camera: port of three.js `OrbitControls` as the viewer configures it
//! (damping 0.08, left rotate, right pan, wheel dolly, no auto-rotate).

use glam::{DMat4, DVec3};
use std::f64::consts::PI;

const EPS: f64 = 1e-6;
pub const DAMPING: f64 = 0.08;

#[derive(Clone, Debug)]
pub struct Orbit {
    pub position: DVec3,
    pub target: DVec3,
    pub min_distance: f64,
    pub max_distance: f64,
    pub max_polar: f64,
    pub enabled: bool,
    /// Vertical field of view, degrees (used to scale panning).
    pub fov_deg: f64,
    theta_delta: f64,
    phi_delta: f64,
    pan_offset: DVec3,
    scale: f64,
    last_position: DVec3,
}

impl Default for Orbit {
    fn default() -> Self {
        let position = DVec3::new(3.0, 2.0, 5.0);
        Orbit {
            position,
            target: DVec3::ZERO,
            min_distance: 0.0,
            max_distance: f64::INFINITY,
            max_polar: PI,
            enabled: true,
            fov_deg: 35.0,
            theta_delta: 0.0,
            phi_delta: 0.0,
            pan_offset: DVec3::ZERO,
            scale: 1.0,
            last_position: DVec3::splat(f64::NAN),
        }
    }
}

impl Orbit {
    /// Drag to rotate; `viewport_h` in pixels.
    pub fn rotate(&mut self, dx: f64, dy: f64, viewport_h: f64) {
        self.theta_delta -= 2.0 * PI * dx / viewport_h;
        self.phi_delta -= 2.0 * PI * dy / viewport_h;
    }

    /// Right-drag to pan (screen-space).
    pub fn pan(&mut self, dx: f64, dy: f64, viewport_h: f64) {
        let dist = (self.position - self.target).length() * (self.fov_deg / 2.0 * PI / 180.0).tan();
        let (right, up) = self.basis();
        self.pan_offset += right * (-2.0 * dx * dist / viewport_h);
        self.pan_offset += up * (2.0 * dy * dist / viewport_h);
    }

    /// Wheel, browser-style pixels (negative = zoom in).
    pub fn zoom(&mut self, delta_y: f64) {
        let s = 0.95f64.powf((delta_y * 0.01).abs());
        if delta_y < 0.0 {
            self.scale *= s;
        } else if delta_y > 0.0 {
            self.scale /= s;
        }
    }

    /// Camera right and up vectors for the current look-at.
    fn basis(&self) -> (DVec3, DVec3) {
        let z = (self.position - self.target).normalize_or_zero();
        let x = DVec3::Y.cross(z).normalize_or_zero();
        let y = z.cross(x);
        (x, y)
    }

    /// Advance damping; returns true when the camera moved.
    pub fn update(&mut self) -> bool {
        let mut offset = self.position - self.target;
        let radius0 = offset.length();
        let (mut theta, mut phi) = if radius0 == 0.0 { (0.0, 0.0) } else { (offset.x.atan2(offset.z), (offset.y / radius0).clamp(-1.0, 1.0).acos()) };
        theta += self.theta_delta * DAMPING;
        phi += self.phi_delta * DAMPING;
        phi = phi.clamp(0.0, self.max_polar);
        phi = phi.clamp(EPS, PI - EPS);
        self.target += self.pan_offset * DAMPING;
        let radius = (radius0 * self.scale).clamp(self.min_distance, self.max_distance);
        offset = DVec3::new(radius * phi.sin() * theta.sin(), radius * phi.cos(), radius * phi.sin() * theta.cos());
        self.position = self.target + offset;
        self.theta_delta *= 1.0 - DAMPING;
        self.phi_delta *= 1.0 - DAMPING;
        self.pan_offset *= 1.0 - DAMPING;
        let zoomed = self.scale != 1.0;
        self.scale = 1.0;
        let moved = zoomed || self.last_position.distance_squared(self.position) > EPS || self.last_position.is_nan();
        self.last_position = self.position;
        moved
    }

    pub fn view_matrix(&self) -> DMat4 {
        DMat4::look_at_rh(self.position, self.target, DVec3::Y)
    }

    /// Put the camera at `eye` looking at `target` (settles damping).
    pub fn set_view(&mut self, eye: DVec3, target: DVec3) {
        self.position = eye;
        self.target = target;
        self.theta_delta = 0.0;
        self.phi_delta = 0.0;
        self.pan_offset = DVec3::ZERO;
        self.scale = 1.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotate_keeps_distance_and_clamps_polar() {
        let mut o = Orbit::default();
        let d0 = (o.position - o.target).length();
        o.max_polar = PI * 0.495;
        for _ in 0..200 {
            o.rotate(0.0, 40.0, 800.0);
            o.update();
        }
        assert!(((o.position - o.target).length() - d0).abs() < 1e-9);
        let phi = ((o.position.y - o.target.y) / d0).acos();
        assert!(phi <= PI * 0.495 + 1e-9);
    }

    #[test]
    fn zoom_respects_limits() {
        let mut o = Orbit::default();
        o.min_distance = 2.0;
        o.max_distance = 20.0;
        for _ in 0..300 {
            o.zoom(-100.0);
            o.update();
        }
        assert!(((o.position - o.target).length() - 2.0).abs() < 1e-9);
    }
}
