//! Parity of the Rust core against the webapp's TypeScript, using fixtures
//! produced by `node scripts/native-fixtures.mjs` from the real `physics.ts`
//! and `chunks.ts`.

use ascii_core::chunks::{chunk_cards, Mulberry32};
use ascii_core::physics::{GridGround, GridWorld, Input, Physics, PlayerState};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/parity.json")).expect("fixture parses")
}

fn f(v: &Value) -> f64 {
    v.as_f64().expect("number")
}

#[test]
fn mulberry32_is_bit_identical() {
    let fx = fixture();
    for seed in [13u32, 2] {
        let want = fx["mulberry"][seed.to_string()].as_array().unwrap();
        let mut r = Mulberry32::new(seed);
        for w in want {
            assert_eq!(r.next().to_bits(), f(w).to_bits(), "seed {seed}");
        }
    }
}

#[test]
fn chunk_grouping_matches_chunks_ts() {
    let fx = fixture();
    const N: usize = 3000;
    let mut cards = vec![0.0f32; N * 16];
    for i in 0..N {
        let o = i * 16;
        // The JS builds the same values in f64 then stores f32.
        cards[o] = (((i * 37) % 1000) as f64 / 10.0 - 50.0) as f32;
        cards[o + 1] = ((i % 13) as f64 * 0.25) as f32;
        cards[o + 2] = (((i * 91) % 1000) as f64 / 10.0 - 50.0) as f32;
        cards[o + 6] = (0.01 * (i % 5) as f64) as f32;
        cards[o + 7] = (0.1 + 0.01 * (i % 7) as f64) as f32;
        cards[o + 8] = (0.002 * (i % 3) as f64) as f32;
        cards[o + 9] = i as f32;
        let mode = if i % 11 < 8 { 0 } else { 4 + (i % 11) - 8 };
        cards[o + 13] = ((i % 16) + 1024 * ((i % 5) + 64 * mode)) as f32;
    }
    for (k, case) in fx["chunking"].as_array().unwrap().iter().enumerate() {
        let all_global = case["allGlobal"].as_bool().unwrap();
        let r = chunk_cards(&cards, 16, all_global);
        let table = case["table"].as_array().unwrap();
        assert_eq!(r.chunks.len() * 10, table.len(), "case {k}: chunk count");
        for (c, rec) in r.chunks.iter().zip(table.chunks(10)) {
            let want: Vec<f64> = rec.iter().map(f).collect();
            let got = [
                f64::from(c.start),
                f64::from(c.count),
                f64::from(c.lo[0]),
                f64::from(c.lo[1]),
                f64::from(c.lo[2]),
                f64::from(c.hi[0]),
                f64::from(c.hi[1]),
                f64::from(c.hi[2]),
                f64::from(c.size),
                if c.global { 1.0 } else { 0.0 },
            ];
            assert_eq!(got.to_vec(), want, "case {k}: chunk record");
        }
        let ids: Vec<f64> = (0..N).map(|i| f64::from(r.cards[i * 16 + 9])).collect();
        let want: Vec<f64> = case["ids"].as_array().unwrap().iter().map(f).collect();
        assert_eq!(ids, want, "case {k}: card order after the shuffle");
    }
}

fn world() -> GridGround {
    let (n, size) = (65usize, 64.0);
    let mut heights = vec![0.0f32; n * n];
    let mut mask = vec![0u8; n * n];
    for j in 0..n {
        for i in 0..n {
            heights[j * n + i] = (((i * 7 + j * 13) % 11) as f64 * 0.04 + i as f64 * 0.02) as f32;
            if (40..48).contains(&i) && (10..30).contains(&j) {
                mask[j * n + i] = 1;
            }
        }
    }
    let colliders = vec![5.0, 5.0, 0.5, 3.0, -10.0, 8.0, 0.8, 0.5, 0.0, -6.0, 0.6, 5.0, -3.0, -3.0, 0.4, 0.2];
    GridGround::new(GridWorld { heights, n, size, water: Some(0.5), water_mask: mask, colliders })
}

#[test]
fn physics_trajectories_match_physics_ts() {
    let fx = fixture();
    let g = world();
    for (si, sc) in fx["scenarios"].as_array().unwrap().iter().enumerate() {
        let spawn = sc["spawn"].as_array().unwrap();
        let yaw = f(&sc["yaw"]);
        let total = f(&sc["total"]);
        let dt = f(&sc["dt"]);
        let p = Physics::new();
        let mut phys = p;
        let mut s: PlayerState = phys.spawn(&g, f(&spawn[0]), f(&spawn[1]), yaw);
        let first = sc["first"].as_array().unwrap();
        assert_eq!([s.x, s.y, s.z], [f(&first[0]), f(&first[1]), f(&first[2])], "scenario {si}: spawn");
        let schedule = sc["schedule"].as_array().unwrap();
        let (mut t, mut next, mut idx) = (0.0f64, 0.5f64, 0usize);
        let samples = sc["samples"].as_array().unwrap();
        while t < total - 1e-9 {
            let mut input = Input::default();
            if let Some(q) = schedule.iter().find(|q| t >= f(&q["t0"]) && t < f(&q["t1"])) {
                let i = &q["input"];
                input = Input {
                    forward: i["forward"].as_f64().unwrap_or(0.0),
                    right: i["right"].as_f64().unwrap_or(0.0),
                    run: i["run"].as_bool().unwrap_or(false),
                    jump: i["jump"].as_bool().unwrap_or(false),
                };
            }
            phys.update(&g, &mut s, input, dt);
            t += dt;
            if t >= next - 1e-9 {
                let w = samples[idx].as_array().unwrap();
                let got = [s.x, s.y, s.z, s.vx, s.vy, s.vz, if s.on_ground { 1.0 } else { 0.0 }, s.yaw];
                for (k, (a, b)) in got.iter().zip(w.iter()).enumerate() {
                    assert!((a - f(b)).abs() < 1e-6, "scenario {si} sample {idx} field {k}: rust {a} vs js {}", f(b));
                }
                idx += 1;
                next += 0.5;
            }
        }
        assert_eq!(idx, samples.len(), "scenario {si}: sample count");
    }
}


