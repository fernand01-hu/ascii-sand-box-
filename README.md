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
Dev shortcuts: keys `1`-`4` switch test models, drop an `.stl` on the page to load it.
