//! The four bundled test models (keys 1-4), embedded from the webapp's files.

pub const MODELS: [(&str, &[u8]); 4] = [
    ("torus-knot.stl", include_bytes!("../../../web/public/models/torus-knot.stl")),
    ("sphere.stl", include_bytes!("../../../web/public/models/sphere.stl")),
    ("ziggurat.stl", include_bytes!("../../../web/public/models/ziggurat.stl")),
    ("pine.stl", include_bytes!("../../../web/public/models/pine.stl")),
];
