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
