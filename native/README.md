# ASCII Scene, native (macOS and Linux)

A native port of the web viewer: the same engine, the same world, the same
keys, in a window, with the work spread over threads and drawn through wgpu
(Metal on macOS). The webapp (`web/`) is untouched and keeps its own logic.

## Build and run

On a Mac with Apple Silicon (needs Rust from https://rustup.rs and the Xcode
command line tools):

```
scripts/build-macos.sh                   # -> dist-macos/ASCII Scene.app
xattr -dr com.apple.quarantine "dist-macos/ASCII Scene.app"   # the app is not signed
open "dist-macos/ASCII Scene.app"
# or straight from the binary, with options:
native/target/aarch64-apple-darwin/release/ascii-scene --world --perf
```

On Linux (needs Rust and a C linker; to run, a Vulkan driver and an X11 or
Wayland session with libxkbcommon):

```
scripts/build-linux.sh                   # -> dist-linux/ascii-scene
dist-linux/ascii-scene --world --day --perf
```

The window was checked on x86-64 Linux under X11 with the software Vulkan
driver (lavapipe), not on Wayland and not on a real GPU.

On Windows the same code builds with `cd native && cargo build --release`.
Only the Mac build is tuned (`-C target-cpu=apple-m1`, set in `native/.cargo/config.toml`).

```
ascii-scene [FILE.stl] [--world [--seed N] [--day]] [--scene NAME] [--gallery NAME] [--perf] [--size WxH]
```

Environment: `ASCII_PERF=1` performance log, `ASCII_WORKERS=N` chunk threads,
`ASCII_PRESENT=immediate|mailbox` (default is vsync; use `immediate` to measure
the uncapped frame rate).
`ASCII_FADE=SECONDS` length of the dissolve when a world chunk is replaced
(default 0.8, 0 turns it off).

## Keys (same as the webapp)

- drag: orbit, right-drag: pan, wheel: zoom. Drop an `.stl` on the window or pass it on the command line.
- `1`-`4` test models, `6`-`9` galleries (rocks, plants, bushes, trees),
  `M` `F` `L` `V` `A` landscapes (meadow, forest, lake, valley, alpine), `I` the infinite world.
- `P` walk (WASD / arrows, Shift run, Space jump, mouse look; click to capture the mouse, `Esc` to release it).
- `W` wind (calm / breeze / storm), `R` rain, `B` blowing leaves.
- `F3` toggles the performance log on stderr (fps, worst frame, cards drawn, draw calls, chunks loaded / pending, chunk build time).

Not ported: `5` (the testbed pine; dev tool of the webapp).

## Architecture

```
engine/          existing Rust engine (scene generation). Now has a plain Rust API;
                 the wasm-bindgen bindings are behind the `wasm` feature (src/wasm.rs).
                 `libm` feature: pure-Rust math, same scene on every platform.
native/
  core/   ascii_core    ALL the logic, no platform dependency
  render/ ascii_render  wgpu renderer (WGSL shaders, atlas, underpaint), no window
  app/    ascii_native  the shell: winit window, input mapping, thread pool, CLI, off-screen tools
```

Dependencies only point down: `app` -> `render` -> `core` -> `engine`; `app` also uses `core` directly.

**`ascii_core`** (pure Rust: no `cfg(target_os)`, no `std::time`, no `std::thread`, no files):
- `session.rs` the product core (port of `App` and the non-drawing half of `Viewer`): which scene is shown, orbit
  camera, walking, weather, world streaming, job bookkeeping. Driven with `command()`, `pointer()`, `resize()`,
  `update(now, input)`; read with `drain_events()` and `frame_params()`.
- `input.rs` abstract input: `InputState` (what is held), `Command` (what was asked), `Pointer`. No key codes.
- `orbit.rs` OrbitControls port (damping 0.08, clamps). `player.rs` + `physics.rs` exact port of `player.ts` /
  `physics.ts` (f64, fixed 1/120 s steps). `weather.rs` wind / rain / leaves state.
- `streamer.rs` the infinite world stream (port of `world.ts`): nearest-first requests, rebuild on distance change, drop.
- `chunks.rs` exact port of `chunks.ts` (16 m culling cells, mulberry32 shuffle).
- `jobs.rs` the background work as data (`Job`, `Worker::run`) and the `JobExecutor` trait. `InlineExecutor` runs
  jobs on the caller's thread (tests). The session is generic over the executor: no dynamic dispatch on the hot path.
- `render_data.rs` what a renderer receives: `RenderEvent` (new card buffers, bodies, atlas, materials; rare) and
  `FrameParams` (matrices, lighting, weather, clock; small, every frame). Independent of any graphics API.

**`ascii_render`**: `Renderer::render(encoder, target_view, size, &FrameParams)`. Persistent per-set instance
buffers, CPU frustum culling per 16 m chunk with contiguous ranges merged into single draws, no per-frame
allocation of its own. Passes: underpaint (half resolution, 4x MSAA, blurred), then background + bodies + glyph
cards (4x MSAA, alpha blending for STL models, alpha-to-coverage for landscapes). `cards.wgsl` is a line-by-line port
of the GLSL (lighting, billboards, wind, water flow, rain, leaves, fog). `atlas.rs` rasterizes the same atlas as
`atlas.ts` (embedded DejaVu Sans Mono Bold, see `assets/DEJAVU-LICENSE.txt`) with CPU mipmaps.
`headless.rs` renders off-screen for tests and tools.

