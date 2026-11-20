# ASCII Scene

A scene editor drawn entirely in ASCII characters, each one a small card
oriented in 3D. It opens on a **blank canvas**: an endless flat map covered
in neat rows of `#`, under an animated sky with wind, rain and blowing
leaves. Painting the ground and placing procedural trees, bushes and rocks
on it is what `TODO.md` builds next. The engine also still turns any 3D model
(STL) into ASCII cards.

See `how-it-works.md` for the technique, `improvements.md` for ideas, and
`TODO.md` for the roadmap. New work happens on the `dev` branch, never
directly on `main`.

## Layout

```
engine/          Rust engine, compiled to WebAssembly
  src/stl.rs       STL reader (binary + ASCII), never panics on bad input
  src/mesh.rs      cleanup, Z-up -> Y-up, normalization, crease-aware normals
  src/cards.rs     stratified area sampling, card frames, glyph/colour picks
  src/rng.rs       seeded PCG32 (same seed = same scene, everywhere)
  src/noise.rs     3D cellular + value noise for the glyph rules
  src/scenery/     procedural assets, ported from the `scenery` Python package:
                   rocks, plants (fern, hostas, elephant ear, rhubarb, grass,
                   reeds, wildflowers), bushes (7 kinds), trees (pine, spruce,
                   oak, birch, maple, dead), material table, skinning to cards
                   with a per-object character budget, baked shadows
                   (occlusion grid), gallery sheets, and an asset variant
                   cache (`library.rs`) for placing many copies
  src/scenery/canvas.rs  the canvas: flat ground of '#' rows on one world
                   grid, built in 32 m chunks from each chunk's painted tiles
                   and placed objects, glyphs sized from the viewer
                   (power-of-two steps, so rows line up)
  src/scenery/sky.rs     sky dome, sun and wind directions, rain and leaf particles
  src/testbed/     test scenes only (the pine from pine_ascii.py), feature `testbed`
  tests/           scenery statistics checked against the Python reference
  src/lib.rs       WASM bindings (Engine, CardConfig, CanvasWorld, galleries)
web/
  src/engine/      Web Workers running the WASM engine (one main worker plus a
                   pool that builds canvas chunks in parallel) + promise client
  src/render/      glyph atlas, instanced card shader, viewer (orbit, resize, frame stats)
  src/ui/          TUI look (tui.css) and the debug terminal + perf overlay
  src/app/         app core, the edited map (map.ts: paint + objects per
                   chunk), canvas chunk streaming, terminal commands, dev
                   tools; player and
                   physics are kept for the later play mode (not wired to a key)
  src/main.ts      wiring
  public/models/   test STL files (regenerate: npm run models)
scripts/           model generator, WASM smoke test, browser e2e test, canvas benchmark
```

## Commands

Needs Rust (`rustup target add wasm32-unknown-unknown`), `wasm-pack` and Node.

```
npm install
npm run dev        # build the engine, start the dev server
npm run build      # production build in dist/ (static files, host anywhere)
npm test           # Rust unit tests, typecheck + build, WASM smoke test, headless-Chrome e2e
```

In the viewer: drag to orbit, wheel to zoom, right-drag to pan.

Debug terminal (dev/test builds only): press `` ` `` (the key left of `1`,
`²` on AZERTY) or `F1`, then type `help`. Try `paint grass 0 -20 6`,
`place tree:oak 4 -25`, `wind 0.8`, `view 6`, or `perf on` (also `F3`) for
FPS, frame time, cards and chunks.

Dev shortcuts (dev/test builds only, while the terminal is closed):
- `C`: back to the canvas
- `1`-`4`: test models
- `5`: testbed pine
- `6`-`9`: scenery galleries (rocks, plants, bushes, trees)
- `W`: wind (calm / breeze / storm)
- `R`: rain on/off
- `B`: blowing leaves on/off
- drop an `.stl` file to load it

From code: `app.showCanvas(seed, day)`, `app.map.paintCircle(x, z, r, 'grass')`,
`app.map.addObject({ kind: 'tree:oak', x, z })`, `app.setViewRadius(6)`,
`app.showGallery('trees', seed)`,
`app.setEnvironment({ wind: 0.5, rain: 1, leaves: 0.8 })` (all 0..1). Wind
sways grass, leaves, needles and reeds. Rain falls round the camera and dims
the sun, and leaves blow across the scene. All of it is animated in the
shader, so the weather costs almost nothing per frame.

Visual references for the e2e test live in `tests/golden/`; after an intended
visual change, check `test-results/` and run `UPDATE_GOLDEN=1 npm run test:e2e`.
`node scripts/bench-world.mjs` (after `npm run build:test`) times how long
the canvas takes to stream in.

See `docs/branches.md` for what was built on the side branches and what of it is on `master`.
