//! Streams the infinite world around the viewer: requests chunks nearest
//! first, drops chunks that fall out of range, and rebuilds a chunk when the
//! viewer has moved enough that its glyph sizes are off. Port of
//! `web/src/app/world.ts`; the clock is injected.

use crate::jobs::{ChunkOut, Job, JobExecutor, JobId, JobKind};
use crate::physics::{ColliderGrid, Ground};
use crate::render_data::RenderEvent;
use glam::DVec3;
use std::collections::HashMap;

pub struct WorldInfo {
    pub chunk_size: f64,
    pub grid: usize,
    pub water: f64,
}

struct Loaded {
    cx: i32,
    cz: i32,
    eye: [f32; 3],
    heights: Vec<f32>,
    colliders: ColliderGrid,
    cards: u64,
}

#[derive(Clone, Copy)]
struct Want {
    cx: i32,
    cz: i32,
    prio: f64,
}

/// Set key of a streamed chunk: offset-binary packing of (cx, cz), so no real
/// chunk ever maps to `MAIN_SET` (that would need cx = cz = i32::MAX).
pub fn chunk_key(cx: i32, cz: i32) -> u64 {
    let off = |v: i32| (i64::from(v) - i64::from(i32::MIN)) as u64;
    (off(cx) << 32) | off(cz)
}

pub struct WorldStreamer {
    pub info: WorldInfo,
    pub seed: u32,
    pub day: bool,
    /// View distance in chunks.
    pub radius: i32,
    /// Chunk requests in flight at once: two per worker, so none sits idle.
    pub max_inflight: usize,
    pub aspect: f32,
    loaded: HashMap<(i32, i32), Loaded>,
    inflight: HashMap<(i32, i32), JobId>,
    last_check: f64,
    want: Vec<Want>,
    drop_list: Vec<(i32, i32)>,
    /// Chunks built so far.
    pub built: u32,
}

impl WorldStreamer {
    pub fn new(info: WorldInfo, seed: u32, day: bool, aspect: f32, workers: usize) -> Self {
        WorldStreamer {
            info,
            seed,
            day,
            radius: 9,
            max_inflight: workers * 2,
            aspect,
            loaded: HashMap::new(),
            inflight: HashMap::new(),
            last_check: f64::NEG_INFINITY,
            want: Vec::new(),
            drop_list: Vec::new(),
            built: 0,
        }
    }

    pub fn loaded_count(&self) -> usize {
        self.loaded.len()
    }

    /// Cards held by the loaded chunks.
    pub fn cards(&self) -> u64 {
        self.loaded.values().map(|l| l.cards).sum()
    }

    pub fn pending(&self) -> usize {
        self.inflight.len()
    }

    /// Call every frame with the viewer's position and the clock (seconds).
    pub fn update<E: JobExecutor>(&mut self, exec: &mut E, next_id: &mut JobId, events: &mut Vec<RenderEvent>, mut note: impl FnMut(JobId, i32, i32), eye: DVec3, now: f64, force: bool) {
        // Rescan at most every 150 ms, except when a worker slot is free: a
        // finished chunk is replaced at once, so the workers never sit idle
        // waiting for the next scan (the scan itself is a few microseconds).
        if !force && now - self.last_check < 0.150 && self.inflight.len() >= self.max_inflight {
            return;
        }
        self.last_check = now;
        let s = self.info.chunk_size;
        let ccx = (eye.x / s).floor() as i32;
        let ccz = (eye.z / s).floor() as i32;
        self.want.clear();
        let r = self.radius;
        for dz in -r..=r {
            for dx in -r..=r {
                if dx * dx + dz * dz > r * r + 1 {
                    continue;
                }
                let (cx, cz) = (ccx + dx, ccz + dz);
                if self.inflight.contains_key(&(cx, cz)) {
                    continue;
                }
                let centre = ((f64::from(cx) + 0.5) * s, (f64::from(cz) + 0.5) * s);
                let d_now = (eye.x - centre.0).hypot(eye.z - centre.1);
                match self.loaded.get(&(cx, cz)) {
                    None => self.want.push(Want { cx, cz, prio: d_now }),
                    Some(have) => {
                        // Rebuild when the glyph sizes chosen at build time are off by much.
                        let [bx, by, bz] = have.eye.map(f64::from);
                        let d_built = (bx - centre.0).hypot(bz - centre.1);
                        let floor = s * 1.5;
                        let ratio = d_now.max(floor) / d_built.max(floor);
                        let moved = (eye.x - bx).hypot(eye.y - by).hypot(eye.z - bz);
                        if ratio > 1.7 || ratio < 0.6 || moved > 0.6 * d_now.max(floor) {
                            self.want.push(Want { cx, cz, prio: d_now + 1000.0 });
                        }
                    }
                }
            }
        }
        // Drop chunks well out of range.
        self.drop_list.clear();
        for l in self.loaded.values() {
            if f64::from(l.cx - ccx).hypot(f64::from(l.cz - ccz)) > f64::from(self.radius + 2) {
                self.drop_list.push((l.cx, l.cz));
            }
        }
        for &(cx, cz) in &self.drop_list {
            self.loaded.remove(&(cx, cz));
            events.push(RenderEvent::RemoveCards { key: chunk_key(cx, cz) });
            events.push(RenderEvent::RemoveBody { key: chunk_key(cx, cz) });
        }
        // Stable sort: ties keep scan order, like the JS version.
        self.want.sort_by(|a, b| a.prio.total_cmp(&b.prio));
        let eye32 = [eye.x as f32, eye.y as f32, eye.z as f32];
        for i in 0..self.want.len() {
            if self.inflight.len() >= self.max_inflight {
                break;
            }
            let w = self.want[i];
            let id = *next_id;
            *next_id += 1;
            self.inflight.insert((w.cx, w.cz), id);
            note(id, w.cx, w.cz);
            exec.submit(Job { id, kind: JobKind::Chunk { seed: self.seed, day: self.day, cx: w.cx, cz: w.cz, eye: eye32, aspect: self.aspect } });
        }
    }

