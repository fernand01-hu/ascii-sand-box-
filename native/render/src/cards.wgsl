// Instanced ASCII cards: port of the three.js vertex shader in
// web/src/render/cards.ts (same maths, same names where possible).
// Lighting, billboards, wind, water flow, rain and leaves all run per card here.

struct Frame {
  view: mat4x4<f32>,
  proj: mat4x4<f32>,
  cam: vec4<f32>,
  sun_dir: vec4<f32>,
  sun_color: vec4<f32>,
  sky_color: vec4<f32>,
  glint_color: vec4<f32>,
  tone: vec4<f32>,        // exposure, sky gain, ambient, hemi
  haze_color: vec4<f32>,  // rgb, haze distance (per-material haze)
  fog: vec4<f32>,         // e-folding distance, strength, alpha gain, depth bias
  wind: vec4<f32>,        // dir x, dir z, strength, time
  weather: vec4<f32>,     // rain, leaves, under pass (0/1), under card alpha
  rain_box: vec4<f32>,
  leaf_box: vec4<f32>,    // min x, min z, size (unused xy)
  atlas: vec4<f32>,       // grid cols, rows, inset x, inset y
  mat_a: array<vec4<f32>, 64>, // spec, shininess, trans, wrap
  mat_b: array<vec4<f32>, 64>, // billboard, twist, alphaLit, haze
  mat_c: array<vec4<f32>, 64>, // flex, flow, fog, -
}

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var atlas_tex: texture_2d<f32>;
@group(0) @binding(2) var atlas_smp: sampler;

struct Inst {
  @location(0) center: vec3<f32>,
  @location(1) iu: vec3<f32>,
  @location(2) iv: vec3<f32>,
  @location(3) color: vec4<f32>,
  @location(4) glyph: f32,
  @location(5) light: vec2<f32>,
}

struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec3<f32>,
  @location(2) alpha: f32,
}

const MATERIAL_SHIFT: f32 = 1024.0;
const MAX_MATERIALS: f32 = 64.0;
const PI: f32 = 3.14159;

fn hash3(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 45.164))) * 43758.5453);
}

fn gmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn gmod3(x: vec3<f32>, y: vec3<f32>) -> vec3<f32> { return x - y * floor(x / y); }
fn gmod2(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> { return x - y * floor(x / y); }

fn rotate_about(v: vec3<f32>, axis: vec3<f32>, a: f32) -> vec3<f32> {
  let c = cos(a);
  return v * c + cross(axis, v) * sin(a) + axis * dot(axis, v) * (1.0 - c);
}

const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, -0.5), vec2<f32>(0.5, 0.5),
  vec2<f32>(-0.5, -0.5), vec2<f32>(0.5, 0.5), vec2<f32>(-0.5, 0.5),
);

