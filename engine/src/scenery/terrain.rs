//! Procedural terrain (port of `scenery/terrain.py`) plus trails and streams.
//!
//! A square heightfield (320 m, 513 x 513). The default camera sits near the
//! +z edge looking toward -z; each preset puts gentle ground in front, varied
//! ground in the middle and mountains along the far edge.
//!
//! * presets: flat, hills (with a pond), valley (lake on the floor), lake,
//!   rocky; domain-warped fBm and ridged mountains
//! * droplet hydraulic erosion, then a thermal pass
//! * a lake: flood fill from the lake's seed below the water level, plus a
//!   distance-to-water field for beaches
//! * new here: a stream that runs downhill into the lake in a carved channel
//!   (least-cost path that refuses to climb), and footpaths: least-cost
//!   routes over gentle slopes, wiggled and worn slightly into the ground
use crate::fm;

use super::asset::{smoothstep, unit, RngExt};
use super::perlin::Perlin;
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, VecDeque};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerrainPreset {
    Flat,
    Hills,
    Valley,
    Lake,
    Rocky,
}

/// Flowing water along a carved channel.
#[derive(Clone, Debug)]
pub struct Stream {
    /// Water surface points, source to mouth, about 0.5 m apart.
    pub pts: Vec<Vec3>,
    pub width: f32,
}

pub struct Terrain {
    pub n: usize,
    pub size: f32,
    pub res: f32,
    pub half: f32,
    /// Heights, row-major: index = iz * n + ix.
    pub h: Vec<f32>,
    pub water: Option<f32>,
    pub water_seed: (f32, f32),
    mask: Vec<u8>,
    shore: Vec<f32>,
    /// Footpath strength per cell (0..1).
    trail: Vec<f32>,
    /// Stream strength per cell (0..1, 1 = in the water).
    stream_mask: Vec<f32>,
    pub streams: Vec<Stream>,
    pub trails: Vec<Vec<Vec3>>,
    pub noise: Perlin,
    pub hmax: f32,
}

impl Terrain {
    pub fn new(seed: u32, preset: TerrainPreset) -> Terrain {
        Self::with_size(seed, preset, 320.0, 513, true)
    }

    pub fn with_size(seed: u32, preset: TerrainPreset, size: f32, n: usize, erosion: bool) -> Terrain {
        let noise = Perlin::new(seed as u64 * 7 + 3);
        let mut rng = Pcg32::new(seed as u64 + 101, 0x7e44);
        let half = size / 2.0;
        let res = size / (n - 1) as f32;
        let mut t = Terrain {
            n, size, res, half, h: vec![0.0; n * n], water: None, water_seed: (0.0, 0.0), mask: Vec::new(),
            shore: Vec::new(), trail: vec![0.0; n * n], stream_mask: vec![0.0; n * n], streams: Vec::new(),
            trails: Vec::new(), noise, hmax: 0.0,
        };
        // Preset heights.
        let mut water_offset = None;
        if preset == TerrainPreset::Hills {
            let pond = (rng.uniform(-35.0, 35.0), rng.uniform(10.0, 60.0), rng.uniform(13.0, 20.0));
            t.water_seed = (pond.0, pond.1);
            water_offset = Some(1.7);
            t.fill(|t, x, z| t.hills(x, z) - 4.5 * fm::exp(-((x - pond.0).powi(2) + (z - pond.1).powi(2)) / pond.2.powi(2)));
        } else {
            match preset {
                TerrainPreset::Flat => t.fill(|t, x, z| 0.03 * t.noise.fbm(x / 3.0, z / 3.0, 0.5, 3)),
                TerrainPreset::Valley => {
                    let lz = -15.0;
                    let lx = 12.0 * t.noise.fbm(lz / 120.0, 0.3, 0.7, 3);
                    t.water_seed = (lx, lz);
                    water_offset = Some(2.2);
                    t.fill(move |t, x, z| t.valley(x, z) - 5.0 * fm::exp(-((x - lx).powi(2) / 900.0 + (z - lz).powi(2) / 2025.0)));
                }
                TerrainPreset::Lake => {
                    t.water_seed = (0.0, -15.0);
                    water_offset = Some(3.2);
                    t.fill(|t, x, z| t.lake(x, z));
                }
                TerrainPreset::Rocky => t.fill(|t, x, z| t.rocky(x, z)),
                TerrainPreset::Hills => unreachable!(),
            }
        }
        if erosion && preset != TerrainPreset::Flat {
            t.hydraulic_erosion(&mut rng, 140_000);
            t.thermal(0.9, 25);
        }
        if let Some(off) = water_offset {
            let level = t.height(t.water_seed.0, t.water_seed.1) + off;
            t.set_water(level);
        }
        if t.water.is_some() {
            t.carve_stream(&mut rng);
        }
        if preset != TerrainPreset::Flat {
            t.carve_trails(&mut rng);
        }
        t.hmax = t.h.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        t
    }