**`ascii_native`**: `window.rs` (winit event loop, mouse capture, drop files, surface, frame pacing: vsync by default,
no drawing when nothing moves, no polling when hidden), `pool.rs` (N long-lived threads, one `Worker` each, queue +
channel; the render thread only `try_recv`s), `headless.rs` (`shot`, `golden`, `bench`).

Porting to another platform means writing another shell: map its input onto `InputState` / `Command` / `Pointer`,
implement `JobExecutor` with its threads (Web Workers on the web), give `ascii_render` a device and a target view.
A web shell (WebGPU/WASM) and moving the webapp onto this core are possible later; neither is started.

## Tests

```
cd native && cargo test --release --workspace          # core, parity, renderer (GPU tests skip without an adapter)
WGPU_BACKEND=vulkan cargo test --release -p ascii_render  # force the software Vulkan driver (lavapipe) on Linux
cd native && cargo run --release -- golden ../tests/golden out   # compare with the webapp's reference images
node scripts/native-fixtures.mjs                        # regenerate the parity fixtures from physics.ts / chunks.ts
node scripts/native-wasm-parity.mjs                     # regenerate the WASM-engine reference (needs npm run wasm)
```

- `core/tests/parity.rs`: mulberry32 bit-identical to JS; `chunk_cards` identical to `chunks.ts` (table and card
  order after the shuffle); physics trajectories identical to `physics.ts` within 1e-6 over five scenarios
  (walk, run, jump, collider, water, various frame rates); the native engine against the WASM engine
  (same buffer lengths and sums; see "Determinism").
- `core/tests/session.rs`: a whole world session run twice gives bit-identical render data; the player walks the
  streamed world; galleries and STL load; a broken STL reports an error.
- `render/tests/offscreen.rs`: off-screen render is deterministic and matches the webapp's reference for the sphere.

## Determinism and parity with the webapp

- The engine's trigonometry went through the platform's libm, which differs between systems and from the one in
  WASM; erosion and scattering amplify that into different landscapes (the lake had 7% fewer cards and other
  trees). With the `libm` feature (on for the native build) every `sin`/`cos`/`exp`/`pow`... goes through the
  pure-Rust `libm` crate (`engine/src/fm.rs`). The WASM build keeps the standard calls: its output is unchanged.
- Result: native and WASM produce the same card counts for the three landscapes (470910, 849891, 455465) and
  11 of 12 reference buffers bit for bit; in the twelfth, 14 of 2138 cards differ in the last bit (max 4e-7).
- Rendering against the webapp's reference thumbnails (`tests/golden`, tolerance 1.5 in the webapp): models and
  galleries 0.25 to 1.3; landscapes about 2.0 to 2.3 on lavapipe. The remainder comes from the GPU:
  `sin()` in the per-card hash differs between the software drivers, which changes individual card twists and wind phases.
- Back faces are culled for cards exactly as three.js does (`FrontSide`): checked, it matches the references better.

## Performance

Measured on Linux (4 cores, no GPU), `ascii-scene bench`:
- world chunk (32 m): mean 94 ms single-threaded, p95 178 ms, max 1.1 s (the chunk nearest the eye);
  the view disc of 261 chunks streams in under 12 s on two threads; scene builds 2.7 to 2.8 s (meadow, lake, valley).
- CPU cost of a world frame (culling, 686 draw calls, submit): 0.5 ms.
- Cost of the deterministic math (`libm` feature) on x86 Linux: chunks +6% (92 vs 87 ms mean), scenes +10% (2.76 vs 2.51 s). Not measured on Apple Silicon.
- Not measurable here: GPU time. On the Mac run `ascii-scene --world --perf` and read the fps line.

Choices for a fanless M1 Air: vsync (60 Hz cap), no drawing at all when nothing moves (STL models, galleries,
paused scenes), no polling when the window is hidden, chunk threads = cores - 2 (max 6), per-set instance buffers
that are never rewritten, half-resolution underpaint. If it runs hot: `ASCII_WORKERS=3`, or a smaller window (the
cost is mostly overdraw, which scales with the window area).

## CI

`.github/workflows/native-macos.yml` (manual trigger) builds and tests on `macos-14`. The one push-triggered attempt was
refused by GitHub ("macos-14-arm64-us-default is not supported" for this repository), so nothing has run on a Mac yet.

## Known limits and differences

- Not tested on a Mac: this was developed and verified on Linux with a software Vulkan driver. The Mac build is
  type-checked for `aarch64-apple-darwin` only (`cargo check --target aarch64-apple-darwin`), and the real Metal path,
  mouse capture (`CursorGrabMode::Locked`), Retina scaling and fps are to be checked on the machine.
- Atlas font is DejaVu Sans Mono Bold on every platform (the webapp falls back to Menlo when DejaVu is missing).
- Scrolling: wheel notches map to the browser's 100-pixel step; a trackpad sends pixels directly.
- The window renders at physical pixels (Retina 2x), as the webapp does at pixel ratio 2.
- Dock-icon "Open With" for `.stl` is declared in `Info.plist` but not wired (winit 0.30 does not forward it); drag and
  drop onto the window and the command line work.
- No UI, no settings panel (the webapp has none either).
