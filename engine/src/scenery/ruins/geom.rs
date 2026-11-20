//! Geometry toolkit for the ruins (port of the first half of `ruins.py`):
//! f64 vectors, the face list, wall frames, prisms, clipping, profiles.
//! Everything here works in metres, y up, like the reference.

use crate::rng::Pcg32;

pub type V = [f64; 3];

pub fn sub(a: V, b: V) -> V {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn add(a: V, b: V) -> V {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn scale(a: V, k: f64) -> V {
    [a[0] * k, a[1] * k, a[2] * k]
}
pub fn dot(a: V, b: V) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn cross(a: V, b: V) -> V {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
pub fn len(a: V) -> f64 {
    dot(a, a).sqrt()
}
pub fn norm(a: V) -> V {
    let l = len(a);
    if l > 1e-12 { scale(a, 1.0 / l) } else { [0.0; 3] }
}

pub type Mat3 = [[f64; 3]; 3];

/// Rotation about the local s (rx), y (ry) and t (rz) axes: Rz * Ry * Rx.
pub fn rot_matrix(rx: f64, ry: f64, rz: f64) -> Mat3 {
    let (cx, sx) = (rx.cos(), rx.sin());
    let (cy, sy) = (ry.cos(), ry.sin());
    let (cz, sz) = (rz.cos(), rz.sin());
    [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ]
}

pub fn mat_vec(r: &Mat3, v: V) -> V {
    [dot(r[0], v), dot(r[1], v), dot(r[2], v)]
}

/// Python's `random.Random`, near enough: same calls, own sequence.
pub struct Rng(Pcg32);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(Pcg32::new(seed, 0x5275_696e))
    }
    pub fn random(&mut self) -> f64 {
        let a = self.0.next_u32() as u64 >> 5;
        let b = self.0.next_u32() as u64 >> 6;
        (a as f64 * 67_108_864.0 + b as f64) / 9_007_199_254_740_992.0
    }
    pub fn uniform(&mut self, a: f64, b: f64) -> f64 {
        a + (b - a) * self.random()
    }
    pub fn gauss(&mut self, mu: f64, sigma: f64) -> f64 {
        let u1 = 1.0 - self.random();
        let u2 = self.random();
        mu + sigma * (-2.0 * u1.ln()).sqrt() * (std::f64::consts::TAU * u2).cos()
    }
    /// Inclusive on both ends, like Python's.
    pub fn randint(&mut self, a: i64, b: i64) -> i64 {
        if b <= a {
            return a;
        }
        a + (self.random() * (b - a + 1) as f64).floor() as i64
    }
    pub fn choice<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[((self.random() * xs.len() as f64) as usize).min(xs.len() - 1)]
    }
    pub fn sign(&mut self) -> f64 {
        if self.random() < 0.5 { -1.0 } else { 1.0 }
    }
    pub fn expovariate(&mut self, lambd: f64) -> f64 {
        -(1.0 - self.random()).ln() / lambd
    }
}

/// What a face is made of (the reference's materials).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RMat {
    Stone,
    Brick,
    BrickDark,
    BrickLight,
    PillarStone,
    Moss,
    Vine,
    Leaf,
    LeafDark,
    Mortar,
    ArchStone,
    WindowStone,
    Rubble,
    Lead,
    GlassRed,
    GlassBlue,
    GlassGold,
    GlassGreen,
    GlassPurple,
    GlassWhite,
}

impl RMat {
    pub fn color(self) -> [f32; 3] {
        use RMat::*;
        match self {
            Stone => [0.62, 0.60, 0.56],
            Brick => [0.60, 0.56, 0.50],
            BrickDark => [0.50, 0.46, 0.41],
            BrickLight => [0.68, 0.64, 0.57],
            PillarStone => [0.74, 0.71, 0.64],
            Moss => [0.30, 0.42, 0.16],
            Vine => [0.33, 0.27, 0.17],
            Leaf => [0.20, 0.42, 0.14],
            LeafDark => [0.12, 0.30, 0.10],
            Mortar => [0.78, 0.76, 0.70],
            ArchStone => [0.68, 0.65, 0.58],
            WindowStone => [0.72, 0.70, 0.64],
            Rubble => [0.55, 0.53, 0.49],
            Lead => [0.10, 0.10, 0.11],
            GlassRed => [0.78, 0.10, 0.10],
            GlassBlue => [0.10, 0.22, 0.75],
            GlassGold => [0.92, 0.70, 0.15],
            GlassGreen => [0.12, 0.55, 0.22],
            GlassPurple => [0.45, 0.15, 0.58],
            GlassWhite => [0.88, 0.88, 0.78],
        }
    }