    fn coord(&self, i: usize) -> f32 {
        -self.half + i as f32 * self.res
    }

    fn fill(&mut self, f: impl Fn(&Terrain, f32, f32) -> f32) {
        let mut h = vec![0.0; self.n * self.n];
        for iz in 0..self.n {
            for ix in 0..self.n {
                h[iz * self.n + ix] = f(self, self.coord(ix), self.coord(iz));
            }
        }
        self.h = h;
    }

    // ---- presets ----------------------------------------------------------------
    fn warp(&self, x: f32, z: f32, s: f32, amp: f32) -> (f32, f32) {
        let n = &self.noise;
        (x + amp * n.fbm(x / s, z / s, 1.3, 3), z + amp * n.fbm(x / s + 40.0, z / s - 20.0, 2.1, 3))
    }

    fn mountains(&self, x: f32, z: f32, height: f32, start: f32, full: f32) -> f32 {
        let (wx, wz) = self.warp(x, z, 90.0, 30.0);
        height * fm::powf(self.noise.ridged(wx / 130.0, wz / 130.0, 6), 1.4) * smoothstep(start, full, z)
    }

    fn hills(&self, x: f32, z: f32) -> f32 {
        let n = &self.noise;
        let (wx, wz) = self.warp(x, z, 60.0, 15.0);
        let mut h = 9.0 * n.fbm(wx / 85.0, wz / 85.0, 0.1, 5) + 2.5 * n.fbm(wx / 22.0, wz / 22.0, 4.0, 4);
        h *= 1.0 - 0.65 * smoothstep(55.0, 125.0, z); // calm foreground
        h + self.mountains(x, z, 70.0, 40.0, -110.0)
    }

    fn valley(&self, x: f32, z: f32) -> f32 {
        let n = &self.noise;
        let (wx, wz) = self.warp(x, z, 50.0, 18.0);
        let center = 12.0 * n.fbm(z / 120.0, 0.3, 0.7, 3);
        let dx = (wx - center).abs();
        let mut h = 26.0 * fm::powf(smoothstep(14.0, 95.0, dx), 1.3) + 4.0 * n.fbm(wx / 30.0, wz / 30.0, 3.0, 5);
        h += 4.0 * smoothstep(-30.0, 130.0, z);
        h + self.mountains(x, z, 95.0, 10.0, -120.0)
    }

    fn lake(&self, x: f32, z: f32) -> f32 {
        let n = &self.noise;
        let (wx, wz) = self.warp(x, z, 70.0, 20.0);
        let mut h = 7.0 * n.fbm(wx / 70.0, wz / 70.0, 0.2, 5) + 2.0 * n.fbm(wx / 20.0, wz / 20.0, 5.0, 4);
        let rr = fm::hypot(wx / 1.6, wz + 15.0);
        h += 9.0 * smoothstep(30.0, 75.0, rr) - 4.0;
        h *= 1.0 - 0.5 * smoothstep(70.0, 125.0, z);
        h + self.mountains(x, z, 60.0, 0.0, -120.0)
    }

    fn rocky(&self, x: f32, z: f32) -> f32 {
        let n = &self.noise;
        let (wx, wz) = self.warp(x, z, 40.0, 12.0);
        let mut h = 22.0 * fm::powf(n.ridged(wx / 55.0, wz / 55.0, 5), 1.6) + 3.0 * n.fbm(wx / 15.0, wz / 15.0, 2.0, 4);
        h *= 0.35 + 0.65 * smoothstep(110.0, 40.0, z);
        h + self.mountains(x, z, 80.0, 20.0, -110.0)
    }

