# ASCII Scene, the app (desktop and web)

The whole app, one code base: the engine, the world, the keys, the renderer.
On desktop it opens a window, spreads the work over threads and draws through
wgpu (Metal on macOS, Vulkan on Linux, DirectX on Windows). On the web the same
crates are compiled to WebAssembly, draw through WebGPU and build in Web
Workers; `web/` only holds the page that starts it.

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

For the web (needs `wasm-pack` and Node, see the root README):

```
npm run dev                              # http://localhost:5173, ?perf for the perf log
npm run build                            # -> dist/, static files
```

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

## Measuring stutters (desktop)

```
scripts/dev-loop.sh --day        # runs the world; relaunches in place whenever the profiling build changes
(cd native && cargo build --profile profiling)   # from elsewhere: triggers that relaunch
```

`dev-run/trace.jsonl` gets one line per second (fps, worst and p99 frame, GPU time per pass when the device has
timestamp queries, cards drawn) and one per frame over `ASCII_SPIKE_MS` (25) with where its time went.
`dev-run/tune.txt` is read live (`autowalk`, `fade`, `underpaint`, `fog`). Outside the loop: `ASCII_TRACE=FILE`,
`ASCII_TUNE=FILE`, `ASCII_POSE=FILE` (reopen the world where the last run left it), `ASCII_AUTOWALK=1`.
`ascii-scene shot ... --zoom N` dezooms before the shot.

## Keys (every platform)

- drag: orbit, right-drag: pan, wheel: zoom. Drop an `.stl` on the window (or the page) or pass it on the command line.
- `1`-`4` test models, `6`-`9` galleries (rocks, plants, bushes, trees),
  `M` `F` `L` `V` `A` landscapes (meadow, forest, lake, valley, alpine), `I` the infinite world.
- `P` walk (WASD / arrows, Shift run, Space jump, mouse look; click to capture the mouse, `Esc` to release it).
- `W` wind (calm / breeze / storm), `R` rain, `B` blowing leaves.
- `F3` toggles the performance log on stderr, or the browser console (fps, worst frame, cards drawn, draw calls, chunks loaded / pending, chunk build time).

## Architecture

```
engine/          Rust engine (scene generation), plain Rust API.
                 `libm` feature: pure-Rust math, same scene on every platform.
native/
  core/   ascii_core    ALL the logic, no platform dependency
  render/ ascii_render  wgpu renderer (WGSL shaders, atlas, underpaint), no window
  app/    ascii_native  library `ascii_app`: the shell (winit window or web canvas, input
                        mapping, frame loop), the job executor (threads / Web Workers);
                        binary `ascii-scene`: CLI and off-screen tools (desktop)
web/             the page: loads the app module, creates the workers, forwards dropped files
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
- `wire.rs` jobs and results as bytes, for executors that share no memory (Web Workers).
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

**`ascii_native`** (library `ascii_app`, binary `ascii-scene`):
- `shell.rs` the one shell for every platform: winit event loop (a canvas on the web), mouse capture, dropped files,
  surface, frame pacing (vsync on desktop, the display's frames in a browser; no drawing when nothing moves, no
  polling when hidden). GPU start-up is async in a browser, so the GPU lands in a slot the loop picks up.
  `send` / `with_session` / `capture` / `snapshot` let code outside the loop (the page, test hooks) reach the app.
- `pool.rs` (desktop) N long-lived threads, one `Worker` each, queue + channel; the render thread only `try_recv`s.
- `web.rs` (wasm32) `start` (called by the page), `WebPool` (jobs over Web Workers, one at a time each, bytes
  transferred), `worker_run` (what each worker calls), and the test hooks behind `window.__ascii`.
- `headless.rs` (desktop) `shot`, `golden [--update]`, `bench`.

Porting to another platform means another start-up and, if it has no threads, another `JobExecutor`.

## Tests

```
cd native && cargo test --release --workspace          # core, parity, renderer (GPU tests skip without an adapter)
WGPU_BACKEND=vulkan cargo test --release -p ascii_render  # force the software Vulkan driver (lavapipe) on Linux
native/target/release/ascii-scene golden tests/golden out     # compare with the reference images (from the repo root)
native/target/release/ascii-scene golden tests/golden out --update   # rewrite them after an intended change
npm run build:test && npm run test:e2e                  # the web build in headless Chrome (WebGPU on SwiftShader)
```

The parity fixtures (`core/tests/fixtures/`) were recorded from the former TypeScript webapp and its WASM engine
before the web moved onto this code; they are kept as frozen references.

- `core/tests/parity.rs`: mulberry32 bit-identical to JS; `chunk_cards` identical to `chunks.ts` (table and card
  order after the shuffle); physics trajectories identical to `physics.ts` within 1e-6 over five scenarios
  (walk, run, jump, collider, water, various frame rates). (The check against the former WASM engine went
  with it: every platform now runs this engine.)
- `core/tests/session.rs`: a whole world session run twice gives bit-identical render data; the player walks the
  streamed world; galleries and STL load; a broken STL reports an error.
- `render/tests/offscreen.rs`: off-screen render is deterministic and matches the reference for the sphere.
- `core/src/wire.rs`: every job kind and its result survive the trip through bytes.
- `scripts/e2e-test.mjs`: the web build starts on WebGPU, builds in workers, answers keys, mouse, dropped and broken
  files and resizing, walks, streams the world, and matches the references (frames read back by the app itself).

## Determinism

- The engine's trigonometry went through the platform's libm, which differs between systems and from the one in
  WASM; erosion and scattering amplify that into different landscapes (the lake had 7% fewer cards and other
  trees). With the `libm` feature (on for the native build) every `sin`/`cos`/`exp`/`pow`... goes through the
  pure-Rust `libm` crate (`engine/src/fm.rs`), on desktop and on the web alike.
- Result: native and WASM produce the same card counts for the three landscapes (470910, 849891, 455465) and
  11 of 12 reference buffers bit for bit; in the twelfth, 14 of 2138 cards differ in the last bit (max 4e-7).
- The reference thumbnails (`tests/golden`) are written by this renderer (`golden --update`, on lavapipe). Other
  drivers land within about 2 (mean per-channel difference over drawn tiles): `sin()` in the per-card hash differs
  between GPUs, which changes individual card twists and wind phases. The web e2e test allows 2.5.

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

- Web: WebGPU only, no WebGL fallback. Each Web Worker holds its own copy of the asset cache (no shared memory), so
  the first world chunks build slower than on desktop.
- Atlas font is DejaVu Sans Mono Bold on every platform.
- Scrolling: wheel notches map to the browser's 100-pixel step; a trackpad sends pixels directly.
- The window (and the web canvas) renders at physical pixels (Retina 2x).
- Dock-icon "Open With" for `.stl` is declared in `Info.plist` but not wired (winit 0.30 does not forward it); drag and
  drop onto the window and the command line work.
- No UI, no settings panel.