    pub fn is_glass(self) -> bool {
        use RMat::*;
        matches!(self, GlassRed | GlassBlue | GlassGold | GlassGreen | GlassPurple | GlassWhite)
    }
}

/// One planar convex polygon, wound by its outward normal. `piece` groups
/// the faces of one brick / stone / debris piece (0 = no piece: a smooth
/// wall); `show` is false for faces buried against a neighbour.
#[derive(Clone, Debug)]
pub struct Face {
    pub mat: RMat,
    pub pts: Vec<V>,
    pub n: V,
    pub piece: u32,
    pub show: bool,
}

/// The faces of a ruin, plus opaque faces that only hide what is behind
/// them (`occ`, not drawn as glyphs).
#[derive(Default)]
pub struct Mesh {
    pub faces: Vec<Face>,
    pub occ: Vec<Vec<V>>,
    /// Current piece id (`new_piece` starts the next one; 0 = none).
    pub piece: u32,
    /// Pieces started so far.
    pub pieces: u32,
    /// Faces added now are drawn (false: buried, kept out).
    pub show: bool,
}

impl Mesh {
    pub fn new() -> Mesh {
        Mesh { show: true, ..Default::default() }
    }

    pub fn new_piece(&mut self) -> u32 {
        self.pieces += 1;
        self.piece = self.pieces;
        self.piece
    }

    /// No piece: smooth walls, moss, vines.
    pub fn no_piece(&mut self) {
        self.piece = 0;
    }

    /// Clean a polygon and find its normal (Newell), turned to agree with `hint`.
    fn clean(pts: &[V], hint: V) -> Option<(Vec<V>, V)> {
        let mut c: Vec<V> = Vec::with_capacity(pts.len());
        for &p in pts {
            if c.last().is_none_or(|&q| len(sub(p, q)) > 1e-7) {
                c.push(p);
            }
        }
        if c.len() > 1 && len(sub(c[0], *c.last().unwrap())) <= 1e-7 {
            c.pop();
        }
        if c.len() < 3 {
            return None;
        }
        let mut n = [0.0; 3];
        for i in 0..c.len() {
            let (p, q) = (c[i], c[(i + 1) % c.len()]);
            n[0] += (p[1] - q[1]) * (p[2] + q[2]);
            n[1] += (p[2] - q[2]) * (p[0] + q[0]);
            n[2] += (p[0] - q[0]) * (p[1] + q[1]);
        }
        let l = len(n);
        if l < 1e-10 {
            return None;
        }
        let mut n = scale(n, 1.0 / l);
        if dot(n, hint) < 0.0 {
            c.reverse();
            n = scale(n, -1.0);
        }
        Some((c, n))
    }

    /// Add a planar convex polygon; `hint` is an outward direction. Mortar
    /// is never drawn, only hides what is behind it; stone does both.
    pub fn poly(&mut self, mat: RMat, pts: &[V], hint: V) {
        if let Some((pts, n)) = Self::clean(pts, hint) {
            if matches!(mat, RMat::Mortar | RMat::Stone) {
                self.occ.push(pts.clone());
            }
            if mat != RMat::Mortar {
                self.faces.push(Face { mat, pts, n, piece: self.piece, show: self.show });
            }
        }
    }

    /// An opaque face that only hides what is behind it.
    pub fn occluder(&mut self, pts: &[V], hint: V) {
        if let Some((pts, _)) = Self::clean(pts, hint) {
            self.occ.push(pts);
        }
    }
}

/// Wall-local coordinates: s along the wall, y up, t across it.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub l: f64,
    pub d: (f64, f64),
    pub n: (f64, f64),
    pub o: (f64, f64),
}

