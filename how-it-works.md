# How the ASCII Art Is Created

How `pine_ascii(1).py` builds its ASCII art, step by step.

## The core idea: ASCII "cards" in 3D space

- It doesn't use a text grid. Every element (needle, twig, bark patch, grass blade, distant tree, piece of sky) is one ASCII character printed on a small flat card that sits in a 3D scene.
- Each card has its own:
  - **position** (a center point C)
  - **orientation**, set by two vectors U and V (the card's horizontal and vertical edges), so it can be rotated any way in 3D
  - **size**, the length of U and V
  - **character**
  - **colour** (RGB)
  - **opacity** (alpha)
- Cards overlap and show through one another, which gives a painterly look that a normal text grid can't produce.

## Glyph atlas (how characters become images)

- Every character used is drawn once in a monospace bold font (DejaVu Sans Mono Bold), white on black, in a small cell with a 2px border.
- Each glyph is stored at 16 opacity levels, so a card's alpha picks a pre-faded version of it.
- Card width = height × glyph aspect ratio (about 0.6), so characters keep their proportions.

## Each scene element has its own character set

| Element | Characters |
|---|---|
| Needles (weighted, V and Y most common because they look like two-needle bundles) | `V Y v y * W w X x K k \| / \ l i ! ^ A` |
| Shoot tips / new growth | `* + x X` |
| Thick branches | `# = H % & 8 $` |
| Thin twigs | `- = ~ _` |
| Dead wood | `# % & =` |
| Bark plates | `@ # & 8 % B M W` |
| Bark mid-tones | `o O 0 = x` |
| Bark fissures (cracks) | `\| ! I : [ ]` |
| Upper, flaky bark | `~ - = s z c o < >` |
| Grass (weighted) | ``\| / \ ' " , ; i v w V W Y y ^ ` `` |
| Soil | `. , _ - ~ = : ; o` |
| Far forest | `A ^ *` |
| Near forest | `A ^ # % & *` |
| Sky (brightness ramp, dark to bright) | ``. ` , : ; - ~ = + * o # % @`` |
| Stars | `* + .` |

## How cards are oriented

- **Needles and grass:** the card's vertical axis follows the needle or blade direction. The card starts out facing the camera, then gets a random twist around that axis so it turns in 3D but stays mostly readable.
- **Branches:** the glyph's horizontal axis runs along the wood. Cards are placed one after another along each segment; thin twigs get gaps between cards so they look dashed.
- **Bark:** cards are wrapped around the cylindrical trunk, tangent to the surface with a slight random tilt. Only the side facing the camera is generated.
- **Soil marks:** cards lie flat on the ground with a random spin, so perspective squashes them.
- **Sky, forest, stars:** cards face the camera with a small random yaw and roll, placed on far-away flat planes.

## Picking the character procedurally (it isn't random)

- **Bark:** a cell-like noise pattern (Worley noise) plus smooth noise creates plates and fissures. Crack areas get fissure characters, raised areas get plate characters, the rest get mid-tone characters. Higher up the trunk, the flaky-bark set gradually takes over.
- **Sky:** each spot's brightness (from a vertical gradient plus cloud noise) is mapped onto the density ramp. Brighter spots get denser characters.
- **Everything else:** weighted random picks from the element's character set.

## Procedural content (what the characters are placed on)

- **Tree:**
  - a wavy trunk that gets thinner toward the top
  - branches in whorls (rings) along the trunk
  - each branch sags, then curves up at the end, inside a cone-shaped outline
  - side shoots and sub-shoots grow off each branch, some of them dead
  - needles sprayed along the ends of the shoots, denser near the tips
- **Background:**
  - two silhouette layers of forest, made from cone- and dome-shaped tree profiles over rolling hills
  - a sky placed on a jittered grid with alternate rows offset (like a honeycomb)
  - 140 stars in the darkest part of the sky
- **Ground:**
  - 3,500 flat soil marks and 12,000 standing grass blades, spread so they look about the same size on screen
  - extra grass around the base of the trunk

## Lighting is calculated for each card, not as an image filter

- **Shadows:** needle positions are counted into a 3D grid (voxels) to get foliage density. For each card, a ray is stepped toward the sun through that grid, and denser foliage blocks more light. Sky light is measured the same way, averaged over 5 upward directions.
- **Card shading** uses the card's own facing direction (its normal), flipped to the side the camera sees:
  - soft "wrapped" diffuse sunlight, so light bends a little past the edge
  - light shining through needles from behind (translucency)
  - cool blue sky fill light
  - a warm glint when a card's angle bounces the sun toward the camera
  - a final tone curve: `1 - exp(-2.2 × light)`
- **Opacity follows light:** sunlit needles are almost opaque and crisp, shaded ones are faint (alpha from about 0.28 to 1).
- **Colours:**
  - needles are greens with a per-shoot tint, and young growth is lighter
  - wood goes from brown to warm orange higher up
  - bark is grey-brown at the bottom, orange flakes at the top, with dark cracks
- **Scene light:** a low, warm evening sun from the front left, plus cool blue sky light.
- **Ground:** the tree casts a blurred shadow onto it, and distant ground fades into a purple haze.
- **Sky colours:** deep blue at the top, then a pink band near the horizon, then blue-grey below it.

## Rendering

- A perspective camera sits at eye height (1.6) and 24 units from the tree.
- Each card's corners are projected to the screen, and the glyph is stretched onto that shape (an affine transform).
- Cards are drawn from farthest to nearest, blended using the glyph mask × alpha, on a dark navy background (9, 12, 19).
- The image is rendered at 2× size and scaled down for smooth edges. No other filter is applied.
- A seed number controls all randomness, so each seed gives a unique but repeatable scene.
