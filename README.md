# ASCII Scene

Turns any 3D model (STL) into a scene made of ASCII characters, each one a
small card oriented in 3D. See `how-it-works.md` for the technique and
`improvements.md` for planned features.

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
                   oak, birch, maple, dead), material table, skinning to cards,
                   baked shadows (occlusion grid), gallery sheets
  src/testbed/     test scenes only (the pine from pine_ascii.py), feature `testbed`
  tests/           scenery statistics checked against the Python reference
  src/lib.rs       WASM bindings (Engine, CardConfig)
web/
  src/engine/      Web Worker running the WASM engine + promise client
  src/render/      glyph atlas, instanced card shader, viewer (orbit, resize)
  src/main.ts      wiring
  public/models/   test STL files (regenerate: npm run models)
scripts/           model generator, WASM smoke test, browser e2e test
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
Dev shortcuts (dev/test builds only): keys `1`-`4` test models, `5` testbed pine,
`6`-`9` scenery galleries (rocks, plants, bushes, trees), drop an `.stl` to load it.

Visual references for the e2e test live in `tests/golden/`; after an intended
visual change, check `test-results/` and run `UPDATE_GOLDEN=1 npm run test:e2e`.
