//! Player physics: exact port of `web/src/app/physics.ts`. f64 throughout and
//! fixed 1/120 s steps, so trajectories match the webapp's.

use std::collections::HashMap;

pub const PLAYER_RADIUS: f64 = 0.35;
pub const PLAYER_EYE: f64 = 1.65;
pub const WALK: f64 = 4.0;
pub const RUN: f64 = 8.5;
pub const JUMP: f64 = 6.2;
pub const GRAVITY: f64 = 20.0;
/// Steepest slope you can walk up (rise over run).
pub const MAX_SLOPE: f64 = 1.1;
/// Steps you can climb without jumping (m).
pub const STEP: f64 = 0.45;
pub const ACCEL_GROUND: f64 = 12.0;
pub const ACCEL_AIR: f64 = 2.5;
pub const DT: f64 = 1.0 / 120.0;

/// What the physics asks about the world (finite scene or streamed chunks).
pub trait Ground {
    /// Ground height, or NaN where the world is not loaded yet.
    fn height(&self, x: f64, z: f64) -> f64;
    fn is_water(&self, x: f64, z: f64) -> bool;
    /// Inside the playable area (and loaded).
    fn in_bounds(&self, x: f64, z: f64) -> bool;
    /// Colliders near (x, z): calls `f(x, z, radius, top)` for each.
    fn colliders_near<F: FnMut(f64, f64, f64, f64)>(&self, x: f64, z: f64, f: F);
}

/// Colliders bucketed on a grid, for fast nearby lookups.
pub struct ColliderGrid {
    pub c: Vec<f32>,
    cell: f64,
    grid: HashMap<i64, Vec<u32>>,
}

impl ColliderGrid {
    pub fn new(c: Vec<f32>) -> Self {
        Self::with_cell(c, 4.0)
    }

    pub fn with_cell(c: Vec<f32>, cell: f64) -> Self {
        let mut grid: HashMap<i64, Vec<u32>> = HashMap::new();
        let mut i = 0;
        while i + 4 <= c.len() {
            let r = f64::from(c[i + 2]) + PLAYER_RADIUS;
            let (cx, cz) = (f64::from(c[i]), f64::from(c[i + 1]));
            let x0 = ((cx - r) / cell).floor() as i64;
            let x1 = ((cx + r) / cell).floor() as i64;
            let z0 = ((cz - r) / cell).floor() as i64;
            let z1 = ((cz + r) / cell).floor() as i64;
            for gx in x0..=x1 {
                for gz in z0..=z1 {
                    grid.entry(gx * 100_003 + gz).or_default().push(i as u32);
                }
            }
            i += 4;
        }
        ColliderGrid { c, cell, grid }
    }

    #[inline]
    pub fn near<F: FnMut(f64, f64, f64, f64)>(&self, x: f64, z: f64, mut f: F) {
        let k = (x / self.cell).floor() as i64 * 100_003 + (z / self.cell).floor() as i64;
        if let Some(list) = self.grid.get(&k) {
            for &i in list {
                let i = i as usize;
                f(f64::from(self.c[i]), f64::from(self.c[i + 1]), f64::from(self.c[i + 2]), f64::from(self.c[i + 3]));
            }
        }
    }
}

/// A finite scene's heightfield.
pub struct GridWorld {
    /// Row-major (iz * n + ix), over a `size` x `size` square centred on 0.
    pub heights: Vec<f32>,
    pub n: usize,
    pub size: f64,
    /// Water surface height, if any.
    pub water: Option<f64>,
    pub water_mask: Vec<u8>,
    pub colliders: Vec<f32>,
}

pub struct GridGround {
    pub world: GridWorld,
    colliders: ColliderGrid,
}

impl GridGround {
    pub fn new(world: GridWorld) -> Self {
        let colliders = ColliderGrid::new(world.colliders.clone());
        GridGround { world, colliders }
    }
}

