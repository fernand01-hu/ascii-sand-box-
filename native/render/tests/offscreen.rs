//! Off-screen render checks. They need a Vulkan/Metal adapter (a software
//! driver such as lavapipe is enough) and skip themselves without one.

use ascii_core::input::{Command, InputState};
use ascii_core::jobs::InlineExecutor;
use ascii_core::Session;
use ascii_render::headless::{content_diff, open_gpu, read_golden, thumbnail, Headless};

const SIZE: (u32, u32) = (1000, 800);

fn render_model(gpu: &ascii_render::headless::Gpu, bytes: &[u8]) -> Vec<u8> {
    let mut s = Session::new(InlineExecutor::new(), SIZE);
    s.command(Command::LoadStl { bytes: bytes.to_vec(), name: "m.stl".into() });
    s.update(0.0, &InputState::default());
    let mut head = Headless::new(gpu, SIZE);
    let mut events = Vec::new();
    s.drain_events(&mut events);
    head.renderer.apply_events(&mut events);
    head.render_rgba(&s.frame_params()).0
}

#[test]
fn model_render_is_deterministic_and_matches_the_webapp_reference() {
    let Ok(gpu) = open_gpu() else {
        eprintln!("no GPU adapter: skipped");
        return;
    };
    let bytes = include_bytes!("../../../web/public/models/sphere.stl");
    let a = render_model(&gpu, bytes);
    let b = render_model(&gpu, bytes);
    assert!(a == b, "same scene rendered twice gave different pixels");

    let lit = a.chunks_exact(4).filter(|p| (i32::from(p[0]) - 9).abs() + (i32::from(p[1]) - 12).abs() + (i32::from(p[2]) - 19).abs() > 24).count();
    assert!(lit as f64 / (SIZE.0 * SIZE.1) as f64 > 0.03, "the sphere should cover a visible part of the frame");

    // The webapp's reference thumbnail (bottom row first), same tolerance as its e2e test.
    let top_first = thumbnail(&a, SIZE, 48, 36);
    let mut thumb = Vec::new();
    for row in (0..36).rev() {
        thumb.extend_from_slice(&top_first[row * 48 * 3..(row + 1) * 48 * 3]);
    }
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/golden/2-sphere.json");
    let reference = read_golden(&path).expect("golden file");
    let d = content_diff(&thumb, &reference);
    assert!(d <= 1.5, "differs from the webapp reference by {d:.2} (tolerance 1.5)");
}