impl Frame {
    pub fn new(p0: (f64, f64), p1: (f64, f64)) -> Frame {
        let (dx, dz) = (p1.0 - p0.0, p1.1 - p0.1);
        let l = dx.hypot(dz);
        let d = (dx / l, dz / l);
        Frame { l, d, n: (-d.1, d.0), o: p0 }
    }
    pub fn pt(&self, s: f64, y: f64, t: f64) -> V {
        [self.o.0 + s * self.d.0 + t * self.n.0, y, self.o.1 + s * self.d.1 + t * self.n.1]
    }
    pub fn vec(&self, s: f64, y: f64, t: f64) -> V {
        [s * self.d.0 + t * self.n.0, y, s * self.d.1 + t * self.n.1]
    }
    pub fn ptv(&self, p: V) -> V {
        self.pt(p[0], p[1], p[2])
    }
    pub fn vecv(&self, p: V) -> V {
        self.vec(p[0], p[1], p[2])
    }
}

/// Identity frame: s = x, t = z.
pub const WORLD: Frame = Frame { l: 1.0, d: (1.0, 0.0), n: (0.0, 1.0), o: (0.0, 0.0) };

pub type P2 = (f64, f64);
/// A local face: points (s, y, t) and an outward hint.
pub type LFace = (Vec<V>, V);

/// Faces (local s, y, t) of a convex (s, y) polygon extruded from t0 to t1.
pub fn prism_faces(poly: &[P2], t0: f64, t1: f64, skip0: bool, skip1: bool) -> Vec<LFace> {
    let mut faces = Vec::with_capacity(poly.len() + 2);
    if !skip1 {
        faces.push((poly.iter().map(|&(s, y)| [s, y, t1]).collect(), [0.0, 0.0, 1.0]));
    }
    if !skip0 {
        faces.push((poly.iter().map(|&(s, y)| [s, y, t0]).collect(), [0.0, 0.0, -1.0]));
    }
    let n = poly.len() as f64;
    let cs = poly.iter().map(|p| p.0).sum::<f64>() / n;
    let cy = poly.iter().map(|p| p.1).sum::<f64>() / n;
    for i in 0..poly.len() {
        let (s0, y0) = poly[i];
        let (s1, y1) = poly[(i + 1) % poly.len()];
        if (s1 - s0).abs() + (y1 - y0).abs() < 1e-9 {
            continue;
        }
        faces.push((vec![[s0, y0, t0], [s1, y1, t0], [s1, y1, t1], [s0, y0, t1]], [0.5 * (s0 + s1) - cs, 0.5 * (y0 + y1) - cy, 0.0]));
    }
    faces
}

/// Emit local faces, optionally rotated about `pivot` and then moved.
pub fn emit_faces(mesh: &mut Mesh, mat: RMat, fr: &Frame, faces: &[LFace], r: Option<&Mat3>, pivot: V, shift: V) {
    for (pts, hint) in faces {
        let (pts, hint): (Vec<V>, V) = match r {
            Some(r) => (pts.iter().map(|&p| add(add(pivot, mat_vec(r, sub(p, pivot))), shift)).collect(), mat_vec(r, *hint)),
            None => (pts.iter().map(|&p| add(p, shift)).collect(), *hint),
        };
        let w: Vec<V> = pts.iter().map(|&p| fr.ptv(p)).collect();
        mesh.poly(mat, &w, fr.vecv(hint));
    }
}

