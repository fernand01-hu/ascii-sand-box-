//! Space colonization (Runions et al. 2007) for broadleaf trees and bushes.
//! Port of `scenery/colonize.py`, with a uniform grid hash in place of
//! scipy's k-d tree for the nearest-node queries (as the README suggests).

use super::asset::{unit, RngExt};
use super::perlin::Perlin;
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::collections::HashMap;

struct Grid {
    cell: f32,
    map: HashMap<(i32, i32, i32), Vec<u32>>,
}

impl Grid {
    fn new(cell: f32) -> Grid {
        Grid { cell, map: HashMap::new() }
    }

    fn key(&self, p: Vec3) -> (i32, i32, i32) {
        ((p.x / self.cell).floor() as i32, (p.y / self.cell).floor() as i32, (p.z / self.cell).floor() as i32)
    }

    fn insert(&mut self, p: Vec3, id: u32) {
        let k = self.key(p);
        self.map.entry(k).or_default().push(id);
    }

    /// Nearest point within `max_d` (which must be <= the cell size).
    fn nearest(&self, p: Vec3, pts: &[Vec3], max_d: f32) -> Option<(u32, f32)> {
        self.nearest_in(p, pts, max_d, 0, u32::MAX)
    }

    /// Like `nearest`, only among ids in `lo..hi`.
    fn nearest_in(&self, p: Vec3, pts: &[Vec3], max_d: f32, lo: u32, hi: u32) -> Option<(u32, f32)> {
        let (kx, ky, kz) = self.key(p);
        let mut best: Option<(u32, f32)> = None;
        let max2 = max_d * max_d;
        for dx in -1..=1 {
            for dy in -1..=1 {
                for dz in -1..=1 {
                    if let Some(ids) = self.map.get(&(kx + dx, ky + dy, kz + dz)) {
                        for &id in ids.iter().filter(|&&id| id >= lo && id < hi) {
                            let d = pts[id as usize] - p;
                            let d2 = d.dot(d);
                            if d2 <= max2 && best.is_none_or(|(_, b)| d2 < b) {
                                best = Some((id, d2));
                            }
                        }
                    }
                }
            }
        }
        best.map(|(id, d2)| (id, d2.sqrt()))
    }
}

pub struct Skeleton {
    pub nodes: Vec<Vec3>,
    /// Parent index, -1 for roots. Children always come after their parent.
    pub parents: Vec<i32>,
}

/// Grow branches from `nodes` toward the attraction points.
#[allow(clippy::too_many_arguments)]
pub fn colonize(
    rng: &mut Pcg32,
    attract: &[Vec3],
    nodes: Vec<Vec3>,
    parents: Vec<i32>,
    d: f32,
    di: f32,
    dk: f32,
    tropism: Vec3,
    max_iter: usize,
    jitter: f32,
) -> Skeleton {
    let mut p = nodes;
    let mut par = parents;
    let mut grid = Grid::new(di);
    for (i, &q) in p.iter().enumerate() {
        grid.insert(q, i as u32);
    }
    let mut alive: Vec<u32> = (0..attract.len() as u32).collect();
    for _ in 0..max_iter {
        if alive.is_empty() {
            break;
        }
        // Every attraction point pulls its nearest node within di.
        let mut acc: HashMap<u32, (Vec3, u32)> = HashMap::new();
        for &ai in &alive {
            let a = attract[ai as usize];
            if let Some((ni, _)) = grid.nearest(a, &p, di) {
                let e = acc.entry(ni).or_insert((Vec3::ZERO, 0));
                e.0 += unit(a - p[ni as usize]);
                e.1 += 1;
            }
        }
        if acc.is_empty() {
            break;
        }
        // Deterministic order regardless of hash map iteration.
        let mut pulled: Vec<(u32, Vec3)> = acc.into_iter().map(|(k, (v, _))| (k, v)).collect();
        pulled.sort_unstable_by_key(|&(k, _)| k);
        let mut grown = 0;
        let before = p.len() as u32;
        for (ni, v) in pulled {
            let dd = unit(unit(v) + tropism + rng.gauss3(jitter));
            let new = p[ni as usize] + dd * d;
            // No doubling back onto wood that existed before this step
            // (as in the original, nodes grown in the same step may crowd).
            if grid.nearest_in(new, &p, d * 0.45, 0, before).is_some() {
                continue;
            }
            p.push(new);
            par.push(ni as i32);
            grid.insert(new, (p.len() - 1) as u32);
            grown += 1;
        }
        if grown == 0 {
            break;
        }
        // Points reached by a node grown in this step are used up (as in the
        // original; points near the seed nodes keep pulling).
        let after = p.len() as u32;
        alive.retain(|&ai| grid.nearest_in(attract[ai as usize], &p, dk, before, after).is_none());
    }
    Skeleton { nodes: p, parents: par }
}

