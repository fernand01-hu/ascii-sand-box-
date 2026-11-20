//! Generator parameters: each object family says which of its settings can
//! be changed (name, label, range, default), and its `make_*_with` grows the
//! object with chosen values. The web side builds its sliders, the terminal
//! and saved scenes from these lists, so a new parameter shows up everywhere
//! by being added here and used in its generator.
//!
//! Values travel as a plain list in the order of the descriptions; a missing
//! or non-finite value means the default, and values are kept in range.

use super::bushes::{bush_params, make_bush_with};
use super::library::Kind;
use super::plants::{make_plant_with, plant_params};
use super::rocks::{make_rock_with, rock_params};
use super::ruins::{make_ruin_with, ruin_params};
use super::trees::{make_tree_with, tree_params};
use super::asset::Asset;

/// Most parameters any kind has (the size of the value block per object).
pub const MAX_PARAMS: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ParamDesc {
    /// Stable id (saved in scene files and presets).
    pub name: &'static str,
    pub label: &'static str,
    pub min: f32,
    pub max: f32,
    pub step: f32,
    pub default: f32,
}

pub const fn p(name: &'static str, label: &'static str, min: f32, max: f32, step: f32, default: f32) -> ParamDesc {
    ParamDesc { name, label, min, max, step, default }
}

/// Values for one object, looked up by name (default when missing).
pub struct Values<'a> {
    descs: &'a [ParamDesc],
    vals: &'a [f32],
}

impl<'a> Values<'a> {
    pub fn new(descs: &'a [ParamDesc], vals: &'a [f32]) -> Values<'a> {
        Values { descs, vals }
    }

    pub fn get(&self, name: &str) -> f32 {
        let Some(i) = self.descs.iter().position(|d| d.name == name) else { return 1.0 };
        let d = &self.descs[i];
        match self.vals.get(i) {
            Some(v) if v.is_finite() => v.clamp(d.min, d.max),
            _ => d.default,
        }
    }

    /// As a whole number (counts).
    pub fn int(&self, name: &str) -> u32 {
        self.get(name).round().max(0.0) as u32
    }
}

/// The parameters of a kind, in value order.
pub fn param_descs(kind: Kind) -> Vec<ParamDesc> {
    let v = match kind {
        Kind::Tree(k) => tree_params(k),
        Kind::Bush(k) => bush_params(k),
        Kind::Plant(k) => plant_params(k),
        Kind::Rock(k) => rock_params(k),
        Kind::Ruin(k) => ruin_params(k),
    };
    debug_assert!(v.len() <= MAX_PARAMS);
    v
}

/// Grow an object of `kind` with these parameter values.
pub fn make_asset(kind: Kind, seed: u32, vals: &[f32]) -> Asset {
    let d = param_descs(kind);
    let v = Values::new(&d, vals);
    match kind {
        Kind::Tree(k) => make_tree_with(seed, k, &v),
        Kind::Bush(k) => make_bush_with(seed, k, &v),
        Kind::Plant(k) => make_plant_with(seed, k, &v),
        Kind::Rock(k) => make_rock_with(seed, k, &v),
        Kind::Ruin(k) => make_ruin_with(seed, k, &v),
    }
}

