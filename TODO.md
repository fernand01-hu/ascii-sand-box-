# TODO

Built from `thingIWhantToAdd` and ordered by what to build first. Each step
lays the groundwork for the ones after it. Items marked **(added)** were not
in the original notes.

## Decisions

- **Play mode comes later.** Walking (`P`), physics and collisions are on
  hold until Phase 4. Keep the code, but turn it off and don't maintain it
  for now.
- **The weather stays.** Wind, rain and blowing leaves give the world life.
  Nothing in this list may remove them, and everything new must work with
  them.
- **Blank canvas.** An empty map is flat ground covered in neat, evenly
  spaced, parallel `#` characters. You paint on top of that.
- **View distance.** The world has no edge, but you only see a set number of
  chunks around the camera (`view_radius`, in chunks). Things fade out at
  that edge.
- **Performance target: 30 FPS without a GPU** (software rendering). The
  number of characters drawn is the main cost, so the character limits
  (step 4) come early.
- **Branches.** Never commit to `main` directly.
  - `dev` is the working branch.
  - Each step gets its own branch off `dev` (e.g. `step-01-blank-canvas`)
    and is merged back into `dev` when it works.
  - `dev` is merged into `main` through a pull request at the end of each
    milestone.

## Milestones

A milestone is a stopping point where everything built so far works
together and can be tested and shown. Then you merge to `main` and start the
next one.

- **Milestone 1: "I can paint and save a scene."** Steps 1–9. Done on
  `dev`, not merged into `main` yet: on 2026-11-19, PR #1 (native desktop
  app + WebGPU renderer, which removed the TypeScript web app) was merged
  into `main`, so the two lines diverged. Decision (2026-11-20): hold off.
  `main` is left alone and work continues on `dev` until the user decides
  how to bring them together.
- **Milestone 2: "I can fill a scene with objects."** Steps 10–12.
- **Milestone 3: "It looks good."** Steps 13–15.
- **Milestone 4: "I can walk in it."** Phase 4.

## Phase 1: Foundations

- [x] **1. Remove the procedural map and start from a blank canvas.**
  (Done on `step-01-blank-canvas`.)
  - [x] Removed the generated terrain, lakes, streams, trails, biome
    scattering and landscape presets (`world.rs`, `terrain.rs`, `scene.rs`,
    the ground half of `landscape.rs`, the biome half of `scatter.rs`).
  - [x] Kept the asset generators and the gallery. The asset variant cache
    moved to `library.rs`; `skin_placed` and the glyph-size rule moved to
    `skin.rs` (the object brush will need them).
  - [x] Kept the weather: wind, rain, leaves and the sky dome (now `sky.rs`).
  - [x] The new ground is the blank canvas (`canvas.rs`): rows of `#` on one
    flat world grid, chunked. The app opens on it.
  - [x] Turned off the `P` play mode (the player and physics code is kept).
  - [x] Landscape presets and `M F L V A I` keys: deleted. `C` returns to
    the canvas.
  - [x] Updated the e2e golden images, smoke test and production check.
  - [x] `scripts/bench-world.mjs` now measures the canvas.
  - [x] Rewrote the README.
  - [x] `scenery.zip` stays out of the repo (in `.gitignore`).

- [x] **2. Chunk system for editable, unlimited maps.** (Done on `step-02-chunks`.)
  - [x] The edits live in `MapData` (`web/src/app/map.ts`), stored per
    32 m chunk:
    - a ground tile layer: 64 x 64 tiles of 0.5 m (canvas `#` / grass /
      sand / water / rock), one byte each
    - a list of placed objects (kind + seed + position + yaw + scale).
      Generator params get added in step 11.
  - [x] The engine builds a chunk from that data (`canvas.rs`): painted
    tiles use their material's characters on the same neat grid. Objects
    are skinned with baked shadows from the chunk's own objects.
  - [x] Chunks within `view_radius` of the camera are loaded and the rest
    dropped (`app.setViewRadius(n)`, 1–16; the haze follows it). Untouched
    chunks are plain canvas: generated on the fly, never stored.
  - [x] **Rules for things that cross chunk borders:**
    - **Ground tiles:** each tile belongs to exactly one chunk, based on its
      coordinates. A paint over a border writes into every chunk it touches.
    - **Objects:** an object belongs to the chunk that holds its base point
      and is drawn whole by it, even if its crown hangs over the next chunk.
    - **Drawing:** render bounds come from the cards themselves, so culling
      never cuts off a crown that crosses the border.
    - **Rebuilds:** an edit rebuilds only the chunks it touched. Neighbours'
      shadows across borders come with step 14.
  - [x] Optimizations:
    - only "dirty" chunks rebuild after an edit, before anything else
    - edits made together (one stroke or script) start one build per chunk
    - a build that finishes after a newer edit is shown, then rebuilt again
    - the existing chunk worker pool and frustum culling are kept
    - memory is bounded by the view radius. Erased chunks are not stored.
  - Dev hooks until the brush exists: `__ascii.paintRect`, `paintCircle`,
    `addObject`, `removeObject`, `setViewRadius`, `worldStats`.

