//! The asset library: every kind of object the generators can make (trees,
//! bushes, plants, rocks), and a cache of a few seeded variants per kind and
//! level of detail, so many placed copies share one generated asset.

use super::asset::Asset;
use super::bushes::{make_bush, BushKind};
use super::plants::{make_plant, PlantKind};
use super::rocks::{make_rock, RockKind};
use super::trees::{make_tree, TreeKind};
use std::collections::HashMap;

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

    /// Every kind, in code order: trees, bushes, plants, rocks. A kind's
    /// code is its index here, which is how placed objects are stored, so
    /// only ever append to the end of each generator's `ALL` list.
    pub fn all() -> Vec<Kind> {
        let mut v: Vec<Kind> = TreeKind::ALL.iter().map(|&k| Kind::Tree(k)).collect();
        v.extend(BushKind::ALL.iter().map(|&k| Kind::Bush(k)));
        v.extend(PlantKind::ALL.iter().map(|&k| Kind::Plant(k)));
        v.extend(RockKind::ALL.iter().map(|&k| Kind::Rock(k)));
        v
    }

    pub fn from_code(code: u32) -> Option<Kind> {
        Kind::all().get(code as usize).copied()
    }

    /// "tree:oak", "bush:juniper", "plant:fern", "rock:boulder".
    pub fn name(self) -> String {
        match self {
            Kind::Tree(k) => format!("tree:{}", k.name()),
            Kind::Bush(k) => format!("bush:{}", k.name()),
            Kind::Plant(k) => format!("plant:{}", k.name()),
            Kind::Rock(k) => format!("rock:{}", k.name()),
        }
    }
}

/// The usual object of a kind (default parameters) from a seed.
pub fn make_default(kind: Kind, seed: u32) -> Asset {
    match kind {
        Kind::Tree(t) => make_tree(seed, t),
        Kind::Bush(b) => make_bush(seed, b),
        Kind::Plant(p) => make_plant(seed, p),
        Kind::Rock(r) => make_rock(seed, r),
    }
}

/// Parameter values as a cache key (exact bits; an empty list = defaults).
fn params_key(params: &[f32]) -> u64 {
    params.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, v| (h ^ v.to_bits() as u64).wrapping_mul(0x0100_0000_01b3))
}

/// A few cached variants per kind, parameter set and level of detail.
pub struct Library {
    seed: u32,
    index: HashMap<(Kind, u64, u32, u8), usize>,
    pub assets: Vec<Asset>,
}

impl Library {
    /// Most assets kept; past it the cache starts over (see `trim`).
    pub const MAX_ASSETS: usize = 600;

    pub fn new(seed: u32) -> Library {
        Library { seed, index: HashMap::new(), assets: Vec::new() }
    }

    /// Drop every cached asset if there are too many (call between builds,
    /// never while indices from `get` are still in use).
    pub fn trim(&mut self) {
        if self.assets.len() > Self::MAX_ASSETS {
            self.assets.clear();
            self.index.clear();
        }
    }

    /// Default parameters.
    pub fn get(&mut self, kind: Kind, variant: u32, lod: u8) -> usize {
        self.get_with(kind, &[], variant, lod)
    }

    /// With parameter values (see `params`; empty = defaults).
    pub fn get_with(&mut self, kind: Kind, params: &[f32], variant: u32, lod: u8) -> usize {
        let defaults = params.is_empty() || {
            let d = super::params::param_descs(kind);
            d.iter().enumerate().all(|(i, x)| params.get(i).is_none_or(|v| !v.is_finite() || (*v - x.default).abs() < 1e-6))
        };
        let pk = if defaults { 0 } else { params_key(params) };
        if let Some(&i) = self.index.get(&(kind, pk, variant, lod)) {
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
            if defaults { make_default(kind, s) } else { super::params::make_asset(kind, s, params) }
        } else {
            let i0 = self.get_with(kind, params, variant, 0);
            self.assets[i0].lod(lod, self.seed as u64)
        };
        self.assets.push(base);
        let i = self.assets.len() - 1;
        self.index.insert((kind, pk, variant, lod), i);
        i
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_codes_round_trip_and_names_are_unique() {
        let all = Kind::all();
        assert_eq!(all.len(), 26);
        for (i, &k) in all.iter().enumerate() {
            assert_eq!(Kind::from_code(i as u32), Some(k));
        }
        assert_eq!(Kind::from_code(all.len() as u32), None);
        let mut names: Vec<String> = all.iter().map(|k| k.name()).collect();
        assert_eq!(names[0], "tree:pine");
        names.sort();
        names.dedup();
        assert_eq!(names.len(), all.len());
    }

    #[test]
    fn variants_are_cached_and_lods_derive_from_the_full_asset() {
        let mut lib = Library::new(4);
        let rock = Kind::Rock(RockKind::Boulder);
        let a = lib.get(rock, 0, 0);
        assert_eq!(lib.get(rock, 0, 0), a, "same variant comes from the cache");
        assert_ne!(lib.get(rock, 1, 0), a, "another variant is another asset");
        let far = lib.get(rock, 0, 2);
        assert_eq!(lib.assets.len(), 3);
        assert!(lib.assets[far].surfels.len() <= lib.assets[a].surfels.len());
    }
}
