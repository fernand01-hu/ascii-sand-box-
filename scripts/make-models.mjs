// Generates the test STL models in web/public/models.
// All models are written Z-up (the usual CAD / 3D-printing convention).
//
//   node scripts/make-models.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'public', 'models');
mkdirSync(OUT, { recursive: true });

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const faceNormal = ([a, b, c]) => {
  const n = cross(sub(b, a), sub(c, a));
  const l = Math.hypot(...n);
  return l > 0 ? mul(n, 1 / l) : [0, 0, 0];
};

function writeBinary(name, tris) {
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.write(`ascii-scene test model: ${name}`.slice(0, 80), 0, 'ascii');
  buf.writeUInt32LE(tris.length, 80);
  let o = 84;
  for (const t of tris) {
    for (const v of [faceNormal(t), ...t]) {
      buf.writeFloatLE(v[0], o);
      buf.writeFloatLE(v[1], o + 4);
      buf.writeFloatLE(v[2], o + 8);
      o += 12;
    }
    o += 2;
  }
  writeFileSync(join(OUT, name), buf);
  console.log(`${name}: ${tris.length} triangles (binary)`);
}

function writeAscii(name, tris) {
  const f = (v) => v.map((c) => c.toExponential(6)).join(' ');
  const lines = [`solid ${name}`];
  for (const t of tris) {
    lines.push(`  facet normal ${f(faceNormal(t))}`, '    outer loop');
    for (const v of t) lines.push(`      vertex ${f(v)}`);
    lines.push('    endloop', '  endfacet');
  }
  lines.push(`endsolid ${name}`, '');
  writeFileSync(join(OUT, name), lines.join('\n'));
  console.log(`${name}: ${tris.length} triangles (ascii)`);
}

/** Grid of points P[i][j] -> triangles; closes the seams when asked. */
function gridTris(P, wrapI, wrapJ) {
  const tris = [];
  const ni = P.length, nj = P[0].length;
  for (let i = 0; i < (wrapI ? ni : ni - 1); i++) {
    for (let j = 0; j < (wrapJ ? nj : nj - 1); j++) {
      const a = P[i][j], b = P[(i + 1) % ni][j], c = P[(i + 1) % ni][(j + 1) % nj], d = P[i][(j + 1) % nj];
      tris.push([a, b, c], [a, c, d]);
    }
  }
  return tris;
}

/** Make every triangle face away from `center` (all test shapes are star-shaped enough). */
function orientOutward(tris, centerOf) {
  return tris.map((t) => {
    const c = mul(add(add(t[0], t[1]), t[2]), 1 / 3);
    return dot(faceNormal(t), sub(c, centerOf(c))) < 0 ? [t[0], t[2], t[1]] : t;
  });
}

// ---- trefoil (2,3) torus knot: smooth, curved, self-occluding ---------------
function torusKnot(p = 2, q = 3, segs = 480, sides = 24, tube = 0.42) {
  const curve = (t) => {
    const r = 2 + Math.cos(q * t);
    return [r * Math.cos(p * t), r * Math.sin(p * t), Math.sin(q * t)];
  };
  // Parallel-transport frames so the tube doesn't twist.
  const pts = [], frames = [];
  let n0 = null;
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * 2 * Math.PI;
    const c = curve(t);
    const T = norm(sub(curve(t + 1e-4), curve(t - 1e-4)));
    if (!n0) n0 = norm(cross(T, [0, 0, 1]));
    n0 = norm(sub(n0, mul(T, dot(n0, T))));
    pts.push(c);
    frames.push([n0, cross(T, n0)]);
  }
  const P = pts.map((c, i) => {
    const [N, B] = frames[i];
    return Array.from({ length: sides }, (_, j) => {
      const a = (j / sides) * 2 * Math.PI;
      return add(c, add(mul(N, Math.cos(a) * tube), mul(B, Math.sin(a) * tube)));
    });
  });
  // The frame doesn't quite close after one loop; nearest-point lookup for orientation.
  const tris = gridTris(P, true, true);
  return orientOutward(tris, (c) => {
    let best = pts[0], bd = Infinity;
    for (const p of pts) {
      const d = dot(sub(c, p), sub(c, p));
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  });
}

// ---- UV sphere: smooth normals everywhere, poles stress the frame code ------
function sphere(rings = 32, segs = 64) {
  const P = [];
  for (let i = 0; i <= rings; i++) {
    const th = (i / rings) * Math.PI;
    P.push(Array.from({ length: segs }, (_, j) => {
      const ph = (j / segs) * 2 * Math.PI;
      return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
    }));
  }
  // Pole rows collapse to points: those zero-area triangles test the cleaner.
  return orientOutward(gridTris(P, false, true), () => [0, 0, 0]);
}

// ---- stepped ziggurat of boxes: hard edges, flat faces, ASCII format --------
function box(x0, y0, z0, x1, y1, z1) {
  const v = (x, y, z) => [x, y, z];
  const q = [
    [v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)],
    [v(x0, y1, z0), v(x1, y1, z0), v(x1, y0, z0), v(x0, y0, z0)],
    [v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1)],
    [v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), v(x0, y0, z0)],
    [v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)],
    [v(x0, y0, z0), v(x1, y0, z0), v(x1, y0, z1), v(x0, y0, z1)],
  ];
  const c = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  return orientOutward(q.flatMap((f) => [[f[0], f[1], f[2]], [f[0], f[2], f[3]]]), () => c);
}

function ziggurat() {
  const tris = [];
  const steps = 4;
  for (let k = 0; k < steps; k++) {
    const s = 1 - k * 0.22;
    tris.push(...box(-s, -s, k * 0.45, s, s, (k + 1) * 0.45));
  }
  return tris;
}

// ---- stylised pine: cones on a cylinder (a nod to the original script) ------
function cone(zBase, zTop, radius, segs) {
  const tris = [];
  const apex = [0, 0, zTop], c = [0, 0, zBase];
  for (let j = 0; j < segs; j++) {
    const a0 = (j / segs) * 2 * Math.PI, a1 = ((j + 1) / segs) * 2 * Math.PI;
    const p0 = [radius * Math.cos(a0), radius * Math.sin(a0), zBase];
    const p1 = [radius * Math.cos(a1), radius * Math.sin(a1), zBase];
    tris.push([p0, p1, apex], [p1, p0, c]);
  }
  const mid = [0, 0, zBase + (zTop - zBase) * 0.3];
  return orientOutward(tris, () => mid);
}

function cylinder(z0, z1, r, segs) {
  const P = [0, 1].map((k) => Array.from({ length: segs }, (_, j) => {
    const a = (j / segs) * 2 * Math.PI;
    return [r * Math.cos(a), r * Math.sin(a), k ? z1 : z0];
  }));
  const tris = gridTris(P, false, true);
  return orientOutward(tris, (c) => [0, 0, c[2]]);
}

function pine() {
  const tris = cylinder(0, 1.2, 0.18, 32);
  const tiers = 4;
  for (let k = 0; k < tiers; k++) {
    const z = 0.8 + k * 0.85;
    tris.push(...cone(z, z + 1.6 - k * 0.15, 1.5 - k * 0.3, 64));
  }
  return tris;
}

writeBinary('torus-knot.stl', torusKnot());
writeBinary('sphere.stl', sphere());
writeAscii('ziggurat.stl', ziggurat());
writeBinary('pine.stl', pine());