/// Pipe model: parent radius^e = sum of children's radius^e.
pub fn pipe_radii(par: &[i32], r_tip: f32, e: f32) -> Vec<f32> {
    let n = par.len();
    let mut acc = vec![0.0f32; n];
    let mut r = vec![0.0f32; n];
    for i in (0..n).rev() {
        r[i] = if acc[i] == 0.0 { r_tip } else { acc[i].powf(1.0 / e) };
        if par[i] >= 0 {
            acc[par[i] as usize] += r[i].powf(e);
        }
    }
    r
}

/// Laplacian smoothing of nodes with exactly one child. Returns child counts.
pub fn smooth(p: &mut [Vec3], par: &[i32], iters: usize, fixed: usize) -> Vec<u32> {
    let n = p.len();
    let mut child = vec![-1i32; n];
    let mut nchild = vec![0u32; n];
    for i in 0..n {
        if par[i] >= 0 {
            nchild[par[i] as usize] += 1;
            child[par[i] as usize] = i as i32;
        }
    }
    let sel: Vec<usize> = (fixed..n).filter(|&i| nchild[i] == 1 && par[i] >= 0).collect();
    for _ in 0..iters {
        let q = p.to_vec();
        for &i in &sel {
            p[i] = q[i] * 0.5 + (q[par[i] as usize] + q[child[i] as usize]) * 0.25;
        }
    }
    nchild
}

/// Attraction points in an ellipsoid (or a union of blobs inside it), biased
/// toward the outer shell, where real crowns carry their leaves.
#[allow(clippy::too_many_arguments)]
pub fn envelope_points(
    rng: &mut Pcg32,
    n: usize,
    center: Vec3,
    radii: Vec3,
    blobs: u32,
    shell: f32,
    noise: Option<&Perlin>,
    floor: f32,
) -> Vec<Vec3> {
    let mul = |a: Vec3, b: Vec3| Vec3::new(a.x * b.x, a.y * b.y, a.z * b.z);
    let div = |a: Vec3, b: Vec3| Vec3::new(a.x / b.x, a.y / b.y, a.z / b.z);
    let blob: Vec<(Vec3, Vec3)> = (0..blobs)
        .map(|_| {
            let mut c = center + mul(Vec3::new(rng.uniform(-0.55, 0.55), 0.0, rng.uniform(-0.55, 0.55)), radii);
            c.y = center.y + rng.uniform(-0.35, 0.5) * radii.y;
            (c, radii * rng.uniform(0.45, 0.7))
        })
        .collect();
    let mut out = Vec::with_capacity(n);
    let mut tries = 0;
    while out.len() < n && tries < n * 400 {
        tries += 1;
        let q = center + mul(Vec3::new(rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0), rng.uniform(-1.0, 1.0)), radii);
        let mut dn = if blobs > 0 {
            blob.iter().map(|&(c, r)| div(q - c, r).length()).fold(f32::INFINITY, f32::min)
        } else {
            div(q - center, radii).length()
        };
        if let Some(nz) = noise {
            dn -= 0.18 * nz.noise3(q.x * 0.9, q.y * 0.9, q.z * 0.9);
        }
        if dn < 1.0 && q.y > floor && (dn > shell || rng.chance(0.2)) {
            out.push(q);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grows_a_connected_tree_into_the_envelope() {
        let mut rng = Pcg32::new(1, 1);
        let att = envelope_points(&mut rng, 800, Vec3::new(0.0, 0.55, 0.0), Vec3::new(0.6, 0.5, 0.6), 0, 0.4, None, 0.05);
        assert_eq!(att.len(), 800);
        let sk = colonize(&mut rng, &att, vec![Vec3::ZERO, Vec3::new(0.0, 0.05, 0.0)], vec![-1, 0], 0.05, 0.35, 0.065, Vec3::ZERO, 300, 0.1);
        assert!(sk.nodes.len() > 200, "{} nodes", sk.nodes.len());
        for (i, &pa) in sk.parents.iter().enumerate().skip(1) {
            assert!(pa >= 0 && (pa as usize) < i, "parents come first");
            assert!((sk.nodes[i] - sk.nodes[pa as usize]).length() < 0.051);
        }
        let r = pipe_radii(&sk.parents, 0.003, 2.5);
        assert!(r[0] > r[r.len() - 1] * 3.0, "trunk thicker than tips");
    }
}