    // ---- erosion ------------------------------------------------------------------
    fn sample(&self, x: f32, y: f32) -> f32 {
        let n = self.n;
        let (ix, iy) = (x as usize, y as usize);
        let (fx, fy) = (x - ix as f32, y - iy as f32);
        let h = &self.h;
        (h[iy * n + ix] * (1.0 - fx) + h[iy * n + ix + 1] * fx) * (1.0 - fy) + (h[(iy + 1) * n + ix] * (1.0 - fx) + h[(iy + 1) * n + ix + 1] * fx) * fy
    }

    /// Droplets that pick up sediment where they speed up and drop it where
    /// they slow down: gullies on slopes, smooth valley floors.
    fn hydraulic_erosion(&mut self, rng: &mut Pcg32, drops: usize) {
        let (inertia, capacity, min_slope, erode, deposit, evaporate, gravity) = (0.08, 3.0, 0.02, 0.25, 0.25, 0.025, 4.0);
        let n = self.n;
        let lim = (n - 2) as f32;
        for _ in 0..drops {
            let (mut x, mut y) = (rng.uniform(1.0, lim), rng.uniform(1.0, lim));
            let (mut dx, mut dy) = (0.0f32, 0.0f32);
            let (mut vel, mut water, mut sed) = (1.0f32, 1.0f32, 0.0f32);
            for _ in 0..45 {
                let (ix, iy) = (x as usize, y as usize);
                let (fx, fy) = (x - ix as f32, y - iy as f32);
                let h = &self.h;
                let (h00, h10, h01, h11) = (h[iy * n + ix], h[iy * n + ix + 1], h[(iy + 1) * n + ix], h[(iy + 1) * n + ix + 1]);
                let gx = ((h10 - h00) * (1.0 - fy) + (h11 - h01) * fy) / self.res;
                let gy = ((h01 - h00) * (1.0 - fx) + (h11 - h10) * fx) / self.res;
                let hc = (h00 * (1.0 - fx) + h10 * fx) * (1.0 - fy) + (h01 * (1.0 - fx) + h11 * fx) * fy;
                dx = dx * inertia - gx * (1.0 - inertia);
                dy = dy * inertia - gy * (1.0 - inertia);
                let ln = fm::hypot(dx, dy);
                if ln < 1e-9 {
                    let a = rng.uniform(0.0, std::f32::consts::TAU);
                    (dx, dy) = (fm::cos(a), fm::sin(a));
                } else {
                    (dx, dy) = (dx / ln, dy / ln);
                }
                let (nx, ny) = (x + dx, y + dy);
                if !(nx >= 1.0 && nx < lim && ny >= 1.0 && ny < lim) {
                    break;
                }
                let hn = self.sample(nx, ny);
                let dh = hn - hc;
                let cap = (-dh).max(min_slope) * vel * water * capacity;
                let amt = if sed > cap || dh > 0.0 {
                    if dh > 0.0 { dh.min(sed) } else { (sed - cap) * deposit }
                } else {
                    -((cap - sed) * erode).min((-dh).max(0.0)).min(0.25)
                };
                sed -= amt;
                let h = &mut self.h;
                h[iy * n + ix] += amt * (1.0 - fx) * (1.0 - fy);
                h[iy * n + ix + 1] += amt * fx * (1.0 - fy);
                h[(iy + 1) * n + ix] += amt * (1.0 - fx) * fy;
                h[(iy + 1) * n + ix + 1] += amt * fx * fy;
                vel = (vel * vel - dh * gravity).max(0.01).sqrt();
                water *= 1.0 - evaporate;
                (x, y) = (nx, ny);
            }
        }
        blur2(&mut self.h, n, 0.6);
    }

    /// Move material down slopes steeper than `talus` (rise over run).
    fn thermal(&mut self, talus: f32, iters: usize) {
        let n = self.n;
        let lim = talus * self.res;
        for _ in 0..iters {
            for (ddx, ddz) in [(1isize, 0isize), (-1, 0), (0, 1), (0, -1)] {
                let src = self.h.clone();
                for iz in 1..n - 1 {
                    for ix in 1..n - 1 {
                        let (jx, jz) = ((ix as isize - ddx) as usize, (iz as isize - ddz) as usize);
                        let diff = src[iz * n + ix] - src[jz * n + jx] - lim;
                        if diff > 0.0 {
                            let mv = diff * 0.15;
                            self.h[iz * n + ix] -= mv;
                            self.h[jz * n + jx] += mv;
                        }
                    }
                }
            }
        }
    }

