//! The look of every surface: characters, colour and how it reacts to light.
//! Port of `scenery/style.py`; one row per material, same values.
//!
//! Generators only say "this leaf is `LeafOak`"; skinning turns that into
//! characters and the shader uses spec / shininess / translucency / wrap.

/// One material. `axis_v`: for chains of cards along a stem, the glyph's
/// vertical strokes run along it ('|' '!') instead of its horizontal ones.
#[derive(Clone, Copy, Debug)]
pub struct Material {
    pub chars: &'static str,
    pub weights: Option<&'static [f32]>,
    pub albedo: [f32; 3],
    pub var: f32,
    pub spec: f32,
    pub shin: f32,
    pub trans: f32,
    pub wrap: f32,
    pub alpha: (f32, f32),
    pub axis_v: bool,
    pub size: f32,
    pub keep: f32,
    pub solid: bool,
    pub dens: f32,
}

const fn m(chars: &'static str, albedo: [f32; 3]) -> Material {
    Material {
        chars,
        weights: None,
        albedo,
        var: 0.12,
        spec: 0.1,
        shin: 12.0,
        trans: 0.0,
        wrap: 0.2,
        alpha: (0.85, 1.0),
        axis_v: false,
        size: 1.0,
        keep: 1.9,
        solid: false,
        dens: 1.0,
    }
}

const fn foliage(x: Material) -> Material {
    Material { spec: 0.4, shin: 24.0, trans: 0.45, wrap: 0.25, alpha: (0.78, 1.0), keep: 2.0, ..x }
}

const fn accent(x: Material) -> Material {
    Material { spec: 0.4, shin: 24.0, trans: 0.45, wrap: 0.25, alpha: (0.78, 1.0), keep: 0.6, ..x }
}

const fn small_accent(x: Material, lo: f32) -> Material {
    Material { alpha: (lo, 1.0), keep: 0.6, ..x }
}

const fn bigleaf(x: Material, spec: f32, shin: f32, trans: f32) -> Material {
    Material { spec, shin, trans, wrap: 0.2, alpha: (0.6, 1.0), dens: 1.7, ..x }
}

const fn rock(x: Material, var: f32, spec: f32, shin: f32, wrap: f32, alpha: (f32, f32)) -> Material {
    Material { var, spec, shin, wrap, alpha, solid: true, dens: 1.3, ..x }
}

const fn ground(x: Material) -> Material {
    Material { alpha: (0.7, 0.85), ..x }
}

const NEEDLE_PINE_W: [f32; 19] = [12., 10., 8., 6., 6., 4., 4., 3., 3., 2., 2., 6., 6., 6., 3., 3., 3., 4., 3.];
const NEEDLE_SPRUCE_W: [f32; 13] = [8., 6., 8., 8., 6., 4., 3., 3., 2., 2., 4., 4., 4.];
const GRASS_W: [f32; 16] = [12., 9., 9., 6., 5., 4., 3., 5., 7., 6., 4., 2., 6., 4., 3., 2.];

macro_rules! materials {
    ($($id:ident = $e:expr;)*) => {
        /// Material ids. The shader's material table is indexed by `Mat as usize`.
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[repr(u8)]
        pub enum Mat { $($id),* }
        pub static MATERIALS: &[Material] = &[$($e),*];
        pub const MAT_NAMES: &[&str] = &[$(stringify!($id)),*];
        impl Mat {
            pub const ALL: &'static [Mat] = &[$(Mat::$id),*];
            pub fn def(self) -> &'static Material { &MATERIALS[self as usize] }
        }
    };
}