fn hidden() -> VOut {
  var o: VOut;
  o.pos = vec4<f32>(2.0, 2.0, 2.0, 1.0);
  o.uv = vec2<f32>(0.0);
  o.color = vec3<f32>(0.0);
  o.alpha = 0.0;
  return o;
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32, inst: Inst) -> VOut {
  var quad_arr = QUAD;
  let quad = quad_arr[vi];
  let uvq = quad + vec2<f32>(0.5);
  let camera_position = F.cam.xyz;
  let time = F.wind.w;
  let under = F.weather.z;

  let high = floor((inst.glyph + 0.5) / MATERIAL_SHIFT);
  let glyph = inst.glyph - high * MATERIAL_SHIFT;
  let card_mode = floor((high + 0.5) / MAX_MATERIALS);
  let mat = high - card_mode * MAX_MATERIALS;
  let m = u32(min(mat, MAX_MATERIALS - 1.0));
  let A = F.mat_a[m];
  let B = F.mat_b[m];
  let C = F.mat_c[m];
  let solid = card_mode > 2.5 && card_mode < 3.5;
  let water_lean = card_mode > 7.5;
  let lean = card_mode > 6.5;
  let emissive = (card_mode > 3.5 && card_mode < 4.5) || water_lean;
  let rain = card_mode > 4.5 && card_mode < 5.5;
  let leaf = card_mode > 5.5 && card_mode < 6.5;
  var billboard = 0.0;
  if (!(solid || emissive || leaf || lean)) {
    if (rain) { billboard = 1.0; } else if (card_mode > 0.5) { billboard = card_mode; } else { billboard = B.x; }
  }

  let h = hash3(inst.center);
  let wind3 = vec3<f32>(F.wind.x, 0.0, F.wind.y);
  let ws = F.wind.z;
  var center = inst.center;
  var U = inst.iu;
  var V = inst.iv;
  var alpha_mul = 1.0;

  if (under > 0.5 && (rain || leaf)) {
    return hidden();
  }
  if (card_mode > 3.5 && card_mode < 4.5) {
    // Sky dome and stars: built round the origin, kept centred on the camera.
    center = inst.center + camera_position;
  }
  if (rain) {
    let fall = vec3<f32>(F.wind.x * ws * 9.0, -14.0, F.wind.y * ws * 9.0) * time;
    let rel = gmod3(inst.center + fall - camera_position, F.rain_box.xyz) - 0.5 * F.rain_box.xyz;
    center = camera_position + rel;
    let near = smoothstep(2.0, 9.0, length(rel));
    V = normalize(vec3<f32>(F.wind.x * ws * 0.65, -1.0, F.wind.y * ws * 0.65)) * length(inst.iv) * mix(0.35, 1.0, near);
    U = inst.iu * mix(0.35, 1.0, near);
    let q = abs(rel) / F.rain_box.xyz;
    let edge = 1.0 - smoothstep(0.35, 0.5, max(q.x, max(q.y, q.z)));
    alpha_mul = step(h, F.weather.x) * edge * smoothstep(2.5, 6.0, length(rel));
  } else if (leaf) {
    let speed = (1.5 + 7.0 * ws) * (0.7 + 0.6 * h);
    var p = inst.center + wind3 * speed * time;
    let box_min = camera_position.xz - 0.5 * F.leaf_box.z;
    let pxz = box_min + gmod2(p.xz - box_min, vec2<f32>(F.leaf_box.z));
    p.x = pxz.x;
    p.z = pxz.y;
    p.y = camera_position.y - 1.6 + inst.center.y + sin(time * (1.1 + h) + h * 40.0) * 0.6 + sin(time * 0.37 + h * 13.0) * 0.4;
    center = p;
    let axis = normalize(vec3<f32>(h - 0.5, 0.6, fract(h * 7.3) - 0.5));
    let spin = time * (1.5 + 3.0 * fract(h * 3.1)) * (0.3 + ws);
    U = rotate_about(inst.iu, axis, spin);
    V = rotate_about(inst.iv, axis, spin);
    let e = min(p.xz - box_min, box_min + F.leaf_box.z - p.xz);
    alpha_mul = step(fract(h * 5.7), F.weather.y) * smoothstep(0.03, 0.15, ws) * smoothstep(0.0, 4.0, min(e.x, e.y));
  }

  let to_cam = normalize(camera_position - center);
  let n0 = normalize(cross(inst.iu, inst.iv));
  if (lean) {
    var k = 0.9;
    if (water_lean) { k = mix(0.7, 1.7, fract(h * 3.7)); }
    let nn = normalize(n0 + to_cam * k);
    let side = cross(n0, to_cam);
    var u = normalize(inst.iu);
    if (dot(side, side) > 1e-6) { u = normalize(side); }
    var a = 0.0;
    if (water_lean) {
      a = (h - 0.5) * 0.4;
    } else {
      a = (h - 0.5);
      if (fract(h * 9.1) >= 0.5) { a = a + 3.14159; }
    }
    u = rotate_about(u, nn, a);
    u = normalize(u - nn * dot(u, nn));
    U = u * length(inst.iu);
    V = cross(nn, u) * length(inst.iv);
  }
  let tw = (h - 0.5) * 2.0 * B.y;
  if (billboard > 0.5 && billboard < 1.5) {
    let axis = normalize(V);
    var side = cross(axis, to_cam);
    if (dot(side, side) > 1e-8) {
      side = normalize(side);
      U = (side * cos(tw) + cross(side, axis) * sin(tw)) * length(inst.iu);
    }
  } else if (billboard > 1.5) {
    let axis = normalize(U);
    var side = cross(to_cam, axis);
    if (dot(side, side) > 1e-8) {
      side = normalize(side);
      V = (side * cos(tw) + cross(axis, side) * sin(tw)) * length(inst.iv);
    }
  }

  var sway = vec3<f32>(0.0);
  if (C.x > 0.0 && ws > 0.0 && !rain && !leaf) {
    let gust = 0.55 + 0.45 * sin(time * 0.8 - dot(center.xz, F.wind.xy) * 0.09 + h);
    let flutter = sin(time * (2.6 + 1.4 * h) + h * 31.0 + dot(center.xz, vec2<f32>(0.7, 0.4)));
    let amt = ws * C.x * gust;
    let size = length(V);
    sway = wind3 * (amt * size * (0.6 + 0.4 * flutter)) - vec3<f32>(0.0, 0.1 * amt * size, 0.0);
    V = normalize(V / max(size, 1e-5) + wind3 * (amt * 0.8 * (0.75 + 0.25 * flutter))) * size;
  }

  if (C.y > 0.0) {
    let travel = max(length(inst.iu) * 2.0, 1e-3);
    let ph = fract(time * C.y / travel + h);
    center = center + normalize(inst.iu) * (ph - 0.5) * travel;
    alpha_mul = alpha_mul * mix(0.75 + 0.25 * sin(3.14159 * ph), sin(3.14159 * ph), smoothstep(0.3, 0.8, C.y));
  }

  let base_a = inst.color.a;

  let world = center + sway + U * quad.x + V * quad.y;
  var N = normalize(cross(U, V));
  let facing = dot(N, to_cam);
  var nlight = N;
  if (lean) { nlight = n0; }
  if (solid && facing < 0.0) {
    return hidden();
  }

  var flip = 1.0;
  if (facing < 0.0) { flip = -1.0; }
  N = N * flip;
  if (!lean) { nlight = N; }
  let dist = length(camera_position - center);

  var out: VOut;
  if (emissive || rain) {
    out.color = inst.color.rgb;
    var fa = smoothstep(0.02, 0.25, abs(facing));
    if (rain) { fa = 1.0; }
    out.alpha = base_a * alpha_mul * fa;
  } else {
    var ts = inst.light.x;
    var tk = inst.light.y;
    if (leaf) { ts = 1.0; tk = 1.0; }
    ts = ts * (1.0 - 0.6 * F.weather.x);
    let sun = F.sun_dir.xyz;
    let ndl = dot(nlight, sun);
    let diff = clamp((ndl + A.w) / (1.0 + A.w), 0.0, 1.0);
    let back = clamp(-ndl, 0.0, 1.0);
    var spec = pow(clamp(dot(nlight, normalize(sun + to_cam)), 0.0, 1.0), A.y);
    if (ndl < 0.0) { spec = 0.0; }
    let hemi = mix(1.0, 0.55 + 0.45 * nlight.y, F.tone.w);
    let rad = inst.color.rgb * (ts * F.sun_color.xyz * (1.25 * diff + A.z * back) + F.tone.y * tk * hemi * F.sky_color.xyz + F.tone.z)
            + A.x * spec * ts * F.glint_color.xyz;
    var col = 1.0 - exp(-F.tone.x * rad);
    let hz = B.w * pow(clamp(dist / F.haze_color.w, 0.0, 1.0), 0.65);
    col = mix(col, F.haze_color.xyz, hz);
    var edge = smoothstep(0.02, 0.25, abs(facing));
    if (C.x > 0.3) { edge = max(edge, 0.7); }
    out.color = col;
    out.alpha = min(1.0, (base_a + B.z * ts * diff) * F.fog.z) * edge * alpha_mul;
  }
  if (F.fog.y > 0.0 && C.z > 0.5) {
    let hz = (1.0 - exp(-dist / (F.fog.x * (1.0 - 0.55 * F.weather.x)))) * F.fog.y;
    out.color = mix(out.color, F.haze_color.xyz, hz);
  }

  let cols = F.atlas.x;
  let row = floor((glyph + 0.5) / cols);
  let col_i = glyph - row * cols;
  var cu = uvq.x;
  if (flip < 0.0) { cu = 1.0 - uvq.x; }
  let cuv = vec2<f32>(cu, 1.0 - uvq.y);
  let inset = F.atlas.zw;
  out.uv = (vec2<f32>(col_i, row) + mix(inset, vec2<f32>(1.0) - inset, cuv)) / F.atlas.xy;

  var vp = (F.view * vec4<f32>(world, 1.0)).xyz;
  vp = vp + normalize(-vp) * (F.fog.w * length(inst.iv));
  out.pos = F.proj * vec4<f32>(vp, 1.0);
  return out;
}