    // ---- water ----------------------------------------------------------------------
    fn cell_of(&self, x: f32, z: f32) -> (usize, usize) {
        let f = |v: f32| (((v + self.half) / self.res).round() as isize).clamp(0, self.n as isize - 1) as usize;
        (f(x), f(z))
    }

    fn set_water(&mut self, level: f32) {
        let n = self.n;
        let (sx, sz) = self.cell_of(self.water_seed.0, self.water_seed.1);
        if self.h[sz * n + sx] >= level {
            return;
        }
        let mut mask = vec![0u8; n * n];
        let mut q = VecDeque::from([(sx, sz)]);
        mask[sz * n + sx] = 1;
        while let Some((x, z)) = q.pop_front() {
            for (dx, dz) in [(1isize, 0isize), (-1, 0), (0, 1), (0, -1)] {
                let (nx, nz) = (x as isize + dx, z as isize + dz);
                if nx < 0 || nz < 0 || nx >= n as isize || nz >= n as isize {
                    continue;
                }
                let i = nz as usize * n + nx as usize;
                if mask[i] == 0 && self.h[i] < level {
                    mask[i] = 1;
                    q.push_back((nx as usize, nz as usize));
                }
            }
        }
        // Distance to the water (two-pass chamfer, metres), for beaches.
        let big = 1e9f32;
        let mut d: Vec<f32> = mask.iter().map(|&m| if m == 1 { 0.0 } else { big }).collect();
        let (a, b) = (self.res, self.res * std::f32::consts::SQRT_2);
        for iz in 0..n {
            for ix in 0..n {
                let i = iz * n + ix;
                let mut v = d[i];
                if ix > 0 { v = v.min(d[i - 1] + a); }
                if iz > 0 {
                    v = v.min(d[i - n] + a);
                    if ix > 0 { v = v.min(d[i - n - 1] + b); }
                    if ix + 1 < n { v = v.min(d[i - n + 1] + b); }
                }
                d[i] = v;
            }
        }
        for iz in (0..n).rev() {
            for ix in (0..n).rev() {
                let i = iz * n + ix;
                let mut v = d[i];
                if ix + 1 < n { v = v.min(d[i + 1] + a); }
                if iz + 1 < n {
                    v = v.min(d[i + n] + a);
                    if ix + 1 < n { v = v.min(d[i + n + 1] + b); }
                    if ix > 0 { v = v.min(d[i + n - 1] + b); }
                }
                d[i] = v;
            }
        }
        self.water = Some(level);
        self.mask = mask;
        self.shore = d;
    }