/// Every kind's parameters as JSON: `[[{"name":..,"label":..,"min":..,"max":..,"step":..,"default":..}, ..], ..]`,
/// one list per kind in kind-code order.
pub fn params_json() -> String {
    let kinds = Kind::all();
    let lists: Vec<String> = kinds
        .iter()
        .map(|&k| {
            let items: Vec<String> = param_descs(k)
                .iter()
                .map(|d| format!(r#"{{"name":"{}","label":"{}","min":{},"max":{},"step":{},"default":{}}}"#, d.name, d.label, d.min, d.max, d.step, d.default))
                .collect();
            format!("[{}]", items.join(","))
        })
        .collect();
    format!("[{}]", lists.join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fingerprint of an asset: piece counts, height, the summed wood
    /// radii, sprite sizes, surfel spacings and positions, and the materials
    /// (so thickness, size, placement and colour changes all show).
    fn stats(a: &Asset) -> (usize, usize, usize, i64, i64, i64, i64, i64, u64) {
        let q = |v: f32| (v * 1000.0).round() as i64;
        let pos: f32 = a.sprites.iter().map(|s| s.pos.x + s.pos.y + s.pos.z).sum::<f32>() + a.surfels.iter().map(|s| s.pos.x + s.pos.y + s.pos.z).sum::<f32>();
        (
            a.wood.len(), a.sprites.len(), a.surfels.len(), q(a.height()),
            q(a.wood.iter().map(|w| w.r).sum()), q(a.sprites.iter().map(|s| s.size).sum()),
            q(a.surfels.iter().map(|s| s.spacing).sum()), q(pos),
            // which materials (moss, lichen, berries...)
            a.surfels.iter().map(|s| s.mat as u64).chain(a.sprites.iter().map(|s| s.mat as u64)).fold(0u64, |h, m| h.wrapping_mul(31).wrapping_add(m))
                // built structures: their faces and style
                ^ (a.faces.len() as u64).wrapping_mul(0x9E37_79B9) ^ ((a.face_style as u64) << 56)
                ^ q(a.faces.iter().map(|f| f.pts[0].x + f.pts[0].y + f.pts[0].z).sum()) as u64,
        )
    }

    #[test]
    fn every_kind_lists_sane_parameters() {
        for k in Kind::all() {
            let d = param_descs(k);
            assert!(!d.is_empty() && d.len() <= MAX_PARAMS, "{}", k.name());
            for x in &d {
                assert!(x.min < x.max && x.min <= x.default && x.default <= x.max && x.step > 0.0, "{} {}", k.name(), x.name);
            }
            let mut names: Vec<_> = d.iter().map(|x| x.name).collect();
            names.sort_unstable();
            names.dedup();
            assert_eq!(names.len(), d.len(), "{}: duplicate names", k.name());
        }
        assert!(params_json().starts_with("[[{\"name\":"));
    }

    #[test]
    fn default_values_grow_exactly_the_usual_object() {
        for k in Kind::all() {
            let usual = super::super::library::make_default(k, 7);
            let none = make_asset(k, 7, &[]);
            let defaults: Vec<f32> = param_descs(k).iter().map(|d| d.default).collect();
            let explicit = make_asset(k, 7, &defaults);
            assert_eq!(stats(&none), stats(&usual), "{}", k.name());
            assert_eq!(stats(&explicit), stats(&usual), "{}", k.name());
        }
    }

    #[test]
    fn every_parameter_changes_the_object() {
        for k in Kind::all() {
            let d = param_descs(k);
            for (i, x) in d.iter().enumerate() {
                let at = |v: f32| {
                    let mut vals: Vec<f32> = d.iter().map(|q| q.default).collect();
                    vals[i] = v;
                    stats(&make_asset(k, 3, &vals))
                };
                // Some seeds hide a change (e.g. no dead branches either way); try a few values.
                let lo = at(x.min);
                let changed = [x.max, (x.max + x.default) / 2.0].iter().any(|&v| at(v) != lo);
                assert!(changed, "{}: {} does nothing", k.name(), x.name);
            }
        }
    }

    #[test]
    fn height_scales_trees() {
        let k = Kind::Tree(super::super::trees::TreeKind::Oak);
        let d = param_descs(k);
        let i = d.iter().position(|x| x.name == "height").unwrap();
        let mut vals: Vec<f32> = d.iter().map(|x| x.default).collect();
        let base = make_asset(k, 5, &vals).height();
        vals[i] = 2.0;
        let tall = make_asset(k, 5, &vals).height();
        assert!(tall > base * 1.6, "{base} -> {tall}");
    }
}
