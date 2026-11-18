//! The Rust generators against the Python reference (`scenery` package):
//! average primitive counts and heights over seeds 1-3 must stay within
//! tolerance of what the original produces. Different RNGs mean individual
//! assets differ; the statistics shouldn't.

use ascii_engine::scenery::asset::Asset;
use ascii_engine::scenery::bushes::{make_bush, BushKind};
use ascii_engine::scenery::plants::{make_plant, PlantKind};
use ascii_engine::scenery::rocks::{make_rock, RockKind};
use ascii_engine::scenery::trees::{make_tree, TreeKind};

/// name, (wood, sprites, surfels, height) means from the Python package.
fn check(name: &str, make: impl Fn(u32) -> Asset, py: [f32; 4]) -> Option<String> {
    let mut m = [0.0f32; 4];
    for seed in 1..=10 {
        let a = make(seed);
        let v = [a.wood.len() as f32, a.sprites.len() as f32, a.surfels.len() as f32, a.height()];
        for k in 0..4 {
            m[k] += v[k] / 10.0;
        }
    }
    println!("{name:14} wood {:7.0} ({:7.0})  sprites {:7.0} ({:7.0})  surfels {:7.0} ({:7.0})  height {:5.2} ({:5.2})",
        m[0], py[0], m[1], py[1], m[2], py[2], m[3], py[3]);
    let labels = ["wood", "sprites", "surfels", "height"];
    for k in 0..4 {
        let tol = if k == 3 { 0.2 } else { 0.3 };
        let ok = if py[k] == 0.0 { m[k] == 0.0 } else { (m[k] / py[k] - 1.0).abs() <= tol };
        if !ok {
            return Some(format!("{name}: {} {:.1} vs Python {:.1}", labels[k], m[k], py[k]));
        }
    }
    None
}

/// name, generator, Python means (wood, sprites, surfels, height).
type Case = (&'static str, Box<dyn Fn(u32) -> Asset>, [f32; 4]);

#[test]
fn generators_match_the_python_reference() {
    // Python means: 40 seeds where measured, else 10. Oak and dead snag use
    // healthy trees only (the original grows a bare trunk ~15% of the time;
    // the port fixes that, see trees.rs).
    let cases: Vec<Case> = vec![
        ("pine", Box::new(|s| make_tree(s, TreeKind::Pine)), [7924., 13160., 0., 10.90]),
        ("spruce", Box::new(|s| make_tree(s, TreeKind::Spruce)), [41005., 54929., 0., 13.05]),
        ("oak", Box::new(|s| make_tree(s, TreeKind::Oak)), [3663., 6170., 0., 10.88]),
        ("birch", Box::new(|s| make_tree(s, TreeKind::Birch)), [2859., 12356., 0., 13.67]),
        ("maple", Box::new(|s| make_tree(s, TreeKind::Maple)), [2919., 5096., 0., 11.23]),
        ("dead", Box::new(|s| make_tree(s, TreeKind::Dead)), [483., 0., 0., 9.27]),
        ("small_round", Box::new(|s| make_bush(s, BushKind::SmallRound)), [372., 995., 0., 0.589]),
        ("big_round", Box::new(|s| make_bush(s, BushKind::BigRound)), [1079., 2799., 0., 1.62]),
        ("juniper", Box::new(|s| make_bush(s, BushKind::Juniper)), [537., 1426., 0., 1.204]),
        ("fern", Box::new(|s| make_plant(s, PlantKind::Fern)), [189., 2239., 0., 0.48]),
        ("hosta", Box::new(|s| make_plant(s, PlantKind::Hosta)), [80., 0., 1006., 0.39]),
        ("elephant_ear", Box::new(|s| make_plant(s, PlantKind::ElephantEar)), [38., 0., 2610., 0.76]),
        ("reeds", Box::new(|s| make_plant(s, PlantKind::Reeds)), [0., 334., 0., 1.69]),
        ("boulder", Box::new(|s| make_rock(s, RockKind::Boulder)), [0., 0., 6098., 0.95]),
        ("outcrop", Box::new(|s| make_rock(s, RockKind::Outcrop)), [0., 0., 37682., 1.36]),
    ];
    let failures: Vec<String> = cases.iter().filter_map(|(n, f, py)| check(n, f, *py)).collect();
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}