- [x] **3. Debug terminal.** (Done on `step-03-terminal`.)
  - [x] An in-app console: `` ` `` (the key left of 1, `²` on AZERTY) or
    `F1` opens and closes it, `Esc` closes it, Up/Down walk the history,
    Tab completes commands and kinds.
  - [x] Commands: `help`, `clear`, `stats`, `perf`, `chunks`, `view`,
    `pos`, `tp`, `canvas`, `seed`, `weather`, `wind`, `rain`, `leaves`,
    `freeze`, `kinds`, `paint`, `place`, `objects`, `remove`, `model`,
    `gallery`, `pine`.
  - [x] Its log shows command output and everything written to the
    browser console.
  - [x] **(added)** A performance overlay (`F3` or `perf on`): FPS (green
    at 30 or more), frame and draw time, cards drawn / loaded, cards per
    chunk, chunks loaded / building / dirty, worker queues.
  - [x] The old hotkeys still work while the terminal is closed. Every one
    of them now has a command too.
  - [x] It is the first TUI piece (`web/src/ui/tui.css`: palette, double-line
    boxes with titles in the border). Dev/test builds only.

- [x] **4. Limit overlapping characters on screen.** (Done on
      `step-04-char-limit`. Moved up from Phase 3: on a CPU-only machine the
      number of characters is the main cost.)
  - [x] Ground: each 4 m cell picks its row and column spacing so that at
    most 3 grid points fall inside one glyph's footprint as seen from the eye.
    Low views spread the rows going away from the eye. Rows stay on one
    world grid (i x step), so the levels nest and line up.
  - [x] Objects: each chunk keeps at most 6 object glyphs per glyph-sized
    patch of view, nearest first, so what hides behind a nearer crown goes.
  - [x] Chunks are rebuilt when the eye looks at them from a very
    different height, not only when it moves sideways.
  - [x] The sky dome (~97k cards) is split into direction sectors, and the
    ones out of view are skipped. This was the biggest single saving.
  - [x] **(added)** An optional global card budget per frame (`budget 80k`
    in the terminal; off by default): nearest chunks draw in full, farther
    ones draw an even sample. It makes holes in the far rows, so it is off
    unless a machine needs it.
  - [x] Measuring: `stack` in the terminal, `scripts/bench-stacking.mjs`
    (4 views). Before → after, worst 5% of screen cells: canvas 27 → 5,
    canvas at eye level 62 → 4, forest 121 → 27. Cards drawn per frame:
    143k → 50k (canvas), 215k → 69k (forest).
  - [ ] Left over: crowns in *different* chunks can still line up behind each
    other near the horizon (that's the remaining forest 27). Fixing it needs
    each chunk to know the objects in front of it. Do it together with
    step 14, which needs neighbour data for shadows anyway.

- [x] **5. TUI-style interface (old-school ASCII game look).** (Done on
      `step-05-tui`.)
  - [x] Monospace font, double-line box borders with the title set into the
    top edge, reverse-video selection, a small fixed palette
    (`web/src/ui/tui.css`). No rounded or modern widgets.
  - [x] **(added)** Reusable pieces (`web/src/ui/widgets.ts`): panel (with a
    stack: the top panel gets the keys, Esc closes it), list / menu, slider
    `[####····]`, checkbox `[x]`, text input, text line. Keyboard first,
    and the mouse works too.
  - [x] The first real interface, in every build (`web/src/ui/hud.ts`): a
    status bar, an `Esc` menu, settings (canvas seed, day / dusk, view
    distance, wind / rain / leaves, FPS in the status bar, card budget)
    and help (`?`).
  - [x] The debug terminal is rebuilt from the same panel and text input.
    The brush panel (step 7) and save dialog (step 9) will be too.

- [x] **5b. Debug tools (added on request).** (Done on
      `step-05b-debug-tools`.) The terminal and every debug tool ship in
      all builds. One shared list of debug options drives the menu
      (`Esc` → Debug), the terminal (`debug <option> on|off`) and hotkeys,
      and choices are remembered between visits.
  - [x] Info box (`F2`): position, chunk and tile, compass facing, orbit
    target, world clock and speed, weather, seed and view, map counts, and
    stats pinned with `watch`.
  - [x] Overlays: chunk borders coloured by state (`F4`), chunk labels,
    object labels (`#id kind`), object outlines (box + footprint), paint
    tile grid round the cursor, culling boxes, origin and axes, hidden
    solid shapes as wireframe, stacking heat map, performance overlay
    (`F3`; title no longer cut off).
  - [x] Light view (baked sun white, sky blue) and glyph-size tint.
  - [x] Glyph inspector: point at any character to see its material, mode,
    chunk, object, size, colour and light.
  - [x] Cursor readout: the ground point under the mouse (chunk, tile,
    paint). Step 6 will reuse it.
  - [x] Terminal: `chunk`, `obj`, `here`, `tile`, `goto`, `look`, `cam`,
    `time`, `speed`, `day`, `dusk`, `stream`, `rebuild`, `fill`,
    `scatter`, `clearmap`, `debug`, `set`, `watch`, `profile`, `bench`,
    `verify`, `mem`, `workers`, `link`, `screenshot`, `alias`, `bind`,
    `repeat`, `copy`, `log save`; `;` chains commands, `!!` repeats;
    `help` is grouped.
  - [x] Rebuild log (why each chunk was built, how long it took), freeze
    streaming, determinism check (`verify`).
  - [x] Settings remembered between visits. The canvas keeps your weather
    when you come back to it. A warning counter (`⚠ n`) sits in the
    status bar. Share links (`link`) bring back seed, camera, settings and
    debug options.

## Phase 2: Scene editor

- [x] **6. (added) Editing camera and ground picking.** (Done on
      `step-06-editing-camera`.)
  - [x] Top-down view (`T`): the camera looks straight down, north up.
    Drag pans, the wheel sets the height, the arrow keys pan (Shift is
    faster), and `T` again returns to the same orbit view. It is a
    perspective camera pointing down, not an orthographic one, because
    glyph sizes depend on the distance from the eye.
  - [x] Grid on the ground (`G`). Its spacing follows the height or the
    snap size, and chunk borders are drawn brighter.
  - [x] Snapping (off / 0.5 / 1 / 2 / 4 / 8 m), with a marker on the
    snapped point under the mouse.
  - [x] Ground picking: the ground point under the mouse (from step 5b's
    cursor). `editor.point()` is what the brushes will use.
  - [x] In the menu (Settings → editing), the terminal (`camera`, `grid`,
    `snap`, `set`) and the status bar. Remembered between visits.

- [x] **7. Terrain brush on the 2D plane.** (Done on `step-07-terrain-brush`.)
  - [x] Paint grass, sand, water and rock onto the `#` canvas: `P` turns the
    brush on, the left button paints, `1`–`4` pick the paint. In the orbit
    view the middle button rotates; right drag pans in both views.
  - [x] Brush size (`[` / `]`, 0.25–32 m), shape (circle / square) and
    strength (share of tiles each dab paints).
  - [x] **(added)** An eraser (`E`) that paints the `#` canvas back.
  - [x] **(added)** Soft edges: tiles near the rim are painted with a chance
    that falls off toward the edge, so sand fades into grass. The dice are
    a hash of tile and stroke, so passing back and forth doesn't flicker.
  - [x] Strokes follow the snapped cursor, with dabs evenly spaced along the
    path. Each finished stroke carries every tile change (old → new) for
    step 8's undo.
  - [x] Brush panel (docked, from the widgets), menu item, status bar,
    terminal (`brush`, `dab`, `stroke`), settings remembered.
  - [x] **(added)** Unit tests for the brush maths (`npm run test:unit`,
    part of `npm test`).

- [x] **8. (added) Undo / redo.** (Done on `step-08-undo`.)
  - [x] `Ctrl+Z` undoes, `Ctrl+Y` / `Ctrl+Shift+Z` redoes (Cmd on a Mac).
    In a text field (the terminal) they keep their usual text meaning.
  - [x] The map reports every edit (tiles with old and new codes, objects
    added or removed), so every change is undoable: brush strokes,
    `place`, `remove`, `scatter`, `fill`, `paint`, even `clearmap`.
    Objects come back with their id.
  - [x] One brush stroke is one action, labelled with what it did ("paint
    sand (312 tiles)"). One terminal line is one action too. Only the
    chunks an undo touches are rebuilt.
  - [x] Terminal `undo [n]`, `redo [n]`, `history`; Undo / Redo in the
    menu; the status bar says what was undone.
  - [x] Limits: 500 actions or 2 million tile changes. The oldest go first.
  - [x] Unit tests for the history and the map's edit records
    (`npm run test:unit`).

- [x] **9. Save / load scenes.** (Done on `step-09-save-load`. This
      completes milestone 1: "I can paint and save a scene".)
  - [x] Save the recipe, not the cards (`app/scenefile.ts`): canvas seed and
    time of day, weather, camera, the paint of chunks that hold any
    (run-length coded), and the objects (kind, position, yaw, scale, seed).
    Paints are stored by name, so files survive new paints.
  - [x] **(added)** Only edited chunks are saved.
  - [x] **(added)** A `format` and a `version` field from day one. Newer
    files are refused with a clear message, and broken ones say what's
    wrong.
  - [x] **(added)** Autosave every 30 s when something changed and when the
    page closes, restored on reload (Settings / `autosave on|off`).
  - [x] **(added)** Named scenes in the browser (`Ctrl+S`, the menu's Save /
    load panel, `save` / `load` / `scenes` / `delete`), plus download and
    upload of `.scene.json` files (or drop one on the page).
  - [x] Loading is one undoable change. `new` starts an empty scene (also
    undoable).
  - [x] **(added)** A save → load round-trip test in `npm test` (unit), plus
    an e2e test with a real file download, upload and page reload.
  - [x] **(added)** Export the view as PNG or plain-text ASCII
    (`export png|text|print`).

- [x] **10. Object brush: place over an area.** (Done on `step-10-object-brush`.)
  - [x] Object brush (`O`): spray (`1`) paints trees, bushes, rocks, grass
    and flowers over an area with a density (objects per 100 m²). Single
    (`2`) places one per click. Erase (`3`) removes the objects under the
    brush. One kind or a family mix ("any tree").
  - [x] Even spacing (dart throwing, `app/spray.ts`): every new object keeps
    its family's room (trees 4 m, bushes 1.6, rocks 1.4, plants 0.6, times
    a spacing factor) from every neighbour, across chunk borders too.
    Painting the same spot again fills gaps, then stops.
  - [x] **(added)** Random variation per object: seed, rotation, size ±.
  - [x] **(added)** Select tool (`V`): click to select (outline from the
    engine's box), drag to move (snapping applies, keeps the id), `R`
    turns, `[` `]` resize, `Delete` removes, `Esc` lets go. Each is one
    undoable action.
  - [x] One editing tool at a time (terrain brush, object brush, select).
    Panels, menu items, status bar, terminal (`tool`, `objbrush`, `select`,
    `move`, `rotate`, `resize`), settings remembered.
  - [x] Unit tests for the spray maths. e2e: real drags, spacing across a
    chunk border, single, erase, select, move, turn, delete, undo.

- [x] **11. Generator parameters in the brush.** (Done on
      `step-11-generator-params`.)
  - [x] Each family exposes its settings (`engine/src/scenery/params.rs`):
    - **conifers:** height, crown start, whorl spacing, branches per whorl,
      branch length, sag, needle density and size, dead branches, trunk,
      sway
    - **broadleaf trees:** height, trunk height, crown width and height,
      lobes, branch density, twig length, leaves per twig, leaf size,
      droop, trunk, lean, gnarl
    - **bushes:** size, width, height, stems, density, twig, leaves, leaf
      size, upward growth, berries / blossoms
    - **rocks:** size, width, height, lumpiness, facets, moss (not on
      pebbles, which are always bare)
    - **plants:** size

    A Rust test proves each setting changes the object and that defaults
    give the usual one exactly.
  - [x] The panel, the terminal (`param`) and saved scenes are all
    generated from one description per setting (name, label, range,
    default). Objects store their values (only when off the defaults);
    scene files store them by name, so new settings never break old files.
    For a mix ("any tree"), the panel offers the settings the family shares.
  - [x] **(added)** A live preview: a small viewer of its own (drag to turn
    it), rebuilt a moment after a change, with "another variant".
  - [x] **(added)** Named presets (`preset save|load|delete`, or the panel's
    picker and "save as").
  - [x] The engine caches assets per parameter set and starts the cache over
    past 600 assets.

- [x] **12. (added) Height brush.** (Done on `step-12-height-brush`.
      Milestone 2, "I can fill a scene with objects", is complete.)
  - [x] Height brush (`H`): raise (`1`), lower (`2`), smooth (`3`), flatten
    (`4`, to the height where the stroke starts), size and strength,
    smooth cosine falloff (`app/heightbrush.ts`). One stroke is one undo.
  - [x] Heights per chunk on a 1 m grid (33 × 33). Border points are shared
    and written into every chunk that holds them, so the ground is
    seamless. Flat chunks store nothing.
  - [x] The engine follows the heights. Ground glyphs sit on the surface and
    tilt with the slope. Objects stand on the ground. The opaque ground is
    a 1 m mesh, and physics heights come from it too. The glyph-stacking
    spread measures the view angle to the real surface, so a hillside
    facing you keeps its rows.
  - [x] The cursor finds the real ground under the mouse (it steps along
    the view ray). The grid, chunk borders, tile grid, brush outlines and
    markers drape over the terrain.
  - [x] Scene files version 2 store heights (centimetres). Version 1 files
    still load.
  - [x] Unit tests (falloff, modes, shared borders, undo, file round trip,
    version 1). Rust test on a sloped plane. e2e: drag, undo, every mode,
    cursor on a hilltop, an object on a hill, save / load.

## Phase 3: Visual quality

- [ ] **Look lab (branch `phase3-lab`).** Variants of steps 13-15 shown side by side, live:
  - 1, 2 or 4 panes, or a wipe, all showing the same camera. Each pane picks a lighting, weather and water variant.
  - Shared controls: time of day, wind, rain, leaves.
  - A test scene with camera spots (`lab scene`, `lab view lake`).
  - `L`, the toolbar button or `lab` in the terminal.
  - Once winners are picked, they become steps 13-15 and the rest is dropped.
  - Water waits on the user's reference video.

- [ ] **13. (added) Weather on painted scenes.**
  - Make sure wind sways painted grass, trees and reeds, rain falls over the
    whole view distance, and leaves blow from painted trees.
  - Water tiles react to wind and rain.
  - Add weather controls in the TUI and the debug terminal.

- [ ] **14. New lighting and shadow implementation (experiment).**
  - The current lighting is a baked occlusion voxel grid (`light.rs`). It
    must be re-baked whenever objects change, which clashes with live editing.
  - Try shadow maps in the shader, or a per-chunk bake that re-runs on dirty
    chunks and their neighbours.
  - Shadow maps are GPU work, so a per-chunk bake may suit the no-GPU target
    better. Measure both.
  - Work on a branch and compare screenshots side by side.
  - **(added)** Add a light-direction / time-of-day control in the debug
    terminal to test this.

- [ ] **15b. (added 2026-11-20) Organic ground: grass, sand, rock look natural again.**
  - **Problem:** painted ground looks artificial next to the old procedural landscapes, which looked beautiful.
    - The canvas puts painted grass, sand and rock on the same neat grid as the blank `#` rows.
    - Every glyph has the same tilt and nearly the same colour.
    - Tile borders are hard edges.
  - **What the old `landscape::ground_region` did, to bring back (from git, before `ef828b5`):**
    - glyphs scattered at random spots in 4 m cells (not rows), with the count from the view and the slope
    - each glyph tilted a little off the surface, at a random angle
    - its own colour variation per glyph, plus dry / lush patches of grass from noise
    - the material chosen by the land: rock on steep slopes, soil and moss under trees, wet sand at the water
    - water drawn in small clusters of wave glyphs coloured by the sky
  - **Keep:**
    - blank canvas stays neat `#` rows (user's choice); only painted ground goes organic
    - the stacking limits (step 4), so the cost stays low
    - stable glyphs (Phase 5): positions and glyphs come from a hash of the world position, not from a random sequence, so a rebuild doesn't reshuffle them
  - **Borders:** materials mix over about 1 m (dithered) instead of meeting at a tile edge.
  - Compare old and new in the look lab before merging.
  - **(found 2026-11-20) Steep slopes need more glyphs.** Mountain faces steeper than about 45 degrees get too few ground glyphs and read as black holes in the sky. The ground grid only has points every 0.5 m across the flat plan. Add glyphs in proportion to the real surface area, as the old `ground_region` did with its slope boost.

- [ ] **15. Rework the water.**
  - Better flow, edge foam and shoreline glyphs, and reflections or a
    glyph-ripple animation.
  - The water tiles from the terrain brush (step 7) are the natural place to
    do this.

## Phase 4: Play mode (later)

- [ ] Turn the `P` walk mode back on, with an Edit / Play toggle so editor
      keys and WASD don't clash.
- [ ] Physics reads ground height and type from the painted map instead of
      the old procedural terrain.
- [ ] Decide what happens in painted water (swim, wade, or blocked).
- [ ] Collisions with placed trees, rocks and big bushes.

## Phase 5: Smooth detail, then the GPU

**Goal:** when detail changes, nothing pops.
- Glyphs already on screen stay where they are.
- New glyphs fade in a few at a time, most important first. Moving away, the extra ones fade out the same way.
- The chunks that look most wrong update first.
- It stays cheap: the work is done when a chunk is built. Each frame, the renderer only moves one number per chunk that is changing.

**Decision (2026-11-20):** we keep our version. The native rewrite on `main` and `grosminet/*` is not merged. We port ideas from it by hand (step 22).

**Why it looks bad today (from the code):**
- **One big jump:** a chunk is rebuilt only once its glyph size is off by about 1.7x (`world.ts`). Glyph sizes then double or halve all at once.
- **Instant swap:** the new chunk replaces the old one in a single frame, all of it.
- **Objects redraw completely:** trees, bushes and rocks switch between 3 separately built versions (detail levels at 32 m and 90 m). The glyphs land in different places, so the whole object redraws.
- **A different set of glyphs survives:** the limit of 6 object glyphs per patch is recomputed from the new eye, so different glyphs are kept.
- **Random-looking order:** rebuilds are sorted only by distance to the chunk centre. Every move rebuild waits behind all new chunks. Nothing checks whether a chunk is on screen or how wrong it looks.
- **Ground is half-way there:** its levels already nest (each coarser level keeps every other row) and each point keeps its colour. But glyph sizes jump and the swap is instant.

Order: 16 → 22. Steps 16-21 need no GPU, and they help the no-GPU target too (fewer rebuilds).

- [ ] **16. Measure the pop first (debug tools).**
  - Per rebuild, match glyphs by world position and count kept / added / removed. Show "kept %" in the chunk inspector and `chunks`. Today it is near 0% for objects.
  - `lod slow <factor>`: transitions in slow motion. `lod freeze`: stop all detail changes.
  - An overlay that colours chunks by how wrong their detail is (their priority), and glyphs by rank (step 18).
  - A short e2e check (a few frames of the camera flying toward a tree) that records the baseline numbers here.

- [ ] **17. Stable glyphs: same place, same glyph.**
  - A glyph's character, twist and colour come from a hash of its identity, never from build order or detail level:
    - ground: the grid point
    - objects: the object's seed plus the card's index in its full-detail list
  - The ground already does this for colour. Extend it to the character and twist.
  - Unit test: two builds from different eyes give identical glyphs wherever they overlap.

- [ ] **18. Nested detail with ranks ("keep the old, add the new").**
  - **Rank:** every glyph gets one. Coarse detail = the lowest ranks only. Finer detail = the same glyphs plus higher ranks. Any detail change then only adds or removes glyphs; the ones in common never move.
  - **Ground:** rank = the coarsest grid level the point is on, plus a small hash to spread glyphs within a level.
  - **Objects:** build each asset once, at full detail, and order its cards by importance:
    1. outline and silhouette
    2. trunk and main branches
    3. big leaves and rock faces
    4. inner filler, last

    Shuffle within each group (a fixed hash), so thinning stays even. Detail level n = the first k cards. This replaces the 3 separately built versions, which also uses less cache memory in the workers.
  - **Patch limit:** the 6-glyphs-per-patch limit keeps the lowest ranks, not just the nearest glyphs. The kept set then barely changes when the eye moves.
  - **Size:** when fewer glyphs are shown, the kept ones grow to cover the gap (as now), but smoothly with distance instead of in doubling steps.
  - Tests: every level holds the level below it (ground and objects); a rebuild after moving 30% closer keeps at least 95% of its glyphs.

- [ ] **19. Gradual transitions (fade in, fade out).**
  - **Getting closer:** when a rebuilt chunk arrives, the glyphs it shares with the old one stay put (drawn once, no flicker). The new glyphs fade in over about 0.6-1 s, in rank order (important first, filler last), growing from a dot instead of popping.
  - **Moving away:** glyphs no longer needed fade out in reverse rank order, filler first. Then the old set is freed.
  - **Ground:** glyph size changes ease over the same time.
  - **How:** a rank per card in the card buffer, and one number per chunk (`shownRank`) that animates from the old amount to the new one. The shader turns that into each card's fade and size. Per frame, the CPU only updates that number for the chunks that are changing.
  - **Edits stay instant (or at most 0.15 s):** you need to see your brush at once. Rain, leaves and the sky are unaffected.
  - Setting `lodfade` (seconds, 0 = instant as today); terminal `lod fade 0.8`.

- [ ] **20. Most important first (update priority).**
  - **One score per chunk, instead of distance only:** how wrong it looks on screen. That is the detail error in pixels (how far its glyph size is from right), times how big the chunk is on screen, times whether it is on screen (off-screen last), times a bonus near the middle of the view and the cursor.
  - **Order:**
    1. edited chunks (as now)
    2. holes (visible chunks not loaded yet): a hole is worse than a coarse patch
    3. visible chunks, biggest error first
    4. the rest
  - **Fresh order:** re-sort as the camera turns, drop builds that went stale, and cap builds per second so a fast move doesn't flood the workers.
  - **Some glyphs faster than others:** fade speed per group. Outline and trunk fast (about 0.3 s), leaves medium, ground filler slowest, edits instant. This is a table in the settings.
  - Inside a chunk, ranks already make the important glyphs come first (step 19).
  - Debug: a priority heat-map overlay, and the build queue in order in the terminal.

- [ ] **21. Continuous detail (fewer rebuilds).**
  - **Headroom:** build each chunk with detail for about 30% closer than its build eye. The extra glyphs are ranked last and hidden.
  - **Detail follows the distance:** every frame, the shader shows the right amount for the current distance (a rank cut-off), so moving shows and hides glyphs smoothly. No rebuild until the camera passes the headroom.
  - **Rebuild when:** the nearest part of a chunk is 25% nearer than it was built for, or its centre is 60% farther (the rules the native branch uses).
  - **Cost:** a few more cards per chunk in memory (measure it; cap it with the stacking limits), in exchange for most move rebuilds.
  - The same idea as "continuous detail / prefix culling" on the native branch, done in our three.js shader.

- [ ] **22. GPU integration.**
  - **Measure first:** our version in a real browser (Chrome, WebGL on the integrated Radeon) next to the software test. Record the perf overlay numbers here.
  - **Two quality modes:** keep a "no GPU" mode that holds 30 FPS or more in software, add a "GPU" mode, and pick between them from the measured frame time. Both appear in settings.
  - **GPU mode adds:**
    - shadow maps, if step 14's comparison favours them: a moving sun, shadows across chunk borders, live while editing
    - a longer view distance, with far ground out to 1 km (an idea from the native branch)
    - more glyphs per patch
  - **Later, optional:** a WebGPU renderer with a WebGL fallback. Ideas from the `grosminet` branches to port by hand: each card evaluated once per frame, the frame-time trace. Never by merging `main`.