/// Clip a closed convex solid to dot(n, p) <= d, closing the cut with a cap.
pub fn clip_faces(faces: Vec<LFace>, n: V, d: f64) -> Vec<LFace> {
    let mut out = Vec::with_capacity(faces.len() + 1);
    let mut cap: Vec<V> = Vec::new();
    for (pts, hint) in faces {
        let mut res = Vec::with_capacity(pts.len() + 1);
        for i in 0..pts.len() {
            let (p, q) = (pts[i], pts[(i + 1) % pts.len()]);
            let (dp, dq) = (dot(n, p) - d, dot(n, q) - d);
            if dp <= 0.0 {
                res.push(p);
            }
            if (dp <= 0.0) != (dq <= 0.0) {
                let x = add(p, scale(sub(q, p), dp / (dp - dq)));
                res.push(x);
                cap.push(x);
            }
        }
        if res.len() >= 3 {
            out.push((res, hint));
        }
    }
    let mut uniq: Vec<V> = Vec::new();
    for p in cap {
        if uniq.iter().all(|&q| len(sub(p, q)) > 1e-6) {
            uniq.push(p);
        }
    }
    if uniq.len() >= 3 {
        let k = uniq.len() as f64;
        let c = [uniq.iter().map(|p| p[0]).sum::<f64>() / k, uniq.iter().map(|p| p[1]).sum::<f64>() / k, uniq.iter().map(|p| p[2]).sum::<f64>() / k];
        let nn = norm(n);
        let u = norm(sub(uniq[0], c));
        let w = cross(nn, u);
        uniq.sort_by(|a, b| {
            let fa = dot(sub(*a, c), w).atan2(dot(sub(*a, c), u));
            let fb = dot(sub(*b, c), w).atan2(dot(sub(*b, c), u));
            fa.total_cmp(&fb)
        });
        out.push((uniq, nn));
    }
    out
}

pub fn box2d(s0: f64, s1: f64, y0: f64, y1: f64) -> Vec<P2> {
    vec![(s0, y0), (s1, y0), (s1, y1), (s0, y1)]
}

pub fn emit_prism(mesh: &mut Mesh, mat: RMat, fr: &Frame, poly: &[P2], t0: f64, t1: f64) {
    emit_faces(mesh, mat, fr, &prism_faces(poly, t0, t1, false, false), None, [0.0; 3], [0.0; 3]);
}

#[allow(clippy::too_many_arguments)]
pub fn emit_box(mesh: &mut Mesh, mat: RMat, fr: &Frame, s0: f64, s1: f64, y0: f64, y1: f64, t0: f64, t1: f64) {
    if s1 - s0 > 1e-6 && y1 - y0 > 1e-6 && t1 - t0 > 1e-6 {
        emit_prism(mesh, mat, fr, &box2d(s0, s1, y0, y1), t0, t1);
    }
}

/// One part of a rigid piece: material, (s, y) polygon, t range.
#[derive(Clone, Debug)]
pub struct Part {
    pub mat: RMat,
    pub poly: Vec<P2>,
    pub t0: f64,
    pub t1: f64,
}

/// Rigid group of prisms built round the origin, tilted and dropped so its
/// lowest point sits at height `base - embed`. Returns the lowest height of
/// any part's top edge (what something resting on it can't sink below).
#[allow(clippy::too_many_arguments)]
pub fn emit_rigid(mesh: &mut Mesh, x: f64, z: f64, yaw: f64, rx: f64, rz: f64, base: f64, parts: &[Part], embed: f64) -> f64 {
    let fr = Frame::new((x, z), (x + yaw.cos(), z + yaw.sin()));
    let r = rot_matrix(rx, 0.0, rz);
    let mut low = f64::INFINITY;
    for p in parts {
        for &(s, y) in &p.poly {
            for t in [p.t0, p.t1] {
                low = low.min(mat_vec(&r, [s, y, t])[1]);
            }
        }
    }
    let shift = [0.0, base - low - embed, 0.0];
    let mut top = f64::INFINITY;
    for p in parts {
        mesh.new_piece();
        emit_faces(mesh, p.mat, &fr, &prism_faces(&p.poly, p.t0, p.t1, false, false), Some(&r), [0.0; 3], shift);
        let ymax = p.poly.iter().fold(f64::NEG_INFINITY, |m, q| m.max(q.1));
        for &(s, y) in &p.poly {
            if y > ymax - 1e-6 {
                for t in [p.t0, p.t1] {
                    top = top.min(mat_vec(&r, [s, y, t])[1]);
                }
            }
        }
    }
    top + shift[1]
}

// ---------------------------------------------------------------- 2D helpers

pub fn poly_area(poly: &[P2]) -> f64 {
    let mut a = 0.0;
    for i in 0..poly.len() {
        let (x0, y0) = poly[i];
        let (x1, y1) = poly[(i + 1) % poly.len()];
        a += x0 * y1 - x1 * y0;
    }
    0.5 * a
}