impl Ground for GridGround {
    fn height(&self, x: f64, z: f64) -> f64 {
        let w = &self.world;
        let n = w.n;
        let half = w.size / 2.0;
        let res = w.size / (n - 1) as f64;
        let fx = ((x + half) / res).max(0.0).min(n as f64 - 1.001);
        let fz = ((z + half) / res).max(0.0).min(n as f64 - 1.001);
        let (ix, iz) = (fx.floor() as usize, fz.floor() as usize);
        let (tx, tz) = (fx - ix as f64, fz - iz as f64);
        let h = |i: usize, j: usize| f64::from(w.heights[j * n + i]);
        (h(ix, iz) * (1.0 - tx) + h(ix + 1, iz) * tx) * (1.0 - tz) + (h(ix, iz + 1) * (1.0 - tx) + h(ix + 1, iz + 1) * tx) * tz
    }

    fn is_water(&self, x: f64, z: f64) -> bool {
        let w = &self.world;
        if w.water.is_none() || w.water_mask.is_empty() {
            return false;
        }
        let res = w.size / (w.n - 1) as f64;
        // JS Math.round: halves go up.
        let ix = ((x + w.size / 2.0) / res + 0.5).floor();
        let iz = ((z + w.size / 2.0) / res + 0.5).floor();
        if ix < 0.0 || iz < 0.0 || ix >= w.n as f64 || iz >= w.n as f64 {
            return false;
        }
        w.water_mask[iz as usize * w.n + ix as usize] == 1
    }

    fn in_bounds(&self, x: f64, z: f64) -> bool {
        let lim = self.world.size / 2.0 - 2.0;
        x.abs() < lim && z.abs() < lim
    }