@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let a = textureSample(atlas_tex, atlas_smp, in.uv).r * in.alpha;
  if (a < 0.02) { discard; }
  return vec4<f32>(in.color, a);
}

// Underpaint pass: the same card as a solid patch of its own colour.
@fragment
fn fs_solid(in: VOut) -> @location(0) vec4<f32> {
  let a = in.alpha * F.weather.w;
  if (a < 0.05) { discard; }
  return vec4<f32>(in.color, a);
}

// ---- opaque bodies (depth only) ----
@vertex
fn vs_body(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return F.proj * (F.view * vec4<f32>(p, 1.0));
}

@fragment
fn fs_body() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0);
}

// ---- fullscreen passes ----
struct FsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vs_full(@builtin(vertex_index) vi: u32) -> FsOut {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u)); // 0,0  2,0  0,2
  var o: FsOut;
  o.pos = vec4<f32>(p.x * 2.0 - 1.0, p.y * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}

struct Blur { step: vec2<f32>, strength: f32, pad: f32, bg: vec4<f32> }
@group(0) @binding(0) var<uniform> BL: Blur;
@group(0) @binding(1) var src_tex: texture_2d<f32>;
@group(0) @binding(2) var src_smp: sampler;

@fragment
fn fs_blur(in: FsOut) -> @location(0) vec4<f32> {
  var w = array<f32, 5>(0.2270, 0.1946, 0.1216, 0.0541, 0.0162);
  var c = textureSampleLevel(src_tex, src_smp, in.uv, 0.0) * w[0];
  for (var i = 1; i < 5; i = i + 1) {
    let o = BL.step * f32(i) * 1.5;
    c = c + (textureSampleLevel(src_tex, src_smp, in.uv + o, 0.0) + textureSampleLevel(src_tex, src_smp, in.uv - o, 0.0)) * w[i];
  }
  return c;
}

@fragment
fn fs_composite(in: FsOut) -> @location(0) vec4<f32> {
  let u = textureSampleLevel(src_tex, src_smp, in.uv, 0.0).rgb;
  return vec4<f32>(BL.bg.rgb + u * BL.strength, 1.0);
}