    // ---- paths ------------------------------------------------------------------------
    /// Least-cost route on a coarse grid (cell `step` metres). `cost(from, to)`
    /// returns the cost of one move or None if it is not allowed; the search
    /// ends at the first cell for which `goal` is true.
    fn route(&self, start: (f32, f32), step: f32, cost: impl Fn(Vec3, Vec3) -> Option<f32>, goal: impl Fn(Vec3) -> bool) -> Option<Vec<Vec3>> {
        let m = (self.size / step) as usize + 1;
        let at = |i: usize, j: usize| {
            let (x, z) = (-self.half + i as f32 * step, -self.half + j as f32 * step);
            Vec3::new(x, self.height(x, z), z)
        };
        let idx = |i: usize, j: usize| j * m + i;
        let si = (((start.0 + self.half) / step).round() as usize).min(m - 1);
        let sj = (((start.1 + self.half) / step).round() as usize).min(m - 1);
        let mut dist = vec![f32::INFINITY; m * m];
        let mut prev = vec![usize::MAX; m * m];
        #[derive(PartialEq)]
        struct Node(f32, usize);
        impl Eq for Node {}
        impl PartialOrd for Node {
            fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
                Some(self.cmp(o))
            }
        }
        impl Ord for Node {
            fn cmp(&self, o: &Self) -> Ordering {
                o.0.total_cmp(&self.0)
            }
        }
        let mut heap = BinaryHeap::new();
        dist[idx(si, sj)] = 0.0;
        heap.push(Node(0.0, idx(si, sj)));
        let mut found = None;
        while let Some(Node(d, u)) = heap.pop() {
            if d > dist[u] {
                continue;
            }
            let (ui, uj) = (u % m, u / m);
            let pu = at(ui, uj);
            if u != idx(si, sj) && goal(pu) {
                found = Some(u);
                break;
            }
            for (di, dj) in [(1isize, 0isize), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1)] {
                let (vi, vj) = (ui as isize + di, uj as isize + dj);
                if vi < 1 || vj < 1 || vi >= m as isize - 1 || vj >= m as isize - 1 {
                    continue;
                }
                let v = idx(vi as usize, vj as usize);
                if let Some(c) = cost(pu, at(vi as usize, vj as usize)) {
                    let nd = d + c;
                    if nd < dist[v] {
                        dist[v] = nd;
                        prev[v] = u;
                        heap.push(Node(nd, v));
                    }
                }
            }
        }
        let mut u = found?;
        let mut path = Vec::new();
        while u != usize::MAX {
            path.push(at(u % m, u / m));
            u = prev[u];
        }
        path.reverse();
        Some(path)
    }

    /// Chaikin smoothing, then resample every `spacing` metres.
    fn smooth_path(pts: &[Vec3], spacing: f32) -> Vec<Vec3> {
        let mut p = pts.to_vec();
        for _ in 0..3 {
            if p.len() < 3 {
                break;
            }
            let mut q = vec![p[0]];
            for w in p.windows(2) {
                q.push(w[0] * 0.75 + w[1] * 0.25);
                q.push(w[0] * 0.25 + w[1] * 0.75);
            }
            q.push(p[p.len() - 1]);
            p = q;
        }
        let mut out = vec![p[0]];
        let mut carry = 0.0;
        for w in p.windows(2) {
            let seg = w[1] - w[0];
            let len = seg.length();
            let mut s = spacing - carry;
            while s <= len {
                out.push(w[0] + seg * (s / len.max(1e-6)));
                s += spacing;
            }
            carry = len - (s - spacing);
        }
        out
    }

    /// Lower the ground along a path and record its strength in `field`.
    fn carve(&mut self, pts: &[Vec3], half_width: f32, depth: f32, which: u8) {
        let n = self.n;
        let reach = half_width + self.res * 2.0;
        let r = (reach / self.res).ceil() as isize;
        let mut strength = vec![0.0f32; n * n];
        for p in pts {
            let (cx, cz) = self.cell_of(p.x, p.z);
            for dz in -r..=r {
                for dx in -r..=r {
                    let (ix, iz) = (cx as isize + dx, cz as isize + dz);
                    if ix < 0 || iz < 0 || ix >= n as isize || iz >= n as isize {
                        continue;
                    }
                    let (ix, iz) = (ix as usize, iz as usize);
                    let d = fm::hypot(self.coord(ix) - p.x, self.coord(iz) - p.z);
                    let s = smoothstep(reach, half_width * 0.4, d);
                    let i = iz * n + ix;
                    strength[i] = strength[i].max(s);
                }
            }
        }
        for (i, &s) in strength.iter().enumerate() {
            if s <= 0.0 || (self.mask.get(i) == Some(&1)) {
                continue;
            }
            self.h[i] -= depth * s;
            let f = if which == 0 { &mut self.trail } else { &mut self.stream_mask };
            f[i] = f[i].max(s);
        }
    }

    /// A stream from higher ground down into the lake.
    fn carve_stream(&mut self, rng: &mut Pcg32) {
        let Some(level) = self.water else { return };
        let (wx, wz) = self.water_seed;
        // Source: well above the water, 60-130 m away, off the camera axis.
        let mut best: Option<(f32, f32, f32)> = None;
        for _ in 0..400 {
            let a = rng.uniform(0.0, std::f32::consts::TAU);
            let r = rng.uniform(60.0, 130.0);
            let (x, z) = (wx + r * fm::cos(a), wz + r * fm::sin(a));
            if x.abs() > self.half - 20.0 || z.abs() > self.half - 20.0 || z > self.half - 60.0 {
                continue;
            }
            let h = self.height(x, z);
            let rise = h - level;
            if !(6.0..35.0).contains(&rise) {
                continue;
            }
            let score = -(rise - 15.0).abs() + 0.2 * x.abs().min(60.0);
            if best.is_none_or(|b| score > b.2) {
                best = Some((x, z, score));
            }
        }
        let Some((sx, sz, _)) = best else { return };
        let step = 2.5;
        let water = |p: Vec3| self.is_water(p.x, p.z);
        // Water may not climb: an uphill step costs a lot, a steep drop a little.
        let path = self.route(
            (sx, sz),
            step,
            |a, b| {
                let d = (b - a).length();
                let up = (b.y - a.y).max(0.0);
                Some(d * (1.0 + 0.3 * ((b.y - a.y).abs() / d)) + 80.0 * up)
            },
            water,
        );
        let Some(path) = path else { return };
        if path.len() < 8 {
            return;
        }
        let mut pts = Self::smooth_path(&path, 0.5);
        // Gentle meanders.
        let k = rng.uniform(0.0, 100.0);
        let n0 = pts.len();
        for i in 1..n0.saturating_sub(1) {
            let t = unit(pts[i + 1] - pts[i - 1]);
            let side = Vec3::new(-t.z, 0.0, t.x);
            let s = i as f32 * 0.5;
            let fade = smoothstep(0.0, 10.0, s) * smoothstep(0.0, 6.0, (n0 - i) as f32 * 0.5);
            pts[i] += side * (2.0 * self.noise.fbm(s / 25.0 + k, 3.3, 0.7, 2) * fade);
        }
        let width = 1.8;
        self.carve(&pts, width * 0.5, 0.45, 1);
        // Water surface: just above the carved bed, never below the lake.
        let mut surface: Vec<Vec3> = pts
            .iter()
            .map(|p| Vec3::new(p.x, (self.height(p.x, p.z) + 0.12).max(level), p.z))
            .collect();
        // Water never flows uphill: clamp to a running minimum from the source.
        for i in 1..surface.len() {
            surface[i].y = surface[i].y.min(surface[i - 1].y);
        }
        let end = surface.iter().position(|p| self.is_water(p.x, p.z)).unwrap_or(surface.len());
        surface.truncate(end + 1);
        self.streams.push(Stream { pts: surface, width });
    }

    /// Footpaths: from the foreground, over gentle slopes, to the shore or
    /// into the distance; a second one branches off sideways.
    fn carve_trails(&mut self, rng: &mut Pcg32) {
        let step = 2.5;
        let cam_z = self.half - 40.0;
        let k = rng.uniform(0.0, 50.0);
        let start = (rng.uniform(-12.0, 12.0), cam_z + 12.0);
        let goal_pt = match self.water {
            Some(_) => {
                let (wx, wz) = self.water_seed;
                (wx + rng.uniform(-25.0, 25.0), wz + 25.0)
            }
            None => (rng.uniform(-60.0, 60.0), rng.uniform(-90.0, -50.0)),
        };
        let walk_cost = |a: Vec3, b: Vec3| -> Option<f32> {
            if self.is_water(b.x, b.z) || self.stream_strength(b.x, b.z) > 0.5 {
                return None;
            }
            let d = (b - a).length();
            let slope = (b.y - a.y).abs() / d.max(1e-3);
            let wiggle = 0.6 + 0.4 * self.noise.fbm(b.x / 25.0 + k, b.z / 25.0, 9.1, 2);
            Some(d * (wiggle + 30.0 * slope * slope))
        };
        let near = |p: Vec3, g: (f32, f32)| fm::hypot(p.x - g.0, p.z - g.1) < step * 1.5 || self.shore_dist(p.x, p.z) < 3.0;
        let Some(path) = self.route(start, step, walk_cost, |p| near(p, goal_pt)) else { return };
        let main = Self::smooth_path(&path, 0.5);
        // Branch: from a third of the way along, off to one side.
        let mut branch = None;
        if main.len() > 30 {
            let b = main[main.len() / 3];
            let side = if rng.chance(0.5) { -1.0 } else { 1.0 };
            let target = (b.x + side * rng.uniform(45.0, 80.0), b.z - rng.uniform(10.0, 40.0));
            let target = (target.0.clamp(-self.half + 20.0, self.half - 20.0), target.1.clamp(-self.half + 20.0, self.half - 20.0));
            branch = self
                .route((b.x, b.z), step, walk_cost, |p| fm::hypot(p.x - target.0, p.z - target.1) < step * 1.5)
                .map(|p2| Self::smooth_path(&p2, 0.5));
        }
        self.carve(&main, 0.6, 0.12, 0);
        self.trails.push(main);
        if let Some(q) = branch {
            self.carve(&q, 0.5, 0.1, 0);
            self.trails.push(q);
        }
    }

    // ---- queries ------------------------------------------------------------------------
    fn grid(&self, g: &[f32], x: f32, z: f32) -> f32 {
        let n = self.n;
        let fx = ((x + self.half) / self.res).clamp(0.0, n as f32 - 1.001);
        let fz = ((z + self.half) / self.res).clamp(0.0, n as f32 - 1.001);
        let (ix, iz) = (fx as usize, fz as usize);
        let (tx, tz) = (fx - ix as f32, fz - iz as f32);
        (g[iz * n + ix] * (1.0 - tx) + g[iz * n + ix + 1] * tx) * (1.0 - tz) + (g[(iz + 1) * n + ix] * (1.0 - tx) + g[(iz + 1) * n + ix + 1] * tx) * tz
    }

    pub fn height(&self, x: f32, z: f32) -> f32 {
        self.grid(&self.h, x, z)
    }

    pub fn normal(&self, x: f32, z: f32) -> Vec3 {
        let e = self.res;
        let hx = self.height(x + e, z) - self.height(x - e, z);
        let hz = self.height(x, z + e) - self.height(x, z - e);
        unit(Vec3::new(-hx, 2.0 * e, -hz))
    }

    /// Lake mask on the height grid (1 = water), empty without a lake.
    pub fn water_mask(&self) -> &[u8] {
        &self.mask
    }

    pub fn is_water(&self, x: f32, z: f32) -> bool {
        if self.mask.is_empty() {
            return false;
        }
        let (ix, iz) = self.cell_of(x, z);
        self.mask[iz * self.n + ix] == 1
    }

    pub fn shore_dist(&self, x: f32, z: f32) -> f32 {
        if self.shore.is_empty() {
            return 1e9;
        }
        self.grid(&self.shore, x, z)
    }

    pub fn trail_strength(&self, x: f32, z: f32) -> f32 {
        self.grid(&self.trail, x, z)
    }

    pub fn stream_strength(&self, x: f32, z: f32) -> f32 {
        self.grid(&self.stream_mask, x, z)
    }

    pub fn inside(&self, x: f32, z: f32) -> bool {
        x.abs() < self.half - 1.0 && z.abs() < self.half - 1.0
    }

    /// 1 where the sun is visible over the heightfield, 0 in a hill's shadow.
    pub fn sun_visibility(&self, p: Vec3, sun: Vec3) -> f32 {
        let mut vis = 1.0f32;
        for t in [0.6, 1.2, 2.2, 3.5, 5.5, 8.0, 12.0, 18.0, 27.0, 40.0, 60.0, 90.0, 135.0, 200.0] {
            let q = p + sun * t;
            if !self.inside(q.x, q.z) {
                break;
            }
            let h = self.height(q.x, q.z);
            vis = vis.min(smoothstep(-0.15 - 0.02 * t, 0.15 + 0.02 * t, q.y - h));
            if vis <= 0.0 {
                break;
            }
        }
        vis
    }

    /// Coarse triangle mesh of the ground (opaque body), cell `step` metres.
    pub fn body(&self, step: f32, sink: f32) -> Vec<[Vec3; 3]> {
        let m = (self.size / step) as usize;
        let at = |i: usize, j: usize| {
            let (x, z) = (-self.half + i as f32 * step, -self.half + j as f32 * step);
            Vec3::new(x, self.height(x, z) - sink, z)
        };
        let mut out = Vec::with_capacity(m * m * 2);
        for j in 0..m {
            for i in 0..m {
                let (a, b, c, d) = (at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
                out.push([a, d, c]);
                out.push([a, c, b]);
            }
        }
        out
    }
}