    fn colliders_near<F: FnMut(f64, f64, f64, f64)>(&self, x: f64, z: f64, f: F) {
        self.colliders.near(x, z, f);
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlayerState {
    /// Feet position.
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub vx: f64,
    pub vy: f64,
    pub vz: f64,
    pub on_ground: bool,
    /// View direction: yaw around +y (0 = looking toward -z), pitch up/down.
    pub yaw: f64,
    pub pitch: f64,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Input {
    pub forward: f64, // -1..1
    pub right: f64,   // -1..1
    pub run: bool,
    pub jump: bool,
}

#[derive(Default)]
pub struct Physics {
    acc: f64,
}

impl Physics {
    pub fn new() -> Self {
        Physics { acc: 0.0 }
    }

    /// Can the player stand at (x, z)? (loaded, inside the world, dry land)
    pub fn walkable<G: Ground>(&self, g: &G, x: f64, z: f64) -> bool {
        g.in_bounds(x, z) && g.height(x, z).is_finite() && !g.is_water(x, z)
    }

    /// A dry, gentle spot near (x, z) to start from.
    pub fn spawn<G: Ground>(&self, g: &G, x: f64, z: f64, yaw: f64) -> PlayerState {
        for r in 0..60 {
            for k in 0..16 {
                let a = (f64::from(k) / 16.0) * std::f64::consts::PI * 2.0;
                let px = x + f64::from(r) * a.cos();
                let pz = z + f64::from(r) * a.sin();
                if self.walkable(g, px, pz) && !self.blocked(g, px, pz) {
                    return PlayerState { x: px, y: g.height(px, pz), z: pz, on_ground: true, yaw, pitch: -0.1, ..Default::default() };
                }
            }
        }
        let h = g.height(x, z);
        PlayerState { x, y: if h.is_finite() { h } else { 0.0 }, z, on_ground: true, yaw, pitch: -0.1, ..Default::default() }
    }

    fn blocked<G: Ground>(&self, g: &G, x: f64, z: f64) -> bool {
        let mut hit = false;
        g.colliders_near(x, z, |cx, cz, r, _| {
            if (x - cx).hypot(z - cz) < r + PLAYER_RADIUS {
                hit = true;
            }
        });
        hit
    }

    /// Advance by `dt` seconds of real time, in fixed sub-steps.
    pub fn update<G: Ground>(&mut self, g: &G, s: &mut PlayerState, input: Input, dt: f64) {
        self.acc += dt.min(0.25);
        while self.acc >= DT {
            self.step(g, s, input, DT);
            self.acc -= DT;
        }
    }

    pub fn step<G: Ground>(&self, g: &G, s: &mut PlayerState, input: Input, dt: f64) {
        // Wish direction from the view yaw (forward = -z at yaw 0).
        let (fx, fz) = (-s.yaw.sin(), -s.yaw.cos());
        let (rx, rz) = (s.yaw.cos(), -s.yaw.sin());
        let mut wx = fx * input.forward + rx * input.right;
        let mut wz = fz * input.forward + rz * input.right;
        let wl = wx.hypot(wz);
        if wl > 1.0 {
            wx /= wl;
            wz /= wl;
        }
        let speed = if input.run { RUN } else { WALK };
        let a = ((if s.on_ground { ACCEL_GROUND } else { ACCEL_AIR }) * dt).min(1.0);
        s.vx += (wx * speed - s.vx) * a;
        s.vz += (wz * speed - s.vz) * a;
        if input.jump && s.on_ground {
            s.vy = JUMP;
            s.on_ground = false;
        }
        s.vy -= GRAVITY * dt;

        // Horizontal move, axis by axis so you slide along what blocks you.
        self.move_axis(g, s, s.vx * dt, 0.0);
        self.move_axis(g, s, 0.0, s.vz * dt);
        self.push_out(g, s);

        // Vertical: fall, land on the ground, never below it.
        let gh = g.height(s.x, s.z);
        if !gh.is_finite() {
            s.vy = 0.0; // the ground here isn't loaded yet: hold still
            return;
        }
        s.y += s.vy * dt;
        if s.y <= gh {
            s.y = gh;
            s.vy = 0.0;
            s.on_ground = true;
        } else if s.on_ground && s.y - gh < STEP && s.vy <= 0.0 {
            s.y = gh; // walking downhill: stay stuck to the ground
            s.vy = 0.0;
        } else {
            s.on_ground = false;
        }
    }

    fn move_axis<G: Ground>(&self, g: &G, s: &mut PlayerState, dx: f64, dz: f64) {
        if dx == 0.0 && dz == 0.0 {
            return;
        }
        let (nx, nz) = (s.x + dx, s.z + dz);
        if !self.walkable(g, nx, nz) {
            if dx != 0.0 {
                s.vx = 0.0;
            }
            if dz != 0.0 {
                s.vz = 0.0;
            }
            return;
        }
        // Slope limit: only when on the ground and going up.
        if s.on_ground {
            let rise = g.height(nx, nz) - s.y.max(g.height(s.x, s.z));
            let run = dx.hypot(dz);
            if rise > STEP * 0.2 && rise > run * MAX_SLOPE {
                if dx != 0.0 {
                    s.vx = 0.0;
                }
                if dz != 0.0 {
                    s.vz = 0.0;
                }
                return;
            }
        }
        s.x = nx;
        s.z = nz;
    }

    /// Push the player out of trunks and rocks (unless standing on top).
    fn push_out<G: Ground>(&self, g: &G, s: &mut PlayerState) {
        let (px, pz) = (s.x, s.z);
        g.colliders_near(px, pz, |cx, cz, r, top| {
            if s.y > top {
                return; // above a low rock: no collision
            }
            let (dx, dz) = (s.x - cx, s.z - cz);
            let d = dx.hypot(dz);
            let min = r + PLAYER_RADIUS;
            if d < min && d > 1e-6 {
                let k = (min - d) / d;
                s.x += dx * k;
                s.z += dz * k;
                // Remove the velocity going into the obstacle.
                let (nx, nz) = (dx / d, dz / d);
                let vn = s.vx * nx + s.vz * nz;
                if vn < 0.0 {
                    s.vx -= vn * nx;
                    s.vz -= vn * nz;
                }
            }
        });
    }
}
