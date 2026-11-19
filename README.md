# ASCII Scene

Turns any 3D model (STL) into a scene made of ASCII characters, each one a
small card oriented in 3D. See `how-it-works.md` for the technique and
`improvements.md` for planned features.

One Rust code base runs everywhere: the same app (window, input, renderer,
world streaming, player) builds for macOS, Linux and Windows, and for the web,
where it is compiled to WebAssembly and draws with WebGPU.

## Layout

```
engine/          Rust engine: STL to cards, procedural scenery, infinite world
  src/stl.rs       STL reader (binary + ASCII), never panics on bad input
  src/mesh.rs      cleanup, Z-up -> Y-up, normalization, crease-aware normals
  src/cards.rs     stratified area sampling, card frames, glyph/colour picks
  src/rng.rs       seeded PCG32 (same seed = same scene, everywhere)
  src/noise.rs     3D cellular + value noise for the glyph rules
  src/scenery/     procedural assets, ported from the `scenery` Python package:
                   rocks, plants (fern, hostas, elephant ear, rhubarb, grass,
                   reeds, wildflowers), bushes (7 kinds), trees (pine, spruce,
                   oak, birch, maple, dead), material table, skinning to cards,
                   baked shadows (occlusion grid), gallery sheets,
                   terrain (5 presets, droplet erosion, lake basin, a stream
                   carved downhill into the lake, worn footpaths), biome
                   scattering with distance LOD and a per-object character
                   budget, ground / water / sky dome, rain and leaf particles,
                   and the 5 landscape presets (meadow, forest, lake, valley, alpine)
  src/scenery/world.rs  the infinite world: terrain, lakes, streams, trails,
                   biomes and scattering as functions of (seed, position),
                   built in 32 m chunks with glyphs sized from the viewer
  src/testbed/     test scenes only (the pine from pine_ascii.py), feature `testbed`
  tests/           scenery statistics checked against the Python reference
native/          the app, for every platform (see native/README.md)
  core/            platform-free logic: session, camera, player, physics,
                   weather, world streaming, jobs
  render/          wgpu renderer and WGSL shaders (Metal, Vulkan, DirectX, WebGPU)
  app/             the shell (winit window or web canvas), the job executor
                   (threads on desktop, Web Workers on the web), CLI and tools
web/             the web page: starts the app, gives it workers, forwards dropped files
  src/main.ts      start-up
  src/worker.ts    a Web Worker running the app's job entry point
  src/hooks.ts     window.__ascii for tests (dev and test builds only)
  public/models/   test STL files (regenerate: npm run models)
scripts/         model generator, build scripts, browser e2e test
```

## Commands

Desktop: see `native/README.md` (`scripts/build-macos.sh`, `scripts/build-linux.sh`).

Web: needs Rust (`rustup target add wasm32-unknown-unknown`), `wasm-pack` and Node.

```
npm install
npm run dev        # build the app for the web, start the dev server
npm run build      # production build in dist/ (static files, host anywhere)
npm test           # Rust tests, typecheck + build, headless-Chrome e2e, production check
```

The web version needs WebGPU: Chrome and Edge, Safari 26 and later, Firefox
141 and later (on Windows; on macOS from 147). There is no WebGL fallback.

Keys (every platform): `1`-`4` test models, `6`-`9` scenery galleries (rocks,
plants, bushes, trees), `M` `F` `L` `V` `A` landscapes (meadow, forest, lake,
valley, alpine), `I` the infinite world, `P` walk (WASD / arrows, Shift run,
Space jump, mouse look), `W` wind (calm / breeze / storm), `R` rain on/off, `B`
blowing leaves on/off, `F3` performance log. Drag to orbit, wheel to zoom,
right-drag to pan, drop an `.stl` to load it. On the web, `?perf` in the URL
turns the performance log (browser console) on.

Wind sways grass, leaves, needles and reeds; streams flow; rain falls round
the camera and dims the sun; leaves blow across the scene. All animated in the
shader, so the weather costs almost nothing per frame.

Visual references live in `tests/golden/`: both `ascii-scene golden` (desktop)
and the web e2e test compare against them. After an intended visual change,
check the images and rewrite them with
`native/target/release/ascii-scene golden tests/golden OUTDIR --update`.

See `docs/branches.md` for what was built on the side branches and what of it is on `master`.