/// Separable Gaussian blur of an n x n grid (edges clamped).
fn blur2(g: &mut [f32], n: usize, sigma: f32) {
    let rad = (3.0 * sigma).ceil() as isize;
    let mut k: Vec<f32> = (-rad..=rad).map(|i| fm::exp(-(i * i) as f32 / (2.0 * sigma * sigma))).collect();
    let s: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= s);
    let mut tmp = vec![0.0f32; n * n];
    for y in 0..n {
        for x in 0..n {
            tmp[y * n + x] = (-rad..=rad).zip(&k).map(|(o, w)| w * g[y * n + (x as isize + o).clamp(0, n as isize - 1) as usize]).sum();
        }
    }
    for y in 0..n {
        for x in 0..n {
            g[y * n + x] = (-rad..=rad).zip(&k).map(|(o, w)| w * tmp[(y as isize + o).clamp(0, n as isize - 1) as usize * n + x]).sum();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_build_with_sane_heights_and_water() {
        for (preset, wet) in [(TerrainPreset::Hills, true), (TerrainPreset::Valley, true), (TerrainPreset::Lake, true), (TerrainPreset::Rocky, false)] {
            let t = Terrain::new(1, preset);
            assert!(t.h.iter().all(|v| v.is_finite()), "{preset:?}");
            assert!(t.hmax > 20.0 && t.hmax < 200.0, "{preset:?} max height {}", t.hmax);
            assert_eq!(t.water.is_some(), wet, "{preset:?} water");
            if let Some(level) = t.water {
                let (wx, wz) = t.water_seed;
                assert!(t.is_water(wx, wz) && t.height(wx, wz) < level);
                assert!(t.shore_dist(wx, wz) == 0.0 && t.shore_dist(0.0, t.half - 30.0) > 0.0);
            }
        }
    }

    #[test]
    fn streams_flow_downhill_into_the_lake() {
        for seed in 1..=4 {
            let t = Terrain::new(seed, TerrainPreset::Lake);
            assert_eq!(t.streams.len(), 1, "seed {seed}: no stream");
            let s = &t.streams[0];
            assert!(s.pts.len() > 60, "seed {seed}: stream only {} points", s.pts.len());
            assert!(s.pts.windows(2).all(|w| w[1].y <= w[0].y + 1e-4), "water never climbs");
            let last = s.pts[s.pts.len() - 1];
            assert!(t.is_water(last.x, last.z), "seed {seed}: stream ends in the lake");
            assert!(s.pts[0].y > t.water.unwrap() + 3.0, "starts well above the lake");
        }
    }

    #[test]
    fn trails_are_walkable_and_worn_in() {
        for (seed, preset) in [(1, TerrainPreset::Hills), (2, TerrainPreset::Lake), (3, TerrainPreset::Rocky)] {
            let t = Terrain::new(seed, preset);
            assert!(!t.trails.is_empty(), "{preset:?}: no trail");
            let main = &t.trails[0];
            assert!(main.len() > 40, "{preset:?}: trail {} points", main.len());
            for p in main {
                assert!(!t.is_water(p.x, p.z), "trails stay out of the water");
                assert!(t.trail_strength(p.x, p.z) > 0.5);
            }
            // Gentle: average slope along the trail is low.
            let slope: f32 = main.windows(2).map(|w| (t.height(w[1].x, w[1].z) - t.height(w[0].x, w[0].z)).abs() / 0.5).sum::<f32>() / (main.len() - 1) as f32;
            assert!(slope < 0.25, "{preset:?}: trail too steep ({slope})");
        }
    }

    #[test]
    fn sun_shadow_behind_a_mountain() {
        let t = Terrain::new(1, TerrainPreset::Rocky);
        let sun = unit(Vec3::new(-0.75, 0.15, 0.45));
        let vis: Vec<f32> = (0..400)
            .map(|i| {
                let (x, z) = (-120.0 + (i % 20) as f32 * 12.0, -120.0 + (i / 20) as f32 * 12.0);
                t.sun_visibility(Vec3::new(x, t.height(x, z) + 0.1, z), sun)
            })
            .collect();
        assert!(vis.iter().any(|&v| v < 0.2) && vis.iter().any(|&v| v > 0.9));
    }
}
