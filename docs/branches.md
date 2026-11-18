# What was built on the side branches

Two side branches were used for experiments. Both are now fully contained in
`master`; this file records what each one added and what became of it.

## `pine-port`

A test port of the original `pine_ascii.py` pine into the new engine.

| Added | Status on `master` |
|---|---|
| Rust port of the pine's growth model (whorls, sagging branches, side shoots, dead twigs, needle sprays) | Kept as a **test scene only** (`engine/src/testbed/`, `web/src/testbed/`), compiled into dev/test builds, never into the website build. Dev key `5`. |
| Voxel shadows (sun and sky light marched through a needle-density grid) | Kept. The same idea powers baked shadows for all scenery. |
| Card record grown from 14 to 16 floats: baked sun and sky visibility per card | Kept (core engine format). |
| Material id packed into each card (shine, translucency, billboarding, haze per material) | Kept, later grown to a 64-entry table. |
| Cards that turn to face the viewer (billboards) | Kept. |
| Alpha-to-coverage drawing mode for free-standing foliage (correct overlap from any angle) | Kept. |

## `underpaint-test`

| Added | Status on `master` |
|---|---|
| **Underpaint:** a faint, blurred wash of the scene's own colours behind the glyphs (green under trees, green/brown under the ground, the sky's tint), instead of flat black | **Kept** (you liked the hue). |
| Thinned distant trees made more opaque and filled out | Kept, and pushed further (see below). |
| **Chunks:** cards split into 16 m chunks, chunks outside the camera not drawn (frustum culling) | **Kept.** |
| **Distance thinning:** far chunks drew fewer characters, the kept ones bigger | **Removed** (it made far scenes look worse). |
| Per-tree character budget raised 1.5x -> 2.2x | Raised again to 3.5x. |
| **Player mode:** first-person walking with physics (gravity, ground following, slope limit, no walking into the lake, collisions with trunks / rocks / big bushes). Dev key `P`; WASD / arrows, Shift run, Space jump, mouse look | Kept. |

## Added directly on `master` after the merge

- Fuller, more opaque tree crowns: far leaves dropped less (keep 2.0 -> 1.3),
  foliage starts more opaque (0.78 -> 0.88) and stays mostly opaque edge-on,
  shaded leaves only swap to mid-weight glyphs (`: ; - ~ +`), never to dots
  that read as holes.
