//! Placing vegetation and rocks on the terrain (port of `scenery/scatter.py`).
//!
//! Per layer (trees, bushes, rocks, plants, shore plants): jittered-grid
//! candidates, suitability from slope / water / altitude / forest mask /
//! moisture, keep with probability density x suitability, pick the kind from
//! weights modified by altitude and moisture, instance one of a few cached
//! variants with random yaw, scale and tint, at a level of detail chosen by
//! distance. New here: nothing grows on trails or in streams, and reeds also
//! line the stream banks.
//!
//! Orbit-friendly change: small things are placed near the camera *or* near
//! the orbit focus, and nothing is culled by the original's fixed frustum.
use crate::fm;

use super::asset::{smoothstep, Asset, Placement, RngExt};
use super::bushes::{make_bush, BushKind};
use super::plants::{make_plant, PlantKind};
use super::rocks::{make_rock, RockKind};
use super::terrain::Terrain;
use super::trees::{make_tree, TreeKind};
use crate::math::Vec3;
use crate::rng::Pcg32;
use std::collections::HashMap;
use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Tree(TreeKind),
    Bush(BushKind),
    Plant(PlantKind),
    Rock(RockKind),
}

impl Kind {
    pub fn is_conifer(self) -> bool {
        matches!(self, Kind::Tree(TreeKind::Pine | TreeKind::Spruce))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Biome {
    Meadow,
    Forest,
    Lakeside,
    Alpine,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum LayerKind {
    Trees,
    Bushes,
    Rocks,
    Plants,
    Shore,
}

pub(crate) struct Layer {
    pub which: LayerKind,
    pub cell: f32,
    pub density: f32,
    pub forest: Option<(f32, f32)>,
    pub max_dist: f32,
    pub clear: f32,
    pub open: f32,
    pub kinds: Vec<(Kind, f32)>,
}

pub(crate) fn layers(b: Biome) -> Vec<Layer> {
    use BushKind as B;
    use Kind::*;
    use PlantKind as P;
    use RockKind as R;
    use TreeKind as T;
    let l = |which, cell, density, forest, max_dist, kinds: Vec<(Kind, f32)>| Layer { which, cell, density, forest, max_dist, clear: 9.0, open: 2.5, kinds };
    match b {
        Biome::Meadow => vec![
            Layer { clear: 18.0, open: 4.0, ..l(LayerKind::Trees, 8.0, 0.75, Some((0.06, 0.24)), 320.0,
                vec![(Tree(T::Oak), 4.0), (Tree(T::Maple), 3.0), (Tree(T::Birch), 2.0), (Tree(T::Pine), 2.0), (Tree(T::Spruce), 1.0), (Tree(T::Dead), 0.3)]) },
            l(LayerKind::Bushes, 4.0, 0.45, Some((-0.35, 0.25)), 140.0,
                vec![(Bush(B::BigRound), 3.0), (Bush(B::SmallRound), 3.0), (Bush(B::Wide), 2.0), (Bush(B::Berry), 1.5), (Bush(B::Flowering), 1.5), (Bush(B::Boxwood), 1.0), (Bush(B::Juniper), 1.0)]),
            l(LayerKind::Plants, 1.1, 0.4, None, 45.0,
                vec![(Plant(P::Wildflowers), 5.0), (Plant(P::GrassTuft), 4.0), (Plant(P::Fern), 1.5), (Plant(P::Hosta), 1.0), (Plant(P::Rhubarb), 0.5)]),
            l(LayerKind::Rocks, 7.0, 0.18, None, 200.0,
                vec![(Rock(R::Boulder), 4.0), (Rock(R::Angular), 2.0), (Rock(R::Slab), 1.5), (Rock(R::Pebbles), 2.0), (Rock(R::Outcrop), 0.6)]),
            l(LayerKind::Shore, 1.6, 0.55, None, 120.0, vec![(Plant(P::Reeds), 5.0), (Plant(P::GrassTuft), 2.0)]),
        ],
        Biome::Forest => vec![
            l(LayerKind::Trees, 5.0, 0.85, Some((-0.4, 0.0)), 320.0,
                vec![(Tree(T::Pine), 4.0), (Tree(T::Spruce), 4.0), (Tree(T::Birch), 2.0), (Tree(T::Oak), 1.0), (Tree(T::Dead), 0.5)]),
            l(LayerKind::Bushes, 5.0, 0.25, None, 120.0,
                vec![(Bush(B::SmallRound), 2.0), (Bush(B::BigRound), 1.0), (Bush(B::Juniper), 2.0), (Bush(B::Berry), 1.0), (Bush(B::Boxwood), 1.0)]),
            l(LayerKind::Plants, 1.0, 0.45, None, 40.0,
                vec![(Plant(P::Fern), 6.0), (Plant(P::GrassTuft), 2.0), (Plant(P::Hosta), 1.0), (Plant(P::HostaVariegated), 0.5), (Plant(P::ElephantEar), 0.4), (Plant(P::Wildflowers), 1.0)]),
            l(LayerKind::Rocks, 6.0, 0.2, None, 180.0,
                vec![(Rock(R::Boulder), 4.0), (Rock(R::Angular), 2.0), (Rock(R::Slab), 2.0), (Rock(R::Pebbles), 1.0), (Rock(R::Outcrop), 0.5)]),
            l(LayerKind::Shore, 1.8, 0.5, None, 120.0, vec![(Plant(P::Reeds), 4.0), (Plant(P::Fern), 1.0)]),
        ],
        Biome::Lakeside => vec![
            Layer { clear: 14.0, open: 3.0, ..l(LayerKind::Trees, 6.0, 0.8, Some((-0.1, 0.15)), 320.0,
                vec![(Tree(T::Birch), 4.0), (Tree(T::Pine), 4.0), (Tree(T::Spruce), 2.0), (Tree(T::Oak), 1.0), (Tree(T::Dead), 0.4)]) },
            l(LayerKind::Bushes, 4.5, 0.35, Some((-0.4, 0.3)), 130.0,
                vec![(Bush(B::SmallRound), 2.0), (Bush(B::BigRound), 1.0), (Bush(B::Wide), 1.0), (Bush(B::Berry), 1.0), (Bush(B::Juniper), 1.0)]),
            l(LayerKind::Plants, 1.1, 0.4, None, 40.0,
                vec![(Plant(P::Fern), 3.0), (Plant(P::GrassTuft), 4.0), (Plant(P::Wildflowers), 2.0), (Plant(P::Hosta), 1.0), (Plant(P::ElephantEar), 0.5)]),
            l(LayerKind::Rocks, 5.0, 0.25, None, 200.0,
                vec![(Rock(R::Boulder), 4.0), (Rock(R::Slab), 2.0), (Rock(R::Angular), 1.0), (Rock(R::Pebbles), 3.0), (Rock(R::Outcrop), 0.6)]),
            l(LayerKind::Shore, 1.2, 0.7, None, 150.0, vec![(Plant(P::Reeds), 6.0), (Plant(P::GrassTuft), 2.0)]),
        ],
        Biome::Alpine => vec![
            l(LayerKind::Trees, 7.0, 0.7, Some((-0.3, 0.1)), 320.0,
                vec![(Tree(T::Spruce), 6.0), (Tree(T::Pine), 3.0), (Tree(T::Dead), 0.8), (Tree(T::Birch), 0.5)]),
            l(LayerKind::Bushes, 5.0, 0.3, None, 140.0, vec![(Bush(B::Juniper), 5.0), (Bush(B::SmallRound), 2.0), (Bush(B::Boxwood), 1.0)]),
            l(LayerKind::Plants, 1.8, 0.18, None, 40.0, vec![(Plant(P::GrassTuft), 5.0), (Plant(P::Wildflowers), 3.0), (Plant(P::Fern), 1.0)]),
            l(LayerKind::Rocks, 4.5, 0.35, None, 220.0,
                vec![(Rock(R::Boulder), 3.0), (Rock(R::Angular), 4.0), (Rock(R::Slab), 1.0), (Rock(R::Pebbles), 2.0), (Rock(R::Outcrop), 1.2)]),
            l(LayerKind::Shore, 2.0, 0.4, None, 120.0, vec![(Plant(P::Reeds), 2.0), (Plant(P::GrassTuft), 3.0)]),
        ],
    }
}

/// A few cached variants per kind and level of detail.
pub struct Library {
    seed: u32,
    index: HashMap<(Kind, u32, u8), usize>,
    pub assets: Vec<Asset>,
}

impl Library {
    pub fn new(seed: u32) -> Library {
        Library { seed, index: HashMap::new(), assets: Vec::new() }
    }

    pub fn get(&mut self, kind: Kind, variant: u32, lod: u8) -> usize {
        if let Some(&i) = self.index.get(&(kind, variant, lod)) {
            return i;
        }
        let base = if lod == 0 {
            let k = match kind {
                Kind::Tree(t) => t as u32,
                Kind::Bush(b) => 10 + b as u32,
                Kind::Plant(p) => 20 + p as u32,
                Kind::Rock(r) => 30 + r as u32,
            };
            let s = self.seed * 1000 + k * 7 + variant;
            match kind {
                Kind::Tree(t) => make_tree(s, t),
                Kind::Bush(b) => make_bush(s, b),
                Kind::Plant(p) => make_plant(s, p),
                Kind::Rock(r) => make_rock(s, r),
            }
        } else {
            let i0 = self.get(kind, variant, 0);
            self.assets[i0].lod(lod, self.seed as u64)
        };
        self.assets.push(base);
        let i = self.assets.len() - 1;
        self.index.insert((kind, variant, lod), i);
        i
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub asset: usize,
    pub kind: Kind,
    pub pl: Placement,
}

/// Forest litter under tree crowns, as a coarse lookup grid.
pub struct Canopy {
    half: f32,
    res: f32,
    n: usize,
    g: Vec<f32>,
}

impl Canopy {
    pub fn at(&self, x: f32, z: f32) -> f32 {
        let f = |v: f32| (((v + self.half) / self.res) as isize).clamp(0, self.n as isize - 1) as usize;
        self.g[f(z) * self.n + f(x)]
    }
}

pub struct Scattered {
    pub library: Library,
    pub placed: Vec<Placed>,
    pub canopy: Canopy,
}

/// Scatter a biome. `eye` is the default camera, `focus` the orbit centre.
pub fn scatter(t: &Terrain, eye: Vec3, focus: Vec3, biome: Biome, seed: u32) -> Scattered {
    let mut rng = Pcg32::new(seed as u64 + 31, 0x5ca7);
    let mut lib = Library::new(seed);
    let tree_line = t.hmax * 0.5;
    let mut placed = Vec::new();
    let mut trees: Vec<(f32, f32, f32)> = Vec::new();
    let noise = &t.noise;
    for layer in layers(biome) {
        let small = matches!(layer.which, LayerKind::Plants | LayerKind::Shore | LayerKind::Bushes);
        let min_dist = match layer.which {
            LayerKind::Trees => layer.clear,
            LayerKind::Bushes | LayerKind::Rocks => 3.5,
            _ => 1.2,
        };
        let lim = t.half - 2.0;
        let mut x0 = -lim;
        while x0 < lim {
            let mut z0 = -lim;
            while z0 < lim {
                let (x, z) = (x0 + rng.uniform(0.0, layer.cell), z0 + rng.uniform(0.0, layer.cell));
                z0 += layer.cell;
                if x.abs() >= lim || z.abs() >= lim {
                    continue;
                }
                let d_eye = fm::hypot(x - eye.x, z - eye.z);
                let d_focus = fm::hypot(x - focus.x, z - focus.z);
                let d = if small { d_eye.min(d_focus) } else { d_eye };
                if d > layer.max_dist || d_eye < min_dist {
                    continue;
                }
                // Far things only where the default view (and orbiting about
                // the focus) can see them: within 110 m all round, beyond that
                // in a +-75 degree cone ahead of the camera.
                if d_eye > 110.0 {
                    let fwd = Vec3::new(focus.x - eye.x, 0.0, focus.z - eye.z);
                    let to = Vec3::new(x - eye.x, 0.0, z - eye.z);
                    if fwd.dot(to) < fwd.length() * to.length() * fm::cos(75f32.to_radians()) {
                        continue;
                    }
                }
                let y = t.height(x, z);
                let n = t.normal(x, z);
                let slope = 1.0 - n.y;
                let alt = (y / tree_line.max(1.0)).clamp(0.0, 2.0);
                let wet = t.is_water(x, z);
                let shore = t.shore_dist(x, z);
                let stream = t.stream_strength(x, z);
                let trail = t.trail_strength(x, z);
                let moist = smoothstep(25.0, 3.0, shore) + smoothstep(0.0, 0.3, stream) * 0.6 + 0.3 * noise.fbm(x / 40.0, z / 40.0, 5.5, 2);
                let forest = noise.fbm(x / 70.0 + 11.0, z / 70.0 - 7.0, 3.3, 3);
                if wet || stream > 0.45 {
                    continue;
                }
                let off_path = 1.0 - smoothstep(0.05, 0.4, trail);
                let suit = match layer.which {
                    LayerKind::Shore => {
                        let bank = smoothstep(0.03, 0.2, stream);
                        smoothstep(4.0, 0.5, shore).max(bank) * if slope < 0.25 { 1.0 } else { 0.0 }
                    }
                    LayerKind::Rocks => (0.4 + 1.5 * smoothstep(0.08, 0.4, slope)) * f32::from(shore > 1.0) * f32::from(alt < 1.6),
                    _ => {
                        let fm = layer.forest.map_or(1.0, |(lo, hi)| smoothstep(lo, hi, forest));
                        let mut s = fm * smoothstep(0.32, 0.15, slope) * f32::from(shore > if layer.which == LayerKind::Plants { 1.0 } else { 2.0 });
                        if layer.which == LayerKind::Trees {
                            s *= smoothstep(1.15, 0.85, alt); // tree line
                            s *= 0.25 + 0.75 * smoothstep(min_dist, min_dist * layer.open, d_eye); // open foreground
                            s *= 1.0 - smoothstep(0.0, 0.25, stream); // no trees in the channel
                        }
                        s
                    }
                } * off_path;
                if rng.next_f32() >= (layer.density * suit).clamp(0.0, 1.0) {
                    continue;
                }
                // Kind from weights x altitude / moisture modifiers.
                let w: Vec<f32> = layer
                    .kinds
                    .iter()
                    .map(|&(k, w)| {
                        let mut m = w;
                        if k.is_conifer() {
                            m *= 0.4 + 1.6 * smoothstep(0.2, 0.8, alt);
                        } else if layer.which == LayerKind::Trees {
                            m *= 1.3 - smoothstep(0.3, 0.9, alt);
                        }
                        if k == Kind::Tree(TreeKind::Birch) {
                            m *= 0.5 + 2.0 * moist.clamp(0.0, 1.0);
                        }
                        if matches!(k, Kind::Plant(PlantKind::Fern | PlantKind::Hosta | PlantKind::HostaVariegated | PlantKind::ElephantEar)) {
                            m *= 0.4 + 1.5 * (moist + 0.3).clamp(0.0, 1.0);
                        }
                        m.max(1e-3)
                    })
                    .collect();
                let total: f32 = w.iter().sum();
                let mut r = rng.next_f32() * total;
                let mut kind = layer.kinds[0].0;
                for (i, &wi) in w.iter().enumerate() {
                    if r < wi {
                        kind = layer.kinds[i].0;
                        break;
                    }
                    r -= wi;
                }
                let variants = if layer.which == LayerKind::Trees { 3 } else { 4 };
                let variant = rng.below(variants);
                let lod = if d_eye.min(d_focus + 20.0) < 32.0 { 0 } else if d_eye.min(d_focus + 20.0) < 90.0 { 1 } else { 2 };
                let asset = lib.get(kind, variant, lod);
                let sc = rng.uniform(0.75, 1.25);
                let mut yy = y;
                if let Kind::Rock(_) = kind {
                    let (lo, hi) = lib.assets[asset].bounds();
                    let r = (hi.x - lo.x).max(hi.z - lo.z) * sc / 2.0;
                    for k in 0..6 {
                        let a = k as f32 / 6.0 * TAU;
                        yy = yy.min(t.height(x + r * fm::cos(a), z + r * fm::sin(a)));
                    }
                }
                let sink = if layer.which == LayerKind::Trees { 0.12 } else { 0.03 };
                let pl = Placement { pos: Vec3::new(x, yy - sink, z), yaw: rng.uniform(0.0, TAU), scale: sc, tint: rng.uniform(0.85, 1.15) };
                placed.push(Placed { asset, kind, pl });
                if layer.which == LayerKind::Trees {
                    let (lo, hi) = lib.assets[asset].bounds();
                    trees.push((x, z, (hi.x - lo.x) * sc));
                }
            }
            x0 += layer.cell;
        }
    }
    // Canopy grid for forest litter.
    let res = 2.0;
    let n = (t.size / res) as usize + 1;
    let mut g = vec![0.0f32; n * n];
    for &(x, z, w) in &trees {
        let r = (w * 0.45).max(1.5);
        let reach = (2.0 * r / res).ceil() as isize;
        let (cx, cz) = (((x + t.half) / res) as isize, ((z + t.half) / res) as isize);
        for dz in -reach..=reach {
            for dx in -reach..=reach {
                let (ix, iz) = (cx + dx, cz + dz);
                if ix < 0 || iz < 0 || ix >= n as isize || iz >= n as isize {
                    continue;
                }
                let (px, pz) = (-t.half + ix as f32 * res, -t.half + iz as f32 * res);
                let v = fm::exp(-((px - x).powi(2) + (pz - z).powi(2)) / (r * r));
                let i = iz as usize * n + ix as usize;
                g[i] = g[i].max(v);
            }
        }
    }
    Scattered { library: lib, placed, canopy: Canopy { half: t.half, res, n, g } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scenery::terrain::TerrainPreset;

    #[test]
    fn meadow_scatter_follows_the_rules() {
        let t = Terrain::new(1, TerrainPreset::Hills);
        let eye = Vec3::new(0.0, t.height(0.0, t.half - 40.0) + 4.0, t.half - 40.0);
        let focus = Vec3::new(0.0, 0.0, eye.z - 35.0);
        let s = scatter(&t, eye, focus, Biome::Meadow, 1);
        let count = |f: fn(&Kind) -> bool| s.placed.iter().filter(|p| f(&p.kind)).count();
        let (trees, bushes, plants, rocks) = (
            count(|k| matches!(k, Kind::Tree(_))),
            count(|k| matches!(k, Kind::Bush(_))),
            count(|k| matches!(k, Kind::Plant(_))),
            count(|k| matches!(k, Kind::Rock(_))),
        );
        eprintln!("trees {trees} bushes {bushes} plants {plants} rocks {rocks}, {} asset variants", s.library.assets.len());
        assert!(trees > 30 && bushes > 30 && plants > 100 && rocks > 10);
        for p in &s.placed {
            let (x, z) = (p.pl.pos.x, p.pl.pos.z);
            assert!(!t.is_water(x, z), "nothing in the water");
            assert!(t.trail_strength(x, z) < 0.45, "nothing on the trail at ({x}, {z})");
            if let Kind::Tree(_) = p.kind {
                assert!(fm::hypot(x - eye.x, z - eye.z) >= 18.0, "foreground kept clear of trees");
            }
        }
        // At most (kinds x variants) base assets, each in up to 3 levels of detail.
        let kinds: usize = layers(Biome::Meadow).iter().map(|l| l.kinds.len() * if l.which == LayerKind::Trees { 3 } else { 4 }).sum();
        assert!(s.library.assets.len() <= kinds * 3, "variants are cached: {} > {}", s.library.assets.len(), kinds * 3);
    }
}