/// Sutherland-Hodgman: clip `subject` by the convex polygon `clip`.
pub fn clip_convex(subject: &[P2], clip: &[P2]) -> Vec<P2> {
    let sign = if poly_area(clip) > 0.0 { 1.0 } else { -1.0 };
    let mut out: Vec<P2> = subject.to_vec();
    for i in 0..clip.len() {
        let a = clip[i];
        let b = clip[(i + 1) % clip.len()];
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        if ex.abs() + ey.abs() < 1e-12 {
            continue;
        }
        let inp = std::mem::take(&mut out);
        if inp.is_empty() {
            break;
        }
        let side = |p: P2| sign * (ex * (p.1 - a.1) - ey * (p.0 - a.0));
        for j in 0..inp.len() {
            let (p, q) = (inp[j], inp[(j + 1) % inp.len()]);
            let (dp, dq) = (side(p), side(q));
            if dp >= -1e-12 {
                out.push(p);
            }
            if (dp >= -1e-12) != (dq >= -1e-12) {
                let t = dp / (dp - dq);
                out.push((p.0 + t * (q.0 - p.0), p.1 + t * (q.1 - p.1)));
            }
        }
    }
    out
}

pub fn convex_hull(pts: &[P2]) -> Vec<P2> {
    let mut p: Vec<P2> = pts.to_vec();
    p.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)));
    p.dedup();
    if p.len() < 3 {
        return p;
    }
    let cr = |o: P2, a: P2, b: P2| (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0);
    let mut lower: Vec<P2> = Vec::new();
    for &q in &p {
        while lower.len() >= 2 && cr(lower[lower.len() - 2], lower[lower.len() - 1], q) <= 0.0 {
            lower.pop();
        }
        lower.push(q);
    }
    let mut upper: Vec<P2> = Vec::new();
    for &q in p.iter().rev() {
        while upper.len() >= 2 && cr(upper[upper.len() - 2], upper[upper.len() - 1], q) <= 0.0 {
            upper.pop();
        }
        upper.push(q);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

pub fn point_in_convex(poly: &[P2], x: f64, y: f64) -> bool {
    let (mut pos, mut neg) = (false, false);
    for i in 0..poly.len() {
        let (ax, ay) = poly[i];
        let (bx, by) = poly[(i + 1) % poly.len()];
        let cr = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
        if cr > 1e-9 {
            pos = true;
        } else if cr < -1e-9 {
            neg = true;
        }
        if pos && neg {
            return false;
        }
    }
    true
}

pub fn subtract_ranges(lo: f64, hi: f64, cuts: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut segs = vec![(lo, hi)];
    for &(c0, c1) in cuts {
        let mut nxt = Vec::with_capacity(segs.len() + 1);
        for &(a, b) in &segs {
            if c1 <= a || c0 >= b {
                nxt.push((a, b));
                continue;
            }
            if c0 > a {
                nxt.push((a, c0));
            }
            if c1 < b {
                nxt.push((c1, b));
            }
        }
        segs = nxt;
    }
    segs.into_iter().filter(|(a, b)| b - a > 1e-6).collect()
}

// ------------------------------------------------------------------ profiles

/// Undamaged top of a wall: piecewise linear in s; a repeated s makes a
/// vertical step. `env` is the height damage is measured against (for
/// battlements the merlon height, so only whole merlons are lost).
#[derive(Clone, Debug)]
pub struct Profile {
    pub pts: Vec<P2>,
    pub env: Option<Box<Profile>>,
}

impl Profile {
    pub fn new(pts: Vec<P2>) -> Profile {
        Profile { pts, env: None }
    }

    pub fn at(&self, s: f64, side: i32) -> f64 {
        let p = &self.pts;
        for w in p.windows(2) {
            let ((s0, y0), (s1, y1)) = (w[0], w[1]);
            if s1 - s0 <= 1e-9 {
                continue;
            }
            let inside = if side > 0 { s0 <= s && s < s1 } else { s0 < s && s <= s1 };
            if inside {
                return y0 + (y1 - y0) * (s - s0) / (s1 - s0);
            }
        }
        if s <= p[0].0 { p[0].1 } else { p[p.len() - 1].1 }
    }

    pub fn env_at(&self, s: f64) -> f64 {
        match &self.env {
            Some(e) => e.at(s, 1),
            None => self.at(s, 1),
        }
    }

    pub fn min_over(&self, a: f64, b: f64) -> f64 {
        let mut m = self.at(a, 1).min(self.at(b, -1));
        for &(s, y) in &self.pts {
            if a < s && s < b {
                m = m.min(y);
            }
        }
        m
    }
}

pub fn flat_profile(l: f64, h: f64) -> Profile {
    Profile::new(vec![(0.0, h), (l, h)])
}

pub fn gable_profile(l: f64, h: f64, rise: f64) -> Profile {
    Profile::new(vec![(0.0, h), (l / 2.0, h + rise), (l, h)])
}

/// Battlements; the merlons at both ends are at least `end` wide.
pub fn crenel_profile(l: f64, h: f64, mh: f64, end: f64) -> Profile {
    let (mut m, mut c): (f64, f64) = (0.9, 0.7);
    let end = m.max(end.min(l / 2.0));
    let inner = l - 2.0 * end;
    let env = Some(Box::new(flat_profile(l, h + mh)));
    if inner < 0.5 * c {
        return Profile { pts: vec![(0.0, h + mh), (l, h + mh)], env };
    }
    let n = ((inner - c) / (m + c)).round().max(0.0) as usize;
    let u = inner / ((n + 1) as f64 * c + n as f64 * m);
    m *= u;
    c *= u;
    let mut pts = vec![(0.0, h + mh), (end, h + mh), (end, h)];
    let mut s = end;
    for _ in 0..n {
        s += c;
        pts.extend([(s, h), (s, h + mh), (s + m, h + mh), (s + m, h)]);
        s += m;
    }
    pts.extend([(l - end, h), (l - end, h + mh), (l, h + mh)]);
    Profile { pts, env }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn faces_wind_by_their_hint_and_prisms_are_closed() {
        let mut m = Mesh::new();
        emit_box(&mut m, RMat::Stone, &WORLD, 0.0, 1.0, 0.0, 2.0, 0.0, 3.0);
        assert_eq!(m.faces.len(), 6);
        for f in &m.faces {
            let c = f.pts.iter().fold([0.0; 3], |a, &p| add(a, scale(p, 1.0 / f.pts.len() as f64)));
            assert!(dot(f.n, sub(c, [0.5, 1.0, 1.5])) > 0.0, "normals point outward");
        }
    }

    #[test]
    fn clipping_a_box_adds_a_cap() {
        let f = prism_faces(&box2d(0.0, 2.0, 0.0, 1.0), 0.0, 1.0, false, false);
        let c = clip_faces(f, [1.0, 0.0, 0.0], 1.0);
        assert_eq!(c.len(), 6);
        assert!(c.iter().all(|(p, _)| p.iter().all(|q| q[0] <= 1.0 + 1e-9)));
    }

    #[test]
    fn crenels_keep_wide_end_merlons() {
        let p = crenel_profile(20.0, 9.0, 1.0, 2.0);
        assert_eq!(p.at(1.0, 1), 10.0);
        assert_eq!(p.at(19.0, 1), 10.0);
        assert_eq!(p.env_at(10.0), 10.0);
        assert!(p.pts.iter().any(|&(_, y)| y == 9.0));
    }

    #[test]
    fn ranges_and_hulls() {
        assert_eq!(subtract_ranges(0.0, 10.0, &[(2.0, 3.0), (5.0, 12.0)]), vec![(0.0, 2.0), (3.0, 5.0)]);
        let h = convex_hull(&[(0.0, 0.0), (1.0, 0.0), (0.5, 0.2), (1.0, 1.0), (0.0, 1.0)]);
        assert_eq!(h.len(), 4);
        let mut r = Rng::new(3);
        assert!((0..1000).all(|_| (1..=3).contains(&r.randint(1, 3))));
    }
}