materials! {
    // conifer foliage: one card = a small spray of needles
    NeedlePine = foliage(Material { weights: Some(&NEEDLE_PINE_W), ..m("VYvy*WwXxKk|/\\li!^A", [0.13, 0.33, 0.17]) });
    NeedleSpruce = foliage(Material { weights: Some(&NEEDLE_SPRUCE_W), ..m("^AvVY*xXkK|/\\", [0.09, 0.28, 0.20]) });
    NeedleJuniper = foliage(m("*^vVYxX#", [0.11, 0.27, 0.20]));
    ShootTip = accent(m("*+xX", [0.36, 0.50, 0.20]));
    // broad leaves: one card = one leaf
    LeafOak = foliage(m("@&%8OQ0B#Ww*", [0.13, 0.29, 0.08]));
    LeafBirch = foliage(m("o*'.,`+cv", [0.30, 0.45, 0.12]));
    LeafMaple = foliage(m("*WwMm&%#", [0.20, 0.34, 0.08]));
    LeafBush = foliage(m("&%@*oO8#w", [0.12, 0.30, 0.12]));
    LeafBox = foliage(m("#%&@8", [0.07, 0.21, 0.08]));
    BerryRed = Material { spec: 0.8, shin: 40.0, ..small_accent(m("o*@.", [0.62, 0.06, 0.07]), 0.7) };
    BlossomPink = Material { trans: 0.4, ..small_accent(m("*@o+x", [0.90, 0.48, 0.64]), 0.6) };
    BlossomWhite = Material { trans: 0.4, ..small_accent(m("*@o+", [0.90, 0.90, 0.84]), 0.6) };
    // small plants
    Fern = foliage(m("()<>{}/\\|vY", [0.20, 0.45, 0.12]));
    FernOld = foliage(m("()<>{}/\\", [0.36, 0.34, 0.12]));
    Fiddlehead = small_accent(m("@6e9", [0.30, 0.50, 0.16]), 0.7);
    Bigleaf = bigleaf(m("@&%O0QDB#8", [0.10, 0.30, 0.12]), 0.5, 30.0, 0.35);
    BigleafBlue = bigleaf(m("@&%O0QDB#8", [0.12, 0.28, 0.25]), 0.5, 30.0, 0.3);
    BigleafDark = bigleaf(m("@&%#mMwW8", [0.12, 0.29, 0.08]), 0.4, 24.0, 0.3);
    BigleafEdge = bigleaf(m("o*:;.", [0.62, 0.64, 0.32]), 0.4, 24.0, 0.4);
    Midrib = Material { alpha: (0.7, 1.0), dens: 1.7, ..m("|!:", [0.45, 0.60, 0.28]) };
    MidribRed = Material { alpha: (0.7, 1.0), dens: 1.7, ..m("|!:", [0.62, 0.16, 0.14]) };
    Stem = Material { axis_v: true, size: 0.8, ..m("|!l1", [0.22, 0.42, 0.14]) };
    StemRed = Material { axis_v: true, size: 0.8, ..m("|!l1", [0.55, 0.13, 0.10]) };
    GrassBlade = Material { weights: Some(&GRASS_W), spec: 0.2, shin: 14.0, trans: 0.3, alpha: (0.75, 0.95),
                            ..m("|/\\'\",;ivwVWYy^`", [0.22, 0.40, 0.12]) };
    GrassTall = Material { spec: 0.2, shin: 14.0, trans: 0.35, alpha: (0.65, 1.0), axis_v: true,
                           ..m("|/\\()il!", [0.30, 0.44, 0.14]) };
    Reed = Material { spec: 0.2, trans: 0.3, alpha: (0.7, 1.0), axis_v: true, ..m("|!lI1", [0.34, 0.42, 0.17]) };
    Cattail = Material { alpha: (0.9, 1.0), keep: 0.6, ..m("0#8@", [0.30, 0.17, 0.07]) };
    FlowerYellow = Material { trans: 0.3, ..small_accent(m("*@oO+x", [0.95, 0.78, 0.15]), 0.75) };
    FlowerWhite = Material { trans: 0.3, ..small_accent(m("*@oO+x", [0.92, 0.92, 0.88]), 0.75) };
    FlowerPurple = Material { trans: 0.3, ..small_accent(m("*@oO+x", [0.55, 0.30, 0.80]), 0.75) };
    FlowerRed = Material { trans: 0.3, ..small_accent(m("*@oO+x", [0.88, 0.15, 0.12]), 0.75) };
    PlantLeaf = foliage(m("vVY^<>", [0.18, 0.40, 0.12]));
    // thin wood, drawn as a chain of cards along the branch
    Twig = Material { alpha: (0.75, 0.9), ..m("-=~_", [0.30, 0.20, 0.13]) };
    Branch = Material { alpha: (0.85, 0.95), ..m("#=H%&8$", [0.30, 0.20, 0.13]) };
    TwigBirch = Material { alpha: (0.8, 0.95), ..m("-=~_", [0.25, 0.18, 0.15]) };
    TwigDead = Material { alpha: (0.85, 0.95), ..m("-=~/\\", [0.45, 0.43, 0.40]) };
    // rock surfaces
    Rock = rock(m("#%@MW&8$NHB", [0.42, 0.41, 0.40]), 0.15, 0.15, 10.0, 0.1, (0.92, 1.0));
    RockSand = rock(m("#%@&8$=", [0.62, 0.50, 0.36]), 0.12, 0.1, 12.0, 0.1, (0.92, 1.0));
    RockDark = rock(m("#%@MW&8NHB", [0.24, 0.24, 0.26]), 0.15, 0.25, 16.0, 0.1, (0.92, 1.0));
    RockCrack = rock(m(":/\\|!", [0.10, 0.10, 0.10]), 0.12, 0.1, 12.0, 0.1, (0.9, 1.0));
    Moss = rock(m(",.`*wm\"'", [0.20, 0.36, 0.10]), 0.12, 0.1, 12.0, 0.3, (0.85, 1.0));
    Lichen = rock(m("oc*.", [0.70, 0.64, 0.32]), 0.12, 0.1, 12.0, 0.2, (0.85, 1.0));
    // terrain
    GroundGrass = ground(m(".,'`:;-~=", [0.20, 0.32, 0.10]));
    Soil = ground(m(".,_-~=:;o", [0.30, 0.22, 0.14]));
    Litter = ground(m(".,`'-~", [0.32, 0.21, 0.11]));
    Sand = ground(m(".,:'`-~", [0.75, 0.66, 0.45]));
    GroundRock = Material { alpha: (0.8, 0.95), ..m("#%&@:=", [0.27, 0.25, 0.24]) };
    Snow = Material { spec: 0.4, shin: 30.0, alpha: (0.8, 0.95), ..m("*+.:'`", [0.95, 0.96, 1.00]) };
    MeadowFlower = Material { alpha: (0.8, 1.0), ..m("*o.+", [0.95, 0.85, 0.40]) };
    // shading for bark wrapped round trunks (characters come from BARKS)
    Bark = Material { spec: 0.08, shin: 12.0, wrap: 0.1, alpha: (0.95, 1.0), solid: true, ..m("#", [0.5, 0.4, 0.3]) };
    // far trees (impostors)
    FarConifer = Material { alpha: (0.6, 0.95), ..m("A^*#", [0.08, 0.22, 0.16]) };
    FarBroadleaf = Material { alpha: (0.6, 0.95), ..m("@&%O8#", [0.12, 0.27, 0.10]) };
    FarTrunk = Material { axis_v: true, ..m("|!", [0.25, 0.18, 0.12]) };
}

