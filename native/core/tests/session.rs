//! Whole-session determinism with an inline executor: same inputs and same
//! clock give the same render events, bit for bit; walking works end to end.

use ascii_core::input::{Command, Gallery, InputState};
use ascii_core::jobs::InlineExecutor;
use ascii_core::physics::Ground;
use ascii_core::render_data::RenderEvent;
use ascii_core::session::Status;
use ascii_core::Session;

fn fold(h: &mut u64, v: &[f32]) {
    for x in v {
        *h = (*h ^ u64::from(x.to_bits())).wrapping_mul(0x0000_0100_0000_01b3);
    }
}

fn run_world(frames: usize) -> (u64, usize, ascii_core::session::Stats) {
    let mut s = Session::new(InlineExecutor::new(), (800, 600));
    s.show_world(1, false);
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut events = Vec::new();
    let mut sets = 0;
    for f in 0..frames {
        s.update(f as f64 * 0.2, &InputState::default());
        s.drain_events(&mut events);
        for e in &events {
            match e {
                RenderEvent::SetCards { key, cards, chunks } => {
                    sets += 1;
                    h = (h ^ key).wrapping_mul(0x0000_0100_0000_01b3);
                    fold(&mut h, cards);
                    h = (h ^ chunks.len() as u64).wrapping_mul(0x0000_0100_0000_01b3);
                }
                RenderEvent::SetBody { positions, .. } => fold(&mut h, positions),
                _ => {}
            }
        }
    }
    let p = s.frame_params();
    fold(&mut h, &p.view);
    fold(&mut h, &p.proj);
    (h, sets, s.stats())
}

#[test]
fn world_streaming_is_deterministic() {
    let (h1, sets1, st1) = run_world(10);
    let (h2, sets2, _) = run_world(10);
    assert_eq!(h1, h2, "two runs produced different render data");
    assert_eq!(sets1, sets2);
    assert!(st1.chunks_loaded >= 8, "only {} chunks loaded", st1.chunks_loaded);
}

#[test]
fn player_walks_the_streamed_world() {
    let mut s = Session::new(InlineExecutor::new(), (800, 600));
    s.show_world(1, false);
    let mut events = Vec::new();
    for f in 0..12 {
        s.update(f as f64 * 0.2, &InputState::default());
        s.drain_events(&mut events);
    }
    assert!(s.play(), "no ground to walk on");
    let start = s.player().unwrap().state;
    let walk = InputState { forward: 1.0, ..Default::default() };
    let mut t = 2.4;
    for _ in 0..180 {
        t += 1.0 / 60.0;
        s.update(t, &walk);
    }
    let end = s.player().unwrap().state;
    let moved = (end.x - start.x).hypot(end.z - start.z);
    assert!(moved > 3.0, "player barely moved: {moved}");
    assert!(end.x.is_finite() && end.y.is_finite() && end.z.is_finite());
    assert!(!s.stats().model.is_empty());
}

#[test]
fn gallery_and_stl_load() {
    let mut s = Session::new(InlineExecutor::new(), (800, 600));
    s.command(Command::Gallery(Gallery::Rocks));
    s.update(0.0, &InputState::default());
    assert_eq!(*s.status(), Status::Ready);
    assert!(s.stats().cards > 10_000);
    let stl = include_bytes!("../../../web/public/models/sphere.stl").to_vec();
    s.command(Command::LoadStl { bytes: stl, name: "sphere.stl".into() });
    s.update(0.1, &InputState::default());
    assert_eq!(*s.status(), Status::Ready);
    assert!(s.stats().triangles > 100);
    // A broken file reports an error and keeps the session alive.
    s.command(Command::LoadStl { bytes: vec![1, 2, 3], name: "bad.stl".into() });
    s.update(0.2, &InputState::default());
    assert!(matches!(s.status(), Status::Error(_)));
    let g = ascii_core::physics::GridGround::new(ascii_core::physics::GridWorld {
        heights: vec![0.0; 4],
        n: 2,
        size: 10.0,
        water: None,
        water_mask: vec![],
        colliders: vec![],
    });
    assert_eq!(g.height(0.0, 0.0), 0.0);
}
