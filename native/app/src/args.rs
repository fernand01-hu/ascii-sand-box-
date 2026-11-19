use ascii_core::input::{Gallery, Preset};

pub fn preset(s: &str) -> Result<Preset, String> {
    Ok(match s {
        "meadow" => Preset::Meadow,
        "forest" => Preset::Forest,
        "lake" => Preset::Lake,
        "valley" => Preset::Valley,
        "alpine" => Preset::Alpine,
        _ => return Err(format!("unknown scene {s:?} (meadow, forest, lake, valley, alpine)")),
    })
}

pub fn gallery(s: &str) -> Result<Gallery, String> {
    Ok(match s {
        "rocks" => Gallery::Rocks,
        "plants" => Gallery::Plants,
        "bushes" => Gallery::Bushes,
        "trees" => Gallery::Trees,
        _ => return Err(format!("unknown gallery {s:?} (rocks, plants, bushes, trees)")),
    })
}