impl Mat {
    /// Crown foliage, which gets ASCII shadow shading (lighter glyphs in shade).
    pub fn is_crown_foliage(self) -> bool {
        matches!(
            self,
            Mat::NeedlePine | Mat::NeedleSpruce | Mat::NeedleJuniper | Mat::LeafOak | Mat::LeafBirch | Mat::LeafMaple | Mat::LeafBush | Mat::LeafBox
        )
    }
}

/// How a bark's characters are laid out on the trunk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pattern {
    Plates,
    Scales,
    Ridges,
    Bands,
}

#[derive(Clone, Copy, Debug)]
pub struct BarkDef {
    pub plate: &'static str,
    pub mid: &'static str,
    pub fissure: &'static str,
    pub upper: &'static str,
    pub alb_plate: [f32; 3],
    pub alb_fissure: [f32; 3],
    pub alb_upper: [f32; 3],
    pub upper_from: f32,
    pub pattern: Pattern,
    pub twig: Mat,
    pub branch: Mat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Bark {
    Pine,
    Spruce,
    Oak,
    Birch,
    Maple,
    Dead,
    Shrub,
    Stem,
    StemRed,
}

impl Bark {
    pub const ALL: [Bark; 9] = [Bark::Pine, Bark::Spruce, Bark::Oak, Bark::Birch, Bark::Maple, Bark::Dead, Bark::Shrub, Bark::Stem, Bark::StemRed];

    pub fn def(self) -> &'static BarkDef {
        &BARKS[self as usize]
    }
}

#[allow(clippy::too_many_arguments)]
const fn ridges(plate: &'static str, mid: &'static str, fissure: &'static str, upper: &'static str, a: [f32; 3], f: [f32; 3], twig: Mat, branch: Mat) -> BarkDef {
    BarkDef { plate, mid, fissure, upper, alb_plate: a, alb_fissure: f, alb_upper: a, upper_from: 2.0, pattern: Pattern::Ridges, twig, branch }
}