    /// A chunk job finished (or failed).
    pub fn on_chunk(&mut self, cx: i32, cz: i32, out: Option<Box<ChunkOut>>, events: &mut Vec<RenderEvent>) {
        self.inflight.remove(&(cx, cz));
        let Some(c) = out else { return };
        let key = chunk_key(cx, cz);
        let c = *c;
        let n_cards = (c.cards.cards.len() / crate::CARD_STRIDE) as u64;
        // Replace the old version only now, so nothing flickers out meanwhile.
        events.push(RenderEvent::SetCards { key, cards: c.cards.cards, chunks: c.cards.chunks });
        if !c.body.is_empty() {
            events.push(RenderEvent::SetBody { key, positions: c.body });
        } else {
            events.push(RenderEvent::RemoveBody { key });
        }
        self.loaded.insert((cx, cz), Loaded { cx, cz, eye: c.eye, heights: c.heights, colliders: ColliderGrid::new(c.colliders), cards: n_cards });
        self.built += 1;
    }

    /// Remove every chunk's render data (the world is going away).
    pub fn dispose(&mut self, events: &mut Vec<RenderEvent>) {
        for &(cx, cz) in self.loaded.keys() {
            events.push(RenderEvent::RemoveCards { key: chunk_key(cx, cz) });
            events.push(RenderEvent::RemoveBody { key: chunk_key(cx, cz) });
        }
        self.loaded.clear();
        self.inflight.clear();
    }

    fn chunk_at(&self, x: f64, z: f64) -> Option<&Loaded> {
        let s = self.info.chunk_size;
        self.loaded.get(&((x / s).floor() as i32, (z / s).floor() as i32))
    }
}

impl Ground for WorldStreamer {
    fn height(&self, x: f64, z: f64) -> f64 {
        let Some(l) = self.chunk_at(x, z) else { return f64::NAN };
        let s = self.info.chunk_size;
        let n = self.info.grid + 1;
        let fx = (x - f64::from(l.cx) * s).max(0.0).min(n as f64 - 1.001);
        let fz = (z - f64::from(l.cz) * s).max(0.0).min(n as f64 - 1.001);
        let (ix, iz) = (fx.floor() as usize, fz.floor() as usize);
        let (tx, tz) = (fx - ix as f64, fz - iz as f64);
        let at = |i: usize, j: usize| f64::from(l.heights[j * n + i]);
        (at(ix, iz) * (1.0 - tx) + at(ix + 1, iz) * tx) * (1.0 - tz) + (at(ix, iz + 1) * (1.0 - tx) + at(ix + 1, iz + 1) * tx) * tz
    }

    fn is_water(&self, x: f64, z: f64) -> bool {
        self.height(x, z) < self.info.water
    }

    fn in_bounds(&self, x: f64, z: f64) -> bool {
        self.chunk_at(x, z).is_some()
    }

    fn colliders_near<F: FnMut(f64, f64, f64, f64)>(&self, x: f64, z: f64, mut f: F) {
        // Colliders can reach a little over a chunk edge: check the neighbours too.
        let s = self.info.chunk_size;
        let (cx, cz) = ((x / s).floor() as i32, (z / s).floor() as i32);
        for dz in -1..=1 {
            for dx in -1..=1 {
                if let Some(l) = self.loaded.get(&(cx + dx, cz + dz)) {
                    l.colliders.near(x, z, &mut f);
                }
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::render_data::MAIN_SET;

    #[test]
    fn chunk_keys_are_unique_and_never_the_main_set() {
        let mut seen = std::collections::HashSet::new();
        for cz in -40..=40 {
            for cx in -40..=40 {
                let k = chunk_key(cx, cz);
                assert_ne!(k, MAIN_SET, "chunk ({cx}, {cz}) took the main key");
                assert!(seen.insert(k), "chunk ({cx}, {cz}) collides");
            }
        }
        assert_ne!(chunk_key(-1, -1), MAIN_SET);
        assert_ne!(chunk_key(i32::MIN, i32::MIN), MAIN_SET);
    }
}
