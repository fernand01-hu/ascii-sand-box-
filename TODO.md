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

- **Milestone 1: "I can paint and save a scene."** Steps 1–9.
- **Milestone 2: "I can fill a scene with objects."** Steps 10–12.
- **Milestone 3: "It looks good."** Steps 13–15.
- **Milestone 4: "I can walk in it."** Phase 4.

## Phase 1: Foundations

- [ ] **1. Remove the procedural map and start from a blank canvas.**
  (Done on `step-01-blank-canvas` except the `scenery.zip` decision.)
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
  - [ ] Decide whether `scenery.zip` belongs in the repo (it is ~2.5 MB of
    images). Otherwise add it to `.gitignore`.

- [ ] **2. Chunk system for editable, unlimited maps.**
  - Chunks already exist: 32 m chunks in `world.rs` and 16 m render chunks in
    `web/src/engine/chunks.ts`. They currently hold *generated* content. The
    new chunks must hold *edited* content.
  - Each chunk stores:
    - a ground tile layer (canvas `#` / grass / sand / water / rock …)
    - a list of placed objects (kind + generator params + seed + position)
  - Load chunks within `view_radius` of the camera and unload the rest.
    Untouched chunks are just canvas: they are generated on the fly and never
    saved.
  - **Rules for things that cross chunk borders:**
    - **Ground tiles:** each tile belongs to exactly one chunk, based on its
      coordinates. A brush stroke over a border writes its tiles into every
      chunk it touches and marks all of them dirty.
    - **Objects:** an object belongs to the chunk that holds its base point
      (a tree's trunk, a rock's center). It is stored and saved only there,
      even if its crown hangs over the next chunk.
    - **Drawing:** a chunk's bounding box grows to cover its objects' full
      size, so culling never cuts off a tree crown that crosses the border.
      Render chunks already store min/max bounds.
    - **Rebuilds:** an edit rebuilds the chunks it touched. Once shadows
      cross borders (step 14), the neighbouring chunks are rebuilt too.
  - Optimizations:
    - **(added)** rebuild only "dirty" chunks after an edit
    - keep the existing chunk worker pool
    - frustum culling
    - a memory cap on loaded chunks

- [ ] **3. Debug terminal.**
  - An in-app console (toggle with `` ` ``) with commands such as `help`,
    `tp x z`, `seed`, `stats`, `chunks`, `view 6`, `wind 0.5`, `rain on`,
    `clear`.
  - It shows the log, FPS, card count, loaded/dirty chunks and worker queue.
  - **(added)** A performance overlay: frame time and cards per chunk, to
    check the 30 FPS target.
  - It replaces most of the scattered dev hotkeys in `web/src/app/devtools.ts`.
  - Build it early, because it helps you debug every step after it. It is
    also the first piece of the TUI look (step 5).

- [ ] **4. Limit overlapping characters on screen.** (Moved up from Phase 3:
      on a CPU-only machine the number of characters is the main cost, and
      this is what keeps the 30 FPS target.)
  - The current budget in `skin.rs` is per object. Add a screen-space cap:
    at most N cards drawn on one screen cell, nearest first.
  - **(added)** A global card budget per frame, shared out by distance.
    Earlier, thinning far chunks looked bad, so test this carefully against
    screenshots.

- [ ] **5. TUI-style interface (old-school ASCII game look).**
  - Use a monospace font, box-drawing borders (`┌─┐│└┘`), keyboard-first
    menus and a small fixed colour palette. No modern rounded widgets.
  - **(added)** Build a few reusable pieces first (panel, list, slider,
    checkbox, text input). The debug terminal, brush panel and save dialog
    are all made from them.

## Phase 2: Scene editor

- [ ] **6. (added) Editing camera and ground picking.**
  - A top-down / orthographic camera mode for editing.
  - A grid overlay and snapping.
  - Convert the mouse position into a point on the ground plane
    (raycasting). Every brush needs this.

- [ ] **7. Terrain brush on the 2D plane.**
  - Paint grass, sand, water and rock onto the `#` canvas.
  - Brush size, shape (circle / square) and strength.
  - **(added)** An eraser that paints the `#` canvas back.
  - **(added)** Soft edges, so sand fades into grass instead of making hard
    tile borders.
  - **(added)** Unit tests for the brush, run by `npm test`.

- [ ] **8. (added) Undo / redo.**
  - An editor without undo is painful to use. Record each brush stroke as one
    undoable action, including the list of chunks it touched.
  - It is cheap if you add it now and hard to add once the brush code grows.

- [ ] **9. Save / load scenes.**
  - Save the recipe, not the generated cards: terrain tiles plus a list of
    objects (kind, params, seed, position). Files stay tiny, and the
    generators are deterministic, so loading rebuilds the same scene.
  - **(added)** Save only the chunks that were edited.
  - **(added)** Put a format `version` field in the file from day one.
  - **(added)** Autosave.
  - **(added)** Save to a downloadable file as well as localStorage.
  - **(added)** A save → load round-trip test in `npm test`.
  - **(added)** Export a scene as PNG or as plain-text ASCII.

- [ ] **10. Object brush: place over an area.**
  - Paint trees, bushes, rocks, grass and flowers over an area, with a
    density setting instead of one-by-one placement.
  - Use Poisson-disk spacing so objects don't overlap or clump. Spacing must
    also work across chunk borders.
  - **(added)** Random variation per object (size ±, rotation, seed).
  - **(added)** Single-click placement, plus select / move / delete for one
    object.

- [ ] **11. Generator parameters in the brush.**
  - Expose *every* generator parameter for every object type: tree height,
    crown size, leaf amount, branch count, rock roughness, and so on.
  - Generate the panel from one param description per generator (name,
    range, default), so new params show up automatically.
  - **(added)** A live preview of the object before you paint it.
  - **(added)** Save named presets (for example "my tall birch").

- [ ] **12. (added) Height brush.**
  - Raise, lower and smooth the ground.
  - Only start this once flat 2D editing works well.

## Phase 3: Visual quality

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