pub static BARKS: [BarkDef; 9] = [
    BarkDef {
        plate: "@#&8%BMW", mid: "oO0=x", fissure: "|!I:[]", upper: "~-=szco<>",
        alb_plate: [0.58, 0.48, 0.40], alb_fissure: [0.24, 0.14, 0.10], alb_upper: [0.95, 0.50, 0.27],
        upper_from: 0.4, pattern: Pattern::Plates, twig: Mat::Twig, branch: Mat::Branch,
    },
    BarkDef {
        plate: "oO0c@%", mid: "oc.:", fissure: ":.,", upper: "oO0c@%",
        alb_plate: [0.42, 0.33, 0.26], alb_fissure: [0.18, 0.12, 0.09], alb_upper: [0.48, 0.34, 0.24],
        upper_from: 2.0, pattern: Pattern::Scales, twig: Mat::Twig, branch: Mat::Branch,
    },
    ridges("|I!1HN#", "lH|", ":|.", "|I!1HN#", [0.42, 0.39, 0.35], [0.14, 0.12, 0.10], Mat::Twig, Mat::Branch),
    BarkDef {
        plate: "=-_~", mid: "=-", fissure: "=-_", upper: "=-_~",
        alb_plate: [0.88, 0.87, 0.82], alb_fissure: [0.07, 0.06, 0.06], alb_upper: [0.88, 0.87, 0.82],
        upper_from: 2.0, pattern: Pattern::Bands, twig: Mat::TwigBirch, branch: Mat::TwigBirch,
    },
    ridges("|I!H#=", "l|", ":|.", "|I!H#", [0.45, 0.40, 0.36], [0.18, 0.15, 0.12], Mat::Twig, Mat::Branch),
    ridges("|/\\#=I", "|:", ":.", "|/\\#=I", [0.62, 0.60, 0.56], [0.22, 0.21, 0.20], Mat::TwigDead, Mat::TwigDead),
    ridges("#=H", "=-", ":", "#=H", [0.36, 0.26, 0.18], [0.15, 0.10, 0.08], Mat::Twig, Mat::Twig),
    ridges("|!", "|", "|", "|!", [0.22, 0.42, 0.14], [0.18, 0.32, 0.10], Mat::Stem, Mat::Stem),
    ridges("|!", "|", "|", "|!", [0.55, 0.13, 0.10], [0.4, 0.1, 0.08], Mat::StemRed, Mat::StemRed),
];

pub const DIM_CHARS: &str = ".,'`";
pub const MID_CHARS: &str = ":;-~+";

/// Every character scenery uses, unique and sorted (the atlas order).
pub fn charset() -> String {
    let mut cs: Vec<char> = Vec::new();
    let mut add = |s: &str| {
        for c in s.chars() {
            if !cs.contains(&c) {
                cs.push(c);
            }
        }
    };
    for mt in MATERIALS {
        add(mt.chars);
    }
    for b in &BARKS {
        add(b.plate);
        add(b.mid);
        add(b.fissure);
        add(b.upper);
    }
    add(DIM_CHARS);
    add(MID_CHARS);
    cs.sort_unstable();
    cs.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_consistent() {
        assert_eq!(MATERIALS.len(), Mat::ALL.len());
        assert_eq!(MAT_NAMES.len(), MATERIALS.len());
        assert!(MATERIALS.len() <= 64, "shader material table holds 64");
        for (i, mt) in MATERIALS.iter().enumerate() {
            assert!(!mt.chars.is_empty(), "{}", MAT_NAMES[i]);
            if let Some(w) = mt.weights {
                assert_eq!(w.len(), mt.chars.chars().count(), "{}", MAT_NAMES[i]);
            }
            assert!(mt.alpha.0 <= mt.alpha.1);
        }
        assert_eq!(Mat::ALL[Mat::Bark as usize], Mat::Bark);
        assert_eq!(Bark::ALL[Bark::Birch as usize], Bark::Birch);
        assert_eq!(BARKS[Bark::Birch as usize].pattern, Pattern::Bands);
    }

    #[test]
    fn charset_is_ascii_unique_and_covers_everything() {
        let cs = charset();
        assert!(cs.is_ascii());
        let mut seen = std::collections::HashSet::new();
        assert!(cs.chars().all(|c| seen.insert(c)));
        for mt in MATERIALS {
            assert!(mt.chars.chars().all(|c| cs.contains(c)));
        }
    }
}
