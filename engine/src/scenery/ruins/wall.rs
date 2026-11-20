//! One wall of a ruin (port of `Wall` in `ruins.py`): openings with pointed
//! arches, damage, columns of solid intervals, the ground flood fill that
//! keeps anything from floating, then smooth stone or individual bricks,
//! windows, moss and vines.

use super::geom::*;
use super::Ctx;
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;

pub const INF: f64 = f64::INFINITY;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Window,
    Door,
    Arcade,
    Slit,
}

/// Window / door / arcade bay / arrow slit with a pointed arch
/// (k = 0.5 round, 1.0 equilateral gothic).
#[derive(Clone, Debug)]
pub struct Opening {
    pub a: f64,
    pub b: f64,
    pub sill: f64,
    pub kind: Kind,
    pub k: f64,
    pub ring: f64,
    pub lights: usize,
    pub glass: bool,
    pub intact: Option<bool>,
    pub strong: bool,
    pub spring: f64,
    pub sill_h: f64,
    pub arch_ok: bool,
    pub lower_ok: bool,
    pub jambs: (f64, f64),
}

impl Opening {
    pub fn w(&self) -> f64 {
        self.b - self.a
    }
    pub fn c(&self) -> f64 {
        0.5 * (self.a + self.b)
    }
    pub fn r(&self) -> f64 {
        self.k * self.w()
    }
    pub fn sill_base(&self) -> f64 {
        self.sill - self.sill_h
    }
    pub fn rise(&self, extra: f64) -> f64 {
        let r = self.r() + extra;
        let dx = self.c() - (self.a + self.r());
        (r * r - dx * dx).max(0.0).sqrt()
    }
    pub fn apex(&self) -> f64 {
        self.spring + self.rise(0.0)
    }
    pub fn ext_apex(&self) -> f64 {
        self.spring + self.rise(self.ring)
    }
    pub fn intrados(&self, s: f64) -> f64 {
        let cx = if s <= self.c() { self.a + self.r() } else { self.b - self.r() };
        let d = s - cx;
        self.spring + (self.r() * self.r() - d * d).max(0.0).sqrt()
    }
    pub fn mullions(&self) -> Vec<(f64, f64)> {
        let n = self.lights;
        if n < 2 {
            return Vec::new();
        }
        let mw = (0.2f64).min(self.w() / n as f64 * 0.25);
        (1..n).map(|i| {
            let x = self.a + self.w() * i as f64 / n as f64;
            (x - mw / 2.0, x + mw / 2.0)
        }).collect()
    }
}

/// Options for `Wall::add_opening` (the reference's keyword arguments).
#[derive(Clone, Copy, Debug)]
pub struct Op {
    pub kind: Kind,
    pub spring: Option<f64>,
    pub k: f64,
    pub ring: f64,
    pub lights: usize,
    pub glass: bool,
    pub intact: Option<bool>,
    pub margin: f64,
    pub strong: bool,
}

impl Default for Op {
    fn default() -> Op {
        Op { kind: Kind::Window, spring: None, k: 0.85, ring: 0.35, lights: 1, glass: true, intact: None, margin: 0.35, strong: false }
    }
}

/// Jagged damage along a wall as (s0, s1, fraction-of-height) blocks; the
/// end blocks are fixed so joined walls meet at the same height.
fn damage_blocks(rng: &mut Rng, l: f64, amount: f64, f0: f64, f1: f64, end_len: f64) -> Vec<(f64, f64, f64)> {
    let end_len = end_len.min(0.42 * l);
    let n_ctrl = ((l / 3.5) as usize + 2).max(2);
    let ctrl: Vec<f64> = (0..n_ctrl).map(|_| rng.random()).collect();
    let smooth = |x: f64| {
        let u = x / l * (n_ctrl - 1) as f64;
        let i = (u as usize).min(n_ctrl - 2);
        let f = u - i as f64;
        let f = f * f * (3.0 - 2.0 * f);
        ctrl[i] * (1.0 - f) + ctrl[i + 1] * f
    };
    let mut collapses = Vec::new();
    let (lo, hi) = (end_len, l - end_len);
    let count = (l * amount / 9.0 + rng.random()) as usize;
    for _ in 0..count {
        let w = rng.uniform(1.2, 3.5);
        if hi - lo > w {
            let c = rng.uniform(lo + w / 2.0, hi - w / 2.0);
            collapses.push((c - w / 2.0, c + w / 2.0, rng.uniform(0.02, 0.2)));
        }
    }
    let mut blocks = Vec::new();
    if end_len > 0.0 {
        blocks.push((0.0, end_len, f0));
    }
    let mut s = end_len;
    while s < hi - 1e-9 {
        let mut e = hi.min(s + rng.uniform(0.35, 1.0));
        if hi - e < 0.25 {
            e = hi;
        }
        let m = 0.5 * (s + e);
        let mut f = 1.0 - amount * (0.6 * smooth(m) + 0.4 * rng.random());
        for &(c0, c1, cf) in &collapses {
            if c0 <= m && m <= c1 {
                f = f.min(cf + 0.15 * rng.random());
            }
        }
        blocks.push((s, e, f.clamp(0.0, 1.0)));
        s = e;
    }
    if end_len > 0.0 {
        blocks.push((l - end_len, l, f1));
    }
    blocks
}

fn snap(x: f64, step: f64) -> f64 {
    (x / step).round() * step
}

/// (bot_l, bot_r, top_l, top_r): a trapezoid in (s, y) across one column.
pub type Iv = [f64; 4];

#[derive(Clone, Debug)]
pub struct Column {
    pub s0: f64,
    pub s1: f64,
    pub ivs: Vec<Iv>,
}

pub struct Wall {
    pub clear: (f64, f64),
    pub fr: Frame,
    pub l: f64,
    pub t: f64,
    pub prof: Profile,
    pub cap0: bool,
    pub cap1: bool,
    pub end_frac: (f64, f64),
    pub end_len: f64,
    pub damage_scale: f64,
    pub openings: Vec<Opening>,
    pub zones: Vec<(f64, f64, f64)>,
    pub miter: f64,
    pub cover: Option<Vec<(f64, f64, f64)>>,
    cover_bins: HashMap<i64, Vec<(f64, f64, f64)>>,
    pub edges: Vec<f64>,
    pub cols: Vec<Column>,
}

impl Wall {
    pub fn new(p0: P2, p1: P2, thick: f64, prof: Profile) -> Wall {
        let fr = Frame::new(p0, p1);
        Wall {
            clear: (0.15, 0.15),
            fr,
            l: fr.l,
            t: thick,
            prof,
            cap0: true,
            cap1: true,
            end_frac: (1.0, 1.0),
            end_len: thick,
            damage_scale: 1.0,
            openings: Vec::new(),
            zones: Vec::new(),
            miter: 0.0,
            cover: None,
            cover_bins: HashMap::new(),
            edges: Vec::new(),
            cols: Vec::new(),
        }
    }

    pub fn caps(mut self, cap0: bool, cap1: bool) -> Wall {
        self.cap0 = cap0;
        self.cap1 = cap1;
        self
    }
    pub fn ends(mut self, frac: (f64, f64), len: f64) -> Wall {
        self.end_frac = frac;
        self.end_len = len;
        self
    }
    pub fn end_len(mut self, len: f64) -> Wall {
        self.end_len = len;
        self
    }
    pub fn damage(mut self, k: f64) -> Wall {
        self.damage_scale = k;
        self
    }
    pub fn clear(mut self, c: (f64, f64)) -> Wall {
        self.clear = c;
        self
    }

    /// Cut a piece along the mitre planes so tower segments meet cleanly.
    fn trim(&self, mut faces: Vec<LFace>, s_lo: f64, s_hi: f64) -> Vec<LFace> {
        let (e, t, l) = (self.miter, self.t, self.l);
        if e <= 0.0 {
            return faces;
        }
        if s_lo < 2.0 * e {
            faces = clip_faces(faces, [-1.0, 0.0, 2.0 * e / t], -e);
        }
        if !faces.is_empty() && s_hi > l - 2.0 * e {
            faces = clip_faces(faces, [1.0, 0.0, 2.0 * e / t], l - e);
        }
        faces
    }

    pub fn keep(&mut self, s0: f64, s1: f64, height: f64) {
        self.zones.push((s0.max(0.0), s1.min(self.l), height));
    }

    pub fn add_opening(&mut self, center: f64, width: f64, sill: f64, op: Op) -> Option<usize> {
        let mut o = Opening {
            a: center - width / 2.0,
            b: center + width / 2.0,
            sill,
            kind: op.kind,
            k: op.k,
            ring: op.ring,
            lights: op.lights,
            glass: op.glass,
            intact: op.intact,
            strong: op.strong,
            spring: sill,
            sill_h: 0.0,
            arch_ok: false,
            lower_ok: false,
            jambs: (0.0, 0.0),
        };
        let ring = op.ring;
        if o.a - ring < self.clear.0 || o.b + ring > self.l - self.clear.1 {
            return None;
        }
        let max_spring = self.prof.min_over(o.a - ring, o.b + ring) - op.margin - o.rise(ring);
        o.spring = match op.spring {
            Some(s) => s.min(max_spring),
            None => max_spring,
        };
        let need = if matches!(op.kind, Kind::Door | Kind::Arcade) { 1.9 } else { 0.5 };
        if o.spring - sill < need {
            return None;
        }
        for p in &self.openings {
            let s_hit = o.a - ring < p.b + p.ring + 0.05 && o.b + ring > p.a - p.ring - 0.05;
            let y_hit = sill - 0.3 < p.ext_apex() + 0.3 && o.ext_apex() + 0.3 > p.sill - 0.3;
            if s_hit && y_hit {
                return None;
            }
        }
        self.openings.push(o);
        Some(self.openings.len() - 1)
    }

    // ---- build ------------------------------------------------------------

    pub fn build(&mut self, ctx: &mut Ctx, index: usize) {
        let ch = ctx.course;
        for i in 0..self.openings.len() {
            let pad;
            let top;
            {
                let o = &mut self.openings[i];
                if ctx.bricks {
                    o.sill = snap(o.sill, ch);
                    o.spring = (o.sill + ch).max((o.spring / ch + 1e-6).floor() * ch);
                }
                if o.kind == Kind::Window && o.sill > 0.0 {
                    o.sill_h = if ctx.bricks { ch } else { 0.15 };
                }
                if o.intact.is_none() {
                    let p = (ctx.intact_arches * if o.strong { 2.0 } else { 1.0 }).min(1.0);
                    o.intact = Some(ctx.rng.random() < p);
                }
                if o.intact != Some(true) {
                    continue;
                }
                pad = o.ring + 0.35;
                top = o.ext_apex() + ctx.rng.uniform(0.3, 1.0);
            }
            let (a, b) = (self.openings[i].a, self.openings[i].b);
            self.keep(a - pad, b + pad, top);
        }
        let blocks = damage_blocks(&mut ctx.rng, self.l, ctx.damage * self.damage_scale, self.end_frac.0, self.end_frac.1, self.end_len);
        self.make_columns(ctx, &blocks);
        self.connect(0.04);
        self.check_openings();

        ctx.mesh.no_piece();
        if ctx.bricks {
            // Mortar round the arch stones; the rest is laid per course.
            let cols = self.arch_core_cols();
            self.emit_solid(ctx, RMat::Mortar, -self.t / 2.0 + ctx.joint_depth, self.t / 2.0 - ctx.joint_depth, ctx.gap / 2.0 + 0.015, Some(&cols));
            self.emit_bricks(ctx);
        } else {
            self.emit_solid(ctx, RMat::Stone, -self.t / 2.0, self.t / 2.0, 0.0, None);
        }
        for i in 0..self.openings.len() {
            if self.openings[i].kind == Kind::Window && self.openings[i].lower_ok {
                self.emit_window(ctx, i, index);
            }
        }
    }

    fn make_columns(&mut self, ctx: &mut Ctx, blocks: &[(f64, f64, f64)]) {
        let l = self.l;
        let rng = &mut ctx.rng;
        let ns = ((l / if ctx.bricks { ctx.brick_len / 2.0 } else { 0.15 }).ceil() as usize).max(2);
        let dx = l / ns as f64;
        let xs: Vec<f64> = (0..=ns).map(|i| i as f64 * dx).collect();
        let starts: Vec<f64> = blocks.iter().map(|b| b.0).collect();
        let env: Vec<f64> = xs.iter().map(|&x| self.prof.env_at(x)).collect();
        let mut d: Vec<f64> = xs
            .iter()
            .zip(&env)
            .map(|(&x, &e)| {
                let bi = starts.partition_point(|&s| s <= x).saturating_sub(1);
                (blocks[bi].2 * e).max(0.25)
            })
            .collect();
        // Arches not picked to stand usually lose their crown, leaving the
        // springers (half arches) on either side.
        let mut crowns: Vec<(Vec<usize>, f64)> = Vec::new();
        for o in &self.openings {
            if o.intact == Some(true) || !matches!(o.kind, Kind::Window | Kind::Door | Kind::Arcade) {
                continue;
            }
            if rng.random() < (0.3 + ctx.damage).min(0.9) {
                let c = o.c() + rng.gauss(0.0, 0.15) * o.w();
                let hw = (rng.uniform(0.15, 0.45) * o.w()).max(0.6 * dx);
                let cap = o.spring + (o.apex() - o.spring) * rng.uniform(0.0, 0.6);
                let idx: Vec<usize> = (0..xs.len()).filter(|&i| (xs[i] - c).abs() <= hw).collect();
                for &i in &idx {
                    d[i] = d[i].min(cap);
                }
                crowns.push((idx, cap));
            }
        }
        // Slopes are limited, so walls break in stepped diagonals.
        let k = rng.uniform(1.4, 3.2);
        let ks: Vec<f64> = xs.iter().map(|_| k * if rng.random() < 0.2 { 6.0 } else { rng.uniform(0.6, 1.4) }).collect();
        for i in 1..=ns {
            d[i] = d[i].min(d[i - 1] + ks[i] * dx);
        }
        for i in (0..ns).rev() {
            d[i] = d[i].min(d[i + 1] + ks[i] * dx);
        }
        let el = self.end_len.min(0.42 * l);
        let mut zones = self.zones.clone();
        if el > 0.0 {
            zones.push((0.0, el, self.end_frac.0 * self.prof.env_at(0.0)));
            zones.push((l - el, l, self.end_frac.1 * self.prof.env_at(l)));
        }
        let ksh = 4.0 * k; // standing zones fall away steeply on either side
        let mut junction: HashSet<usize> = HashSet::new();
        for (i, &x) in xs.iter().enumerate() {
            for &(z0, z1, zh) in &zones {
                let dd = (z0 - x).max(x - z1).max(0.0);
                let h = if zh == INF {
                    if dd == 0.0 {
                        junction.insert(i);
                        1e6
                    } else {
                        env[i] - ksh * dd
                    }
                } else {
                    zh - ksh * dd
                };
                d[i] = d[i].max(h);
            }
        }
        for (idx, cap) in &crowns {
            for &i in idx {
                if !junction.contains(&i) {
                    d[i] = d[i].min(*cap);
                }
            }
        }
        // Joined ends keep exactly the shared height.
        for (i, &x) in xs.iter().enumerate() {
            if x <= el + 1e-9 {
                d[i] = (self.end_frac.0 * env[i]).max(0.25);
            } else if x >= l - el - 1e-9 {
                d[i] = (self.end_frac.1 * env[i]).max(0.25);
            }
        }
        let damage_at = |s: f64| {
            let i = ((s / dx) as isize).clamp(0, ns as isize - 1) as usize;
            let u = (s - i as f64 * dx) / dx;
            d[i] * (1.0 - u) + d[i + 1] * u
        };

        let mut br: Vec<f64> = vec![0.0, l];
        br.extend(self.prof.pts.iter().map(|p| p.0));
        br.extend(&xs);
        for o in &self.openings {
            br.extend([o.a, o.b, o.c()]);
            for i in 1..4 {
                br.push(o.a - o.ring * i as f64 / 3.0);
                br.push(o.b + o.ring * i as f64 / 3.0);
            }
            let r = o.r();
            let th_a = ((o.c() - o.a - r) / r).clamp(-1.0, 1.0).acos();
            let n = ((r * (PI - th_a) / 0.2).ceil() as usize).max(3);
            for i in 1..n {
                let th = PI - (PI - th_a) * i as f64 / n as f64;
                let sl = o.a + r + r * th.cos();
                br.push(sl);
                br.push(2.0 * o.c() - sl);
            }
            for (m0, m1) in o.mullions() {
                br.extend([m0, m1]);
            }
        }
        br.retain(|&x| (0.0..=l).contains(&x));
        br.sort_by(f64::total_cmp);
        let mut clean = vec![br[0]];
        for &x in &br[1..] {
            if x - clean[clean.len() - 1] > 2e-3 {
                clean.push(x);
            }
        }
        let last = clean.len() - 1;
        clean[last] = l;
        self.edges = clean.clone();

        self.cols = clean
            .windows(2)
            .map(|w| {
                let (s0, s1) = (w[0], w[1]);
                let m = 0.5 * (s0 + s1);
                let mut tl = self.prof.at(s0, 1).min(damage_at(s0));
                let mut tr = self.prof.at(s1, -1).min(damage_at(s1));
                if ctx.bricks {
                    // whole courses only: nearest course, never above the design
                    let ch = ctx.course;
                    let mut q = (tl.min(tr) / ch).round() * ch;
                    if q > self.prof.at(s0, 1).min(self.prof.at(s1, -1)) + 1e-6 {
                        q -= ch;
                    }
                    tl = q.max(0.0);
                    tr = tl;
                }
                let mut voids: Vec<Iv> = self
                    .openings
                    .iter()
                    .filter(|o| o.a <= m && m <= o.b)
                    .map(|o| [o.sill_base(), o.sill_base(), o.intrados(s0), o.intrados(s1)])
                    .collect();
                voids.sort_by(|a, b| a[0].total_cmp(&b[0]));
                let mut raw: Vec<Iv> = Vec::new();
                let mut cb = (0.0, 0.0);
                for v in &voids {
                    raw.push([cb.0, cb.1, tl.min(v[0]), tr.min(v[1])]);
                    cb = (v[2], v[3]);
                }
                raw.push([cb.0, cb.1, tl, tr]);
                let ivs = raw
                    .into_iter()
                    .filter(|r| (r[2] - r[0]).max(r[3] - r[1]) >= 0.12)
                    .map(|r| [r[0], r[1], r[2].max(r[0]), r[3].max(r[1])])
                    .collect();
                Column { s0, s1, ivs }
            })
            .collect();
    }

    /// Keep only intervals connected to the ground through neighbours.
    fn connect(&mut self, eps: f64) {
        let cols = &self.cols;
        let mut alive: HashSet<(usize, usize)> = HashSet::new();
        let mut stack = Vec::new();
        for (i, c) in cols.iter().enumerate() {
            for (j, a) in c.ivs.iter().enumerate() {
                if a[0] <= 1e-6 && a[1] <= 1e-6 {
                    alive.insert((i, j));
                    stack.push((i, j));
                }
            }
        }
        while let Some((i, j)) = stack.pop() {
            let a = cols[i].ivs[j];
            for k in [i.wrapping_sub(1), i + 1] {
                if k >= cols.len() {
                    continue;
                }
                for (m, b) in cols[k].ivs.iter().enumerate() {
                    if alive.contains(&(k, m)) {
                        continue;
                    }
                    let (lo, hi) = if k > i { (a[1].max(b[0]), a[3].min(b[2])) } else { (a[0].max(b[1]), a[2].min(b[3])) };
                    if hi - lo > eps {
                        alive.insert((k, m));
                        stack.push((k, m));
                    }
                }
            }
        }
        for (i, c) in self.cols.iter_mut().enumerate() {
            let mut j = 0;
            c.ivs.retain(|_| {
                let keep = alive.contains(&(i, j));
                j += 1;
                keep
            });
        }
    }

    fn check_openings(&mut self) {
        let cols = &self.cols;
        for o in self.openings.iter_mut() {
            let idx: Vec<usize> = (0..cols.len())
                .filter(|&i| {
                    let m = 0.5 * (cols[i].s0 + cols[i].s1);
                    o.a <= m && m <= o.b
                })
                .collect();
            if idx.is_empty() {
                continue;
            }
            let jamb = |i: isize| -> f64 {
                if i < 0 || i as usize >= cols.len() {
                    return 0.0;
                }
                cols[i as usize].ivs.iter().filter(|a| a[0].min(a[1]) <= o.spring + 1e-6).map(|a| a[2].max(a[3])).fold(0.0, f64::max)
            };
            let head = idx.iter().all(|&i| {
                cols[i].ivs.iter().any(|a| (a[0] - o.intrados(cols[i].s0)).abs() < 1e-6 && a[2] >= a[0] + 0.9 * o.ring && a[3] >= a[1] + 0.9 * o.ring)
            });
            o.jambs = (jamb(idx[0] as isize - 1), jamb(*idx.last().unwrap() as isize + 1));
            o.arch_ok = head && o.jambs.0.min(o.jambs.1) >= o.spring + 0.2;
            o.lower_ok = o.sill_base() > 1e-6
                && idx.iter().all(|&i| cols[i].ivs.iter().any(|a| (a[2] - o.sill_base()).abs() < 1e-6 && (a[3] - o.sill_base()).abs() < 1e-6));
        }
    }

    pub fn col_at(&self, s: f64) -> &Column {
        let i = self.edges.partition_point(|&e| e <= s).saturating_sub(1).min(self.cols.len() - 1);
        &self.cols[i]
    }

    pub fn top_at(&self, s: f64) -> f64 {
        let c = self.col_at(s);
        let u = (s - c.s0) / (c.s1 - c.s0);
        c.ivs.iter().map(|a| a[2] + (a[3] - a[2]) * u).fold(0.0, f64::max)
    }

    pub fn solid_at(&self, s: f64, y: f64) -> bool {
        let c = self.col_at(s);
        let u = (s - c.s0) / (c.s1 - c.s0);
        c.ivs.iter().any(|a| a[0] + (a[1] - a[0]) * u - 1e-6 <= y && y <= a[2] + (a[3] - a[2]) * u + 1e-6)
    }

    // ---- solid walls ------------------------------------------------------

    /// Column intervals within arch zones, above the springing line.
    fn arch_core_cols(&self) -> Vec<Column> {
        self.cols
            .iter()
            .map(|c| {
                let m = 0.5 * (c.s0 + c.s1);
                let mut ivs = Vec::new();
                if let Some(o) = self.openings.iter().find(|o| o.a - o.ring - 1e-6 <= m && m <= o.b + o.ring + 1e-6) {
                    for a in &c.ivs {
                        if a[2].min(a[3]) > o.spring + 0.05 {
                            ivs.push([a[0].max(o.spring), a[1].max(o.spring), a[2], a[3]]);
                        }
                    }
                }
                Column { s0: c.s0, s1: c.s1, ivs }
            })
            .collect()
    }

    /// Closed, crack-free walls from the column intervals. Mortar becomes
    /// opaque occluders only; stone is drawn and hides what is behind it.
    fn emit_solid(&self, ctx: &mut Ctx, mat: RMat, t0: f64, t1: f64, top_drop: f64, cols: Option<&[Column]>) {
        let owned;
        let mut cols = cols.unwrap_or(&self.cols);
        if top_drop > 0.0 {
            owned = cols
                .iter()
                .map(|c| Column { s0: c.s0, s1: c.s1, ivs: c.ivs.iter().map(|a| [a[0], a[1], (a[2] - top_drop).max(a[0]), (a[3] - top_drop).max(a[1])]).collect() })
                .collect::<Vec<_>>();
            cols = &owned;
        }
        let fr = self.fr;
        let mesh = &mut ctx.mesh;
        let mut out = |pts: &[V], hint: V| mesh.poly(mat, pts, hint);
        for (i, col) in cols.iter().enumerate() {
            let (s0, s1) = (col.s0, col.s1);
            let left = if i > 0 { Some(&cols[i - 1].ivs) } else { None };
            let right = cols.get(i + 1).map(|c| &c.ivs);
            for &[bl, br, tl, tr] in &col.ivs {
                let mut rx: Vec<f64> = right.map_or(Vec::new(), |r| r.iter().flat_map(|b| [b[0], b[2]]).filter(|&y| br + 1e-6 < y && y < tr - 1e-6).collect());
                rx.sort_by(f64::total_cmp);
                rx.dedup();
                let mut lx: Vec<f64> = left.map_or(Vec::new(), |r| r.iter().flat_map(|b| [b[1], b[3]]).filter(|&y| bl + 1e-6 < y && y < tl - 1e-6).collect());
                lx.sort_by(|a, b| b.total_cmp(a));
                lx.dedup();
                let mut poly: Vec<P2> = vec![(s0, bl), (s1, br)];
                poly.extend(rx.iter().map(|&y| (s1, y)));
                poly.extend([(s1, tr), (s0, tl)]);
                poly.extend(lx.iter().map(|&y| (s0, y)));
                out(&poly.iter().map(|&(s, y)| fr.pt(s, y, t1)).collect::<Vec<_>>(), fr.vec(0.0, 0.0, 1.0));
                out(&poly.iter().map(|&(s, y)| fr.pt(s, y, t0)).collect::<Vec<_>>(), fr.vec(0.0, 0.0, -1.0));
                out(&[fr.pt(s0, tl, t0), fr.pt(s1, tr, t0), fr.pt(s1, tr, t1), fr.pt(s0, tl, t1)], fr.vec(-(tr - tl), s1 - s0, 0.0));
                if bl > 1e-6 || br > 1e-6 {
                    out(&[fr.pt(s0, bl, t0), fr.pt(s1, br, t0), fr.pt(s1, br, t1), fr.pt(s0, bl, t1)], fr.vec(br - bl, -(s1 - s0), 0.0));
                }
                let segs = match right {
                    None => if self.cap1 { vec![(br, tr)] } else { vec![] },
                    Some(r) => subtract_ranges(br, tr, &r.iter().map(|b| (b[0], b[2])).collect::<Vec<_>>()),
                };
                for (y0, y1) in segs {
                    out(&[fr.pt(s1, y0, t0), fr.pt(s1, y1, t0), fr.pt(s1, y1, t1), fr.pt(s1, y0, t1)], fr.vec(1.0, 0.0, 0.0));
                }
                let segs = match left {
                    None => if self.cap0 { vec![(bl, tl)] } else { vec![] },
                    Some(r) => subtract_ranges(bl, tl, &r.iter().map(|b| (b[1], b[3])).collect::<Vec<_>>()),
                };
                for (y0, y1) in segs {
                    out(&[fr.pt(s0, y0, t0), fr.pt(s0, y1, t0), fr.pt(s0, y1, t1), fr.pt(s0, y0, t1)], fr.vec(-1.0, 0.0, 0.0));
                }
            }
        }
    }

    // ---- bricks -----------------------------------------------------------

    /// Wedge stones round the arch, walked up from each springer and
    /// stopping where the wall is broken.
    fn voussoirs(&self, o: &Opening, ctx: &Ctx) -> Vec<Vec<P2>> {
        let (r, ring, sp) = (o.r(), o.ring, o.spring);
        let cx = o.a + r;
        let th_a = ((o.c() - cx) / r).clamp(-1.0, 1.0).acos();
        let span = PI - th_a;
        let n = ((r * span / (ctx.course * 1.15)).round() as usize).max(2);
        let dth = (span / n as f64 * 0.3).min(0.5 * ctx.gap / r);
        let mut out = Vec::new();
        for mirror in [false, true] {
            for i in 0..n {
                let t0 = if i == 0 { PI } else { PI - span * i as f64 / n as f64 - dth };
                let t1 = PI - span * (i + 1) as f64 / n as f64 + dth;
                let mut pts = vec![
                    (cx + r * t0.cos(), sp + r * t0.sin()),
                    (cx + r * t1.cos(), sp + r * t1.sin()),
                    (cx + (r + ring) * t1.cos(), sp + (r + ring) * t1.sin()),
                    (cx + (r + ring) * t0.cos(), sp + (r + ring) * t0.sin()),
                ];
                let tm = 0.5 * (t0 + t1);
                let mut cen = (cx + (r + ring / 2.0) * tm.cos(), sp + (r + ring / 2.0) * tm.sin());
                if mirror {
                    pts = pts.into_iter().map(|(s, y)| (2.0 * o.c() - s, y)).collect();
                    cen.0 = 2.0 * o.c() - cen.0;
                }
                if !self.solid_at(cen.0, cen.1) {
                    break;
                }
                out.push(pts);
            }
        }
        out
    }

    // (the branches draw random numbers in the reference's order)
    #[allow(clippy::if_same_then_else)]
    fn emit_bricks(&mut self, ctx: &mut Ctx) {
        let fr = self.fr;
        let (ch, bl, g, t, w) = (ctx.course, ctx.brick_len, ctx.gap, self.t, ctx.weathering);

        let mut vous = Vec::new();
        for o in &self.openings {
            vous.extend(self.voussoirs(o, ctx));
        }
        let vbox: Vec<(f64, f64, f64, f64, &Vec<P2>)> = vous
            .iter()
            .map(|v| {
                let (mut x0, mut x1, mut y0, mut y1) = (INF, -INF, INF, -INF);
                for &(s, y) in v {
                    x0 = x0.min(s);
                    x1 = x1.max(s);
                    y0 = y0.min(y);
                    y1 = y1.max(y);
                }
                (x0, x1, y0, y1, v)
            })
            .collect();
        for v in &vous {
            let tilt = 0.005 + 0.01 * w;
            let r = rot_matrix(ctx.drng.gauss(0.0, tilt), 0.0, ctx.drng.gauss(0.0, tilt));
            let pivot = [v.iter().map(|p| p.0).sum::<f64>() / 4.0, v.iter().map(|p| p.1).sum::<f64>() / 4.0, 0.0];
            let faces = prism_faces(v, -t / 2.0, t / 2.0, false, false);
            ctx.mesh.new_piece();
            // The joints between stones (radial faces) are buried.
            for (k, f) in faces.iter().enumerate() {
                ctx.mesh.show = k <= 2 || k == 4;
                emit_faces(&mut ctx.mesh, RMat::ArchStone, &fr, std::slice::from_ref(f), Some(&r), pivot, [0.0; 3]);
            }
            ctx.mesh.show = true;
        }

        // 'b' brick, 'o' opening / arch stone, 'd' damage (empty)
        let state = |col: &Column, ym: f64| -> u8 {
            let sc = 0.5 * (col.s0 + col.s1);
            if col.ivs.iter().any(|a| 0.5 * (a[0] + a[1]) <= ym && ym <= 0.5 * (a[2] + a[3])) {
                for &(x0, x1, y0, y1, v) in &vbox {
                    if x0 <= sc && sc <= x1 && y0 <= ym && ym <= y1 && point_in_convex(v, sc, ym) {
                        return b'o';
                    }
                }
                return b'b';
            }
            for o in &self.openings {
                if o.a - o.ring <= sc && sc <= o.b + o.ring && o.sill_base() - 1e-6 <= ym && ym <= o.ext_apex() {
                    return b'o';
                }
            }
            b'd'
        };

        let cols = &self.cols;
        let top = cols.iter().flat_map(|c| c.ivs.iter().map(|a| a[2].max(a[3]))).fold(0.0, f64::max);
        let nk = (top / ch - 1e-6).ceil().max(0.0) as usize;
        // (course, s0, s1, left end, right end); ends: 'w' wall end, 'o', 'd'
        let mut runs: Vec<(usize, f64, f64, u8, u8)> = Vec::new();
        for k in 0..nk {
            let st: Vec<u8> = cols.iter().map(|c| state(c, (k as f64 + 0.5) * ch)).collect();
            let mut i = 0;
            while i < st.len() {
                if st[i] != b'b' {
                    i += 1;
                    continue;
                }
                let mut j = i;
                while j + 1 < st.len() && st[j + 1] == b'b' {
                    j += 1;
                }
                runs.push((k, cols[i].s0, cols[j].s1, if i == 0 { b'w' } else { st[i - 1] }, if j == st.len() - 1 { b'w' } else { st[j + 1] }));
                i = j + 1;
            }
        }

        // Every course run must rest on the ground, another run or an arch stone.
        let mut by_k: HashMap<usize, Vec<usize>> = HashMap::new();
        for (i, r) in runs.iter().enumerate() {
            by_k.entry(r.0).or_default().push(i);
        }
        let mut alive: HashSet<usize> = HashSet::new();
        let mut stack = Vec::new();
        for (i, &(k, s0, s1, _, _)) in runs.iter().enumerate() {
            let mut seed = k == 0;
            if !seed {
                let (ya, yb) = ((k as f64 - 0.5) * ch, (k as f64 + 1.5) * ch);
                seed = vbox.iter().any(|&(x0, x1, y0, y1, _)| s1.min(x1) - s0.max(x0) > 0.02 && yb.min(y1) - ya.max(y0) > 0.0);
            }
            if seed {
                alive.insert(i);
                stack.push(i);
            }
        }
        while let Some(i) = stack.pop() {
            let (k, s0, s1) = (runs[i].0, runs[i].1, runs[i].2);
            for kk in [k.wrapping_sub(1), k + 1] {
                if let Some(list) = by_k.get(&kk) {
                    for &j in list {
                        if !alive.contains(&j) && s1.min(runs[j].2) - s0.max(runs[j].1) > 0.05 {
                            alive.insert(j);
                            stack.push(j);
                        }
                    }
                }
            }
        }

        let phase = ctx.drng.uniform(0.0, bl);
        let mut joint_cache: HashMap<(usize, usize), Vec<f64>> = HashMap::new();
        let l = self.l;
        let mut joints = |k: usize, leaf: usize, rng: &mut Rng| -> Vec<f64> {
            joint_cache
                .entry((k, leaf))
                .or_insert_with(|| {
                    let off = phase + (k % 2) as f64 * bl / 2.0 + leaf as f64 * bl * 0.37;
                    let j0 = (-off / bl).floor() as i64 - 1;
                    let j1 = ((l - off) / bl).ceil() as i64 + 1;
                    (j0..=j1).map(|j| off + j as f64 * bl + rng.uniform(-0.12, 0.12) * bl * w).collect()
                })
                .clone()
        };

        // Broken ends: snap to a joint (stepped toothing) or leave a slanted
        // broken brick. Only ends caused by damage, never jambs or wall ends.
        let mut fin: Vec<Vec<(f64, f64, f64, f64)>> = vec![Vec::new(); nk];
        let mut ends: Vec<Vec<(u8, u8)>> = vec![Vec::new(); nk];
        for k in 0..nk {
            let mut row_in: Vec<(usize, f64, f64, u8, u8)> = alive.iter().map(|&i| runs[i]).filter(|r| r.0 == k).collect();
            row_in.sort_by(|a, b| a.1.total_cmp(&b.1));
            let jl = joints(k, 0, &mut ctx.drng);
            let mut row: Vec<(f64, f64, f64, f64)> = Vec::new();
            let mut row_ends = Vec::new();
            let nearest = |x: f64| jl.iter().copied().min_by(|a, b| (a - x).abs().total_cmp(&(b - x).abs())).unwrap_or(x);
            for idx in 0..row_in.len() {
                let (_, mut r0, mut r1, e0, e1) = row_in[idx];
                let lim0 = row.last().map_or(-INF, |r| r.1 + 0.3 * bl);
                let lim1 = row_in.get(idx + 1).map_or(INF, |r| r.1 - 0.3 * bl);
                let supported = |a: f64, b: f64| k == 0 || fin[k - 1].iter().any(|r| r.0 <= a + 1e-6 && r.1 >= b - 1e-6);
                let (mut sl0, mut sl1) = (0.0, 0.0);
                if e1 == b'd' {
                    let jx = nearest(r1);
                    if 0.0 < jx - r1 && jx - r1 < 0.4 * bl && jx < lim1 && supported(r1, jx) && ctx.drng.random() < 0.6 {
                        r1 = jx;
                    } else if 0.0 < r1 - jx && r1 - jx < 0.5 * bl && ctx.drng.random() < 0.5 {
                        r1 = jx;
                    } else {
                        sl1 = ctx.drng.uniform(-0.6, 0.6) * ch;
                    }
                }
                if e0 == b'd' {
                    let jx = nearest(r0);
                    if 0.0 < r0 - jx && r0 - jx < 0.4 * bl && jx > lim0 && supported(jx, r0) && ctx.drng.random() < 0.6 {
                        r0 = jx;
                    } else if 0.0 < jx - r0 && jx - r0 < 0.5 * bl && ctx.drng.random() < 0.5 {
                        r0 = jx;
                    } else {
                        sl0 = ctx.drng.uniform(-0.6, 0.6) * ch;
                    }
                }
                if r1 - r0 > 0.15 {
                    row.push((r0, r1, sl0, sl1));
                    row_ends.push((e0, e1));
                }
            }
            fin[k] = row;
            ends[k] = row_ends;
        }

        // Stepped cracks running down from the broken tops.
        let mut cracks: HashMap<usize, Vec<(f64, f64, f64)>> = HashMap::new();
        let n_cracks = if w > 0.0 { (l * 0.12 * w + ctx.drng.random()) as usize } else { 0 };
        for _ in 0..n_cracks {
            let s = ctx.drng.uniform(0.5, l - 0.5);
            let ktop = (self.top_at(s) / ch) as i64 - 1;
            if ktop < 3 {
                continue;
            }
            let (mut c, dirn) = (s, ctx.drng.sign());
            let m = ctx.drng.randint(3, ktop.min(14));
            for i in 0..m {
                let width = ctx.drng.uniform(0.012, 0.03) * (1.0 - 0.5 * i as f64 / m as f64) * (0.5 + 0.7 * w);
                let slant = ctx.drng.uniform(-0.35, 0.35) * ch;
                cracks.entry((ktop - i) as usize).or_default().push((c, width, slant));
                if ctx.drng.random() < 0.8 {
                    c += dirn * bl / 2.0 * ctx.drng.uniform(0.7, 1.2);
                }
            }
        }
        let covered = |k: usize, a: f64, b: f64| fin.get(k).is_some_and(|row| row.iter().any(|r| r.0 <= a + 0.02 && r.1 >= b - 0.02));

        // Mortar core laid course by course, just behind and below the bricks
        // (opaque: it hides what is behind the wall).
        let (cin, cout) = (-t / 2.0 + ctx.joint_depth, t / 2.0 - ctx.joint_depth);
        ctx.mesh.no_piece();
        for (k, row) in fin.iter().enumerate() {
            for &(r0, r1, sl0, sl1) in row {
                let (a0, a1) = (r0 + g / 2.0 + 0.01 + sl0.abs() / 2.0, r1 - g / 2.0 - 0.01 - sl1.abs() / 2.0);
                if a1 - a0 > 0.02 {
                    let faces = prism_faces(&box2d(a0, a1, (k as f64 * ch - g / 2.0 - 0.004).max(0.0), (k + 1) as f64 * ch - g / 2.0 - 0.004), cin, cout, false, false);
                    for (pts, hint) in self.trim(faces, a0, a1) {
                        let wp: Vec<V> = pts.iter().map(|&p| fr.ptv(p)).collect();
                        ctx.mesh.occluder(&wp, fr.vecv(hint));
                    }
                }
            }
        }

        let mut cover = Vec::new();
        let n_leaf = ((t / (0.9f64).max(1.5 * bl)).round() as usize).max(1);
        let (minp, jit) = (0.3 * bl, ctx.jitter);
        let mats = [RMat::Brick, RMat::Brick, RMat::Brick, RMat::Brick, RMat::BrickDark, RMat::BrickLight];
        for k in 0..nk {
            let (y0, y1) = (k as f64 * ch, (k + 1) as f64 * ch);
            let ym = 0.5 * (y0 + y1);
            for (ri, &(r0, r1, sl0, sl1)) in fin[k].iter().enumerate() {
                let _ = ends[k][ri];
                for leaf in 0..n_leaf {
                    let (out0, out1) = (leaf == 0, leaf == n_leaf - 1);
                    let ta = -t / 2.0 + t * leaf as f64 / n_leaf as f64 + if out0 { 0.0 } else { g / 2.0 };
                    let tb = -t / 2.0 + t * (leaf + 1) as f64 / n_leaf as f64 - if out1 { 0.0 } else { g / 2.0 };
                    let jlist = joints(k, leaf, &mut ctx.drng);
                    let mut items: Vec<(f64, f64, f64)> = Vec::new();
                    for &x in &jlist {
                        if r0 + minp < x && x < r1 - minp {
                            items.push((x, g, ctx.drng.uniform(-0.04, 0.04) * ch * w));
                        }
                    }
                    for &(c, cw, csl) in cracks.get(&k).map_or(&[][..], |v| &v[..]) {
                        if !(r0 + 0.1 < c && c < r1 - 0.1) {
                            continue;
                        }
                        let near = items.iter().enumerate().min_by(|a, b| (a.1 .0 - c).abs().total_cmp(&(b.1 .0 - c).abs())).map(|(i, it)| (i, *it));
                        match near {
                            Some((i, it)) if (it.0 - c).abs() < 0.18 * bl => {
                                items.remove(i); // crack follows the joint
                                items.push((it.0, g + cw, csl));
                            }
                            _ => items.push((c, cw, csl)), // crack splits a brick
                        }
                    }
                    items.sort_by(|a, b| a.0.total_cmp(&b.0));
                    let mut cuts = vec![(r0, g, sl0)];
                    cuts.extend(items);
                    cuts.push((r1, g, sl1));
                    let last = cuts.len() - 2;
                    for (ci, pair) in cuts.windows(2).enumerate() {
                        let ((p0, g0, a0), (p1, g1, a1)) = (pair[0], pair[1]);
                        let yb = y0 + g / 2.0;
                        let yt = y1 - g / 2.0 - ctx.drng.uniform(0.0, 0.012) * w;
                        let (lb, lt) = (p0 + a0 * (yb - ym) / ch + g0 / 2.0, p0 + a0 * (yt - ym) / ch + g0 / 2.0);
                        let (rb, rt) = (p1 + a1 * (yb - ym) / ch - g1 / 2.0, p1 + a1 * (yt - ym) / ch - g1 / 2.0);
                        if (rb - lb).min(rt - lt) < 0.04 {
                            continue;
                        }
                        let exposed = !covered(k + 1, lb.min(lt), rb.max(rt));
                        if exposed && k > 0 && ctx.drng.random() < 0.12 * w {
                            continue; // fallen off the top
                        }
                        let mut lo = ta - if out0 { ctx.drng.uniform(-jit, jit) } else { 0.0 };
                        let mut hi = tb + if out1 { ctx.drng.uniform(-jit, jit) } else { 0.0 };
                        let mut poly = vec![(lb, yb), (rb, yb), (rt, yt), (lt, yt)];
                        if !exposed && ctx.drng.random() < 0.08 * w {
                            // eroded, sunken face
                            let e = ctx.drng.uniform(0.01, 0.025);
                            let (cs, cy) = (0.25 * (lb + rb + lt + rt), 0.5 * (yb + yt));
                            poly = poly.into_iter().map(|(s, y)| (cs + (s - cs) * (1.0 - 2.0 * e / (rb - lb).max(0.1)), cy + (y - cy) * (1.0 - 2.0 * e / (yt - yb).max(0.1)))).collect();
                            if out0 {
                                lo += ctx.drng.uniform(0.005, (ctx.joint_depth - 0.005).max(0.006));
                            }
                            if out1 {
                                hi -= ctx.drng.uniform(0.005, (ctx.joint_depth - 0.005).max(0.006));
                            }
                        }
                        let (tilt, shift, faces) = if exposed {
                            // loose, tilted bricks on the broken tops
                            let tilt = 0.01 + 0.07 * w * ctx.drng.random();
                            let shift = [ctx.drng.gauss(0.0, 0.008 * w), 0.0, ctx.drng.gauss(0.0, 0.01 * w)];
                            (tilt, shift, prism_faces(&poly, lo, hi, false, false))
                        } else {
                            (0.003 + 0.01 * w, [0.0; 3], prism_faces(&poly, lo, hi, !out0, !out1))
                        };
                        let faces = self.trim(faces, lb.min(lt), rb.max(rt));
                        if faces.is_empty() {
                            continue;
                        }
                        // big or deep stones tip less, or their tops cut into each other
                        let r = rot_matrix(
                            ctx.drng.gauss(0.0, tilt * (0.3 / (hi - lo)).min(1.0)),
                            ctx.drng.gauss(0.0, tilt * 0.5),
                            ctx.drng.gauss(0.0, tilt * (0.6 / bl).min(1.0)),
                        );
                        let pivot = [0.25 * (lb + rb + lt + rt), yb, 0.5 * (lo + hi)];
                        let mat = ctx.drng.choice(&mats);
                        ctx.mesh.new_piece();
                        // Which faces show: the wall faces, the top where nothing
                        // lies on it, and the ends of a run (not inner joints).
                        for f in &faces {
                            let h = norm(f.1);
                            let show = if h[2].abs() > 0.5 {
                                true
                            } else if h[1] > 0.5 {
                                exposed
                            } else if h[1] < -0.5 {
                                false
                            } else if h[0] > 0.5 {
                                ci == last
                            } else if h[0] < -0.5 {
                                ci == 0
                            } else {
                                true // a mitre cap
                            };
                            ctx.mesh.show = show;
                            emit_faces(&mut ctx.mesh, mat, &fr, std::slice::from_ref(f), Some(&r), pivot, shift);
                        }
                        ctx.mesh.show = true;
                        cover.push((lb.min(lt) - g / 2.0 - 0.005, rb.max(rt) + g / 2.0 + 0.005, yt));
                    }
                }
            }
        }
        self.cover = Some(cover);
    }

    // ---- windows ----------------------------------------------------------

    fn emit_window(&self, ctx: &mut Ctx, oi: usize, wall_index: usize) {
        let o = &self.openings[oi];
        let (fr, t) = (self.fr, self.t);
        let base = o.sill_base() - if ctx.bricks { ctx.gap / 2.0 } else { 0.0 };
        ctx.mesh.new_piece();
        emit_box(&mut ctx.mesh, RMat::WindowStone, &fr, o.a - 0.12, o.b + 0.12, base, o.sill, -t / 2.0 - 0.07, t / 2.0 + 0.07);
        let tm = (0.3f64).min(t * 0.5);
        for (m0, m1) in o.mullions() {
            let poly = if o.arch_ok {
                let mut p = vec![(m0, o.sill), (m1, o.sill), (m1, o.intrados(m1))];
                if m0 < o.c() && o.c() < m1 {
                    p.push((o.c(), o.apex()));
                }
                p.push((m0, o.intrados(m0)));
                p
            } else {
                // broken stub standing on the sill, the rest fell
                let full = o.intrados(m0).min(o.intrados(m1)) - o.sill;
                let h = (o.jambs.0.min(o.jambs.1).min(o.intrados(m0)).min(o.intrados(m1)) - o.sill) * ctx.drng.uniform(0.25, 0.9);
                if full - h.max(0.0) > 0.4 {
                    ctx.fallen.push((wall_index, 0.5 * (m0 + m1), full - h.max(0.0), tm));
                }
                if h < 0.25 {
                    continue;
                }
                vec![(m0, o.sill), (m1, o.sill), (m1, o.sill + h), (m0, o.sill + h)]
            };
            ctx.mesh.new_piece();
            emit_prism(&mut ctx.mesh, RMat::WindowStone, &fr, &poly, -tm / 2.0, tm / 2.0);
        }
        if ctx.glass && o.glass && o.arch_ok && ctx.drng.random() < ctx.glass_chance {
            self.emit_glass(ctx, o);
        }
    }

    fn emit_glass(&self, ctx: &mut Ctx, o: &Opening) {
        use RMat::*;
        const SCHEMES: [&[RMat]; 4] = [
            &[GlassBlue, GlassRed, GlassGold],
            &[GlassRed, GlassBlue, GlassGreen, GlassGold],
            &[GlassBlue, GlassPurple, GlassGold, GlassWhite],
            &[GlassGreen, GlassGold, GlassRed, GlassWhite],
        ];
        const BORDERS: [RMat; 4] = [GlassRed, GlassBlue, GlassGold, GlassPurple];
        let fr = self.fr;
        let scheme = SCHEMES[(ctx.drng.random() * 4.0) as usize % 4];
        let border = ctx.drng.choice(&BORDERS);
        let mut pattern: HashMap<(usize, usize), RMat> = HashMap::new();
        let mut bounds = vec![o.a];
        for (m0, m1) in o.mullions() {
            bounds.extend([m0, m1]);
        }
        bounds.push(o.b);
        let (lead, gt) = (0.03, 0.012);
        ctx.mesh.no_piece();
        for pair in bounds.chunks(2) {
            let (l0, l1) = (pair[0], pair[1]);
            let mut outline = vec![(l0, o.sill), (l1, o.sill), (l1, o.intrados(l1))];
            outline.extend(self.edges.iter().rev().filter(|&&x| l0 + 1e-6 < x && x < l1 - 1e-6).map(|&x| (x, o.intrados(x))));
            outline.push((l0, o.intrados(l0)));
            let top = outline.iter().fold(f64::NEG_INFINITY, |m, p| m.max(p.1));
            let nc = (((l1 - l0) / 0.26).round() as usize).max(1);
            let nr = (((top - o.sill) / 0.32).ceil() as usize).max(1);
            let (cw, rh) = ((l1 - l0) / nc as f64, (top - o.sill) / nr as f64);
            let shrink = (1.0 - 2.0 * lead / cw.min(rh)).max(0.0);
            for r in 0..nr {
                for j in 0..nc {
                    let (x0, y0) = (l0 + j as f64 * cw, o.sill + r as f64 * rh);
                    let cell = clip_convex(&[(x0, y0), (x0 + cw, y0), (x0 + cw, y0 + rh), (x0, y0 + rh)], &outline);
                    if cell.len() < 3 {
                        continue;
                    }
                    let area = poly_area(&cell).abs();
                    if area < 0.002 {
                        continue;
                    }
                    let mat = if j == 0 || j == nc - 1 || r == 0 || area < 0.97 * cw * rh {
                        border
                    } else {
                        let key = (r / 3, j.min(nc - 1 - j));
                        *pattern.entry(key).or_insert_with(|| scheme[(ctx.drng.random() * scheme.len() as f64) as usize % scheme.len()])
                    };
                    let n = cell.len() as f64;
                    let (cs, cy) = (cell.iter().map(|p| p.0).sum::<f64>() / n, cell.iter().map(|p| p.1).sum::<f64>() / n);
                    let ins: Vec<P2> = cell.iter().map(|&(s, y)| (cs + (s - cs) * shrink, cy + (y - cy) * shrink)).collect();
                    ctx.mesh.new_piece();
                    ctx.mesh.poly(mat, &ins.iter().map(|&(s, y)| fr.pt(s, y, gt)).collect::<Vec<_>>(), fr.vec(0.0, 0.0, 1.0));
                    ctx.mesh.poly(mat, &ins.iter().map(|&(s, y)| fr.pt(s, y, -gt)).collect::<Vec<_>>(), fr.vec(0.0, 0.0, -1.0));
                }
            }
        }
    }

    // ---- scene pass helpers -----------------------------------------------

    /// Mark the ground under standing wall so debris doesn't land inside it.
    pub fn block_footprint(&self, ground: &mut super::scene::Ground) {
        let yaw = self.fr.d.1.atan2(self.fr.d.0);
        let mut run: Option<(f64, f64)> = None;
        let flush = |run: (f64, f64), ground: &mut super::scene::Ground| {
            let p = self.fr.pt(0.5 * (run.0 + run.1), 0.0, 0.0);
            let cells = ground.cells(p[0], p[2], yaw, 0.5 * (run.1 - run.0) + 0.03, self.t / 2.0 + 0.06);
            ground.block(cells.as_deref());
        };
        for col in &self.cols {
            if col.ivs.iter().any(|a| a[0] <= 1e-6) {
                run = Some(match run {
                    None => (col.s0, col.s1),
                    Some((a, _)) => (a, col.s1),
                });
            } else if let Some(r) = run.take() {
                flush(r, ground);
            }
        }
        if let Some(r) = run {
            flush(r, ground);
        }
    }

    /// (volume lost, s0, s1, height lost) per column.
    pub fn debris_sources(&self) -> Vec<(f64, f64, f64, f64)> {
        let mut out = Vec::new();
        for c in &self.cols {
            let top = c.ivs.iter().map(|a| a[2].max(a[3])).fold(0.0, f64::max);
            let lost = (self.prof.at(0.5 * (c.s0 + c.s1), 1) - top).max(0.0);
            if lost > 0.05 {
                out.push((lost * (c.s1 - c.s0) * self.t, c.s0, c.s1, lost));
            }
        }
        out
    }

    /// Where a person can't walk through this wall: circles (x, z, r) along
    /// the stretches standing over 0.6 m (for the walking player).
    pub fn colliders(&self) -> Vec<[f64; 3]> {
        let r = (self.t / 2.0).max(0.25);
        let step = r * 0.9;
        let n = (self.l / step).ceil() as usize;
        let mut out = Vec::new();
        for i in 0..=n {
            let s = (i as f64 * step).min(self.l);
            if self.solid_at(s, 0.3) && self.solid_at(s, 0.9) {
                let p = self.fr.pt(s, 0.0, 0.0);
                out.push([p[0], p[2], r]);
            }
        }
        out
    }

    // ---- vegetation -------------------------------------------------------

    /// Double-sided flat polygon parallel to the wall at offset t.
    fn flat_patch(&self, ctx: &mut Ctx, mat: RMat, poly: &[P2], t: f64, side: f64) {
        let fr = self.fr;
        ctx.mesh.poly(mat, &poly.iter().map(|&(s, y)| fr.pt(s, y, t)).collect::<Vec<_>>(), fr.vec(0.0, 0.0, side));
    }

    /// Height of the walkable top of the wall at x (None where there is no wall).
    fn surface(&self, x: f64) -> Option<f64> {
        if self.cover.is_none() {
            let c = self.col_at(x);
            return if c.ivs.is_empty() { None } else { Some(self.top_at(x)) };
        }
        let mut best: Option<f64> = None;
        if let Some(bin) = self.cover_bins.get(&((x / 0.5).floor() as i64)) {
            for &(a, b, y) in bin {
                if a <= x && x <= b && best.is_none_or(|v| y > v) {
                    best = Some(y);
                }
            }
        }
        best
    }

    pub fn emit_moss(&mut self, ctx: &mut Ctx) {
        let amt = ctx.moss;
        if amt <= 0.0 {
            return;
        }
        let t = self.t;
        let face = t / 2.0 + if ctx.bricks { 0.04 } else { 0.006 };
        let breaks: Vec<f64> = if let Some(cover) = &self.cover {
            self.cover_bins.clear();
            for &(a, b, y) in cover {
                for i in ((a / 0.5).floor() as i64)..=((b / 0.5).floor() as i64) {
                    self.cover_bins.entry(i).or_default().push((a, b, y));
                }
            }
            let mut v: Vec<f64> = cover.iter().flat_map(|&(a, b, _)| [(a * 1e4).round() / 1e4, (b * 1e4).round() / 1e4]).collect();
            v.sort_by(f64::total_cmp);
            v.dedup();
            v
        } else {
            self.edges.clone()
        };
        ctx.mesh.no_piece();
        let n = (amt * self.l / 3.0 + ctx.vrng.random()) as usize;
        for _ in 0..n {
            let sc = ctx.vrng.uniform(0.0, self.l);
            let length = ctx.vrng.uniform(0.8, 3.2) * (0.6 + 0.5 * amt);
            self.moss_patch(ctx, sc, length, &breaks);
        }
        let n = (amt * self.l * 0.25 + ctx.vrng.random()) as usize;
        for _ in 0..n {
            // damp patches near the ground
            let side = ctx.vrng.sign();
            let s = ctx.vrng.uniform(0.3, self.l - 0.3);
            let (rw, rh, yc) = (ctx.vrng.uniform(0.2, 0.7), ctx.vrng.uniform(0.12, 0.45), ctx.vrng.uniform(0.0, 0.5));
            let pts: Vec<P2> = (0..9)
                .map(|i| {
                    let a = std::f64::consts::TAU * i as f64 / 9.0;
                    let f = ctx.vrng.uniform(0.75, 1.1);
                    (s + rw * f * a.cos(), (yc + rh * f * a.sin()).max(0.01))
                })
                .collect();
            let hull = convex_hull(&pts);
            if hull.len() >= 3 && hull.iter().all(|&(ps, py)| self.solid_at(ps, py)) {
                self.flat_patch(ctx, RMat::Moss, &hull, side * face, side);
            }
        }
    }

    /// A moss cushion along the top, thinning to nothing at both ends,
    /// draping over steps, with a few loose tufts beyond its ends.
    fn moss_patch(&self, ctx: &mut Ctx, sc: f64, length: f64, breaks: &[f64]) {
        let (t, l, fr) = (self.t, self.l, self.fr);
        let (a, b) = ((sc - length / 2.0).max(0.0), (sc + length / 2.0).min(l));
        if b - a < 0.3 {
            return;
        }
        let rng = &mut ctx.vrng;
        let taper = (b - a) * rng.uniform(0.28, 0.45);
        let (th_max, ov) = (rng.uniform(0.025, 0.05), rng.uniform(0.0, 0.05));
        let (f1, p1) = (rng.uniform(1.5, 4.0), rng.uniform(0.0, 6.3));
        let (f2, p2) = (rng.uniform(5.0, 11.0), rng.uniform(0.0, 6.3));
        let lift = 0.003;
        // (x, y, centre, half width, thickness, density)
        let point = |x: f64| -> Option<[f64; 6]> {
            let y = self.surface(x)?;
            let e = ((x - a).min(b - x) / taper).clamp(0.0, 1.0);
            let d = e * e * (3.0 - 2.0 * e) * (0.8 + 0.2 * (f2 * x + p2).sin());
            if d < 0.06 {
                return None;
            }
            let c = 0.4 * (t / 2.0) * (f1 * x + p1).sin() * (1.0 - 0.6 * d);
            let w = ((t / 2.0 + ov) * d.powf(0.6)).min(t / 2.0 + ov - c.abs());
            if w < 0.01 {
                return None;
            }
            Some([x, y + lift, c, w, (th_max * d).max(0.004), d])
        };
        let mut xs: Vec<f64> = (0..=((b - a) / 0.12) as usize).map(|i| a + i as f64 * 0.12).collect();
        xs.push(b);
        let mut steps: HashSet<i64> = HashSet::new();
        let key = |x: f64| (x * 1e6).round() as i64;
        let lo = breaks.partition_point(|&e| e < a);
        let hi = breaks.partition_point(|&e| e <= b);
        for &e in &breaks[lo..hi] {
            match (self.surface(e - 0.0005), self.surface(e + 0.0005)) {
                (Some(ya), Some(yb)) if (ya - yb).abs() > 0.03 => {
                    xs.push(e - 0.0005);
                    xs.push(e + 0.0005);
                    steps.insert(key(e - 0.0005));
                }
                _ => {
                    if self.cover.is_none() {
                        xs.push(e);
                    }
                }
            }
        }
        xs.sort_by(f64::total_cmp);
        xs.dedup();
        let mut runs: Vec<Vec<[f64; 6]>> = Vec::new();
        let mut run: Vec<[f64; 6]> = Vec::new();
        let mut risers: Vec<([f64; 6], [f64; 6])> = Vec::new();
        for &x in &xs {
            let Some(p) = point(x) else {
                if !run.is_empty() {
                    runs.push(std::mem::take(&mut run));
                }
                continue;
            };
            if let Some(&last) = run.last() {
                if steps.contains(&key(last[0])) && (p[1] - last[1]).abs() > 0.03 {
                    risers.push((last, p));
                    runs.push(std::mem::take(&mut run));
                } else if p[0] - last[0] < 0.015 {
                    if steps.contains(&key(p[0])) {
                        let n = run.len();
                        run[n - 1] = p;
                    }
                    continue;
                }
            }
            run.push(p);
        }
        if !run.is_empty() {
            runs.push(run);
        }
        let mut faces: Vec<LFace> = Vec::new();
        for run in &runs {
            for i in 0..run.len().saturating_sub(1) {
                moss_segment(&mut faces, run[i], run[i + 1], i == 0, i == run.len() - 2);
            }
        }
        emit_faces(&mut ctx.mesh, RMat::Moss, &fr, &faces, None, [0.0; 3], [0.0; 3]);
        for run in &runs {
            for p in run {
                // streaks where it reaches an edge
                if p[2].abs() + p[3] > t / 2.0 - 0.01 && ctx.vrng.random() < 0.1 * ctx.moss {
                    let side = if p[2].abs() > 0.02 { p[2].signum() } else { ctx.vrng.sign() };
                    let w = 0.25 * ctx.vrng.uniform(0.4, 1.0);
                    let ytop = p[1] + 0.01;
                    let mut ybot = p[1] - ctx.vrng.uniform(0.08, 0.5) * p[5];
                    while ybot < ytop - 0.06 && !self.solid_at(p[0], ybot) {
                        ybot += 0.04;
                    }
                    if ybot < ytop - 0.06 {
                        let face = t / 2.0 + if ctx.bricks { 0.04 } else { 0.006 };
                        self.flat_patch(ctx, RMat::Moss, &[(p[0] - w / 2.0, ytop), (p[0] + w / 2.0, ytop), (p[0] + w * 0.15, ybot), (p[0] - w * 0.15, ybot)], side * face, side);
                    }
                }
            }
        }
        for (p, q) in risers {
            // moss draping down a step
            let (lo, hi) = if p[1] > q[1] { (q, p) } else { (p, q) };
            let xb = 0.5 * (p[0] + q[0]);
            let th = lo[4];
            let (s0, s1) = if p[1] > q[1] { (xb, xb + th) } else { (xb - th, xb) };
            let bottom = if hi[1] - lo[1] < 0.6 { lo[1] } else { hi[1] - ctx.vrng.uniform(0.1, 0.35) * hi[5] };
            emit_prism(&mut ctx.mesh, RMat::Moss, &fr, &box2d(s0, s1, bottom, hi[1] + hi[4]), lo[2] - lo[3], lo[2] + lo[3]);
        }
        for (end, sgn) in [(a, -1.0), (b, 1.0)] {
            // loose tufts past the ends
            for _ in 0..ctx.vrng.randint(1, 4) {
                let x = end + sgn * ctx.vrng.uniform(0.0, 0.45);
                let r = ctx.vrng.uniform(0.02, 0.07);
                let y = if 0.0 < x && x < l { self.surface(x) } else { None };
                let Some(y) = y else { continue };
                if self.surface(x - r) != Some(y) || self.surface(x + r) != Some(y) {
                    continue;
                }
                let tt = ctx.vrng.uniform(-t / 2.0 + r, t / 2.0 - r);
                let pts: Vec<P2> = (0..6)
                    .map(|i| {
                        let a = std::f64::consts::TAU * i as f64 / 6.0;
                        (x + r * ctx.vrng.uniform(0.7, 1.1) * a.cos(), tt + r * ctx.vrng.uniform(0.7, 1.1) * a.sin())
                    })
                    .collect();
                let hull = convex_hull(&pts);
                if hull.len() >= 3 {
                    let th = ctx.vrng.uniform(0.006, 0.015);
                    let faces: Vec<LFace> = vec![(hull.iter().map(|&(s, q)| [s, y + lift + th, q]).collect(), [0.0, 1.0, 0.0])];
                    emit_faces(&mut ctx.mesh, RMat::Moss, &fr, &faces, None, [0.0; 3], [0.0; 3]);
                }
            }
        }
    }

    pub fn emit_vines(&self, ctx: &mut Ctx) {
        let amt = ctx.vines;
        if amt <= 0.0 {
            return;
        }
        let off = self.t / 2.0 + if ctx.bricks { 0.05 } else { 0.025 };
        ctx.mesh.no_piece();
        let n = (amt * self.l / 3.2 + ctx.vrng.random()) as usize;
        for _ in 0..n {
            let side = ctx.vrng.sign();
            let s = ctx.vrng.uniform(0.4, self.l - 0.4);
            if self.solid_at(s, 0.05) && self.top_at(s) >= 1.0 {
                let max_len = ctx.vrng.uniform(3.0, 10.0) * (0.6 + 0.4 * amt);
                self.grow_vine(ctx, s, side, off, max_len);
            }
        }
    }

    /// Random walk up the wall face, branching, avoiding openings; may drape
    /// over the top and hang down the other side.
    fn grow_vine(&self, ctx: &mut Ctx, s: f64, side: f64, off: f64, max_len: f64) {
        let (l, step) = (self.l, 0.2);
        let g0 = ctx.vrng.gauss(0.0, 0.25);
        let mut stack = vec![(s, 0.02, g0, 0usize, max_len)];
        while let Some((mut s, mut y, mut ang, depth, lim)) = stack.pop() {
            let mut path = vec![(s, y)];
            let mut length = 0.0;
            while length < lim {
                ang += ctx.vrng.gauss(0.0, 0.22) - 0.1 * ang;
                let mut moved = false;
                for da in [0.0, 0.6, -0.6, 1.2, -1.2] {
                    let a2 = (ang + da).clamp(-1.5, 1.5);
                    let (ns, ny) = (s + step * a2.sin(), y + step * a2.cos());
                    if 0.05 < ns && ns < l - 0.05 && ny > 0.01 && self.solid_at(ns, ny) {
                        s = ns;
                        y = ny;
                        ang = a2;
                        moved = true;
                        break;
                    }
                }
                if !moved {
                    break;
                }
                path.push((s, y));
                length += step;
                if depth < 2 && ctx.vrng.random() < 0.13 {
                    let a = ang + ctx.vrng.sign() * ctx.vrng.uniform(0.7, 1.3);
                    stack.push((s, y, a, depth + 1, (lim - length) * ctx.vrng.uniform(0.3, 0.6)));
                }
            }
            if path.len() < 3 {
                continue;
            }
            let mut pts: Vec<V> = path.iter().map(|&(ps, py)| [ps, py, side * off]).collect();
            let mut nrm: Vec<V> = vec![[0.0, 0.0, side]; pts.len()];
            let top = self.top_at(s);
            if depth == 0 && top - y < 0.35 && ctx.vrng.random() < 0.6 {
                let yt = top + if ctx.bricks { 0.06 } else { 0.025 };
                for tt in [side * off, side * self.t * 0.2, -side * self.t * 0.2, -side * off] {
                    pts.push([s, yt, tt]);
                    nrm.push([0.0, 1.0, 0.0]);
                }
                let (mut yy, hang) = (top, ctx.vrng.uniform(0.3, 1.6));
                while yy > top - hang && yy > 0.2 && self.solid_at(s, yy - 0.15) {
                    yy -= 0.15;
                    pts.push([s + ctx.vrng.gauss(0.0, 0.02), yy, -side * off]);
                    nrm.push([0.0, 0.0, -side]);
                }
            }
            self.emit_vine_path(ctx, &pts, &nrm, depth);
        }
    }

    fn emit_vine_path(&self, ctx: &mut Ctx, pts: &[V], nrm: &[V], depth: usize) {
        let fr = self.fr;
        let n = pts.len();
        let w0 = 0.045 * 0.6f64.powi(depth as i32);
        for i in 0..n - 1 {
            let (p, q) = (pts[i], pts[i + 1]);
            let d = sub(q, p);
            if len(d) < 1e-6 {
                continue;
            }
            let mut nr = nrm[i];
            let mut wv = cross(norm(d), nr);
            if len(wv) < 1e-3 {
                nr = nrm[i + 1];
                wv = cross(norm(d), nr);
                if len(wv) < 1e-3 {
                    continue;
                }
            }
            let wv = norm(wv);
            let (wa, wb) = (w0 * (1.0 - 0.6 * i as f64 / n as f64), w0 * (1.0 - 0.6 * (i + 1) as f64 / n as f64));
            let quad = [sub(p, scale(wv, wa / 2.0)), add(p, scale(wv, wa / 2.0)), add(q, scale(wv, wb / 2.0)), sub(q, scale(wv, wb / 2.0))];
            ctx.mesh.poly(RMat::Vine, &quad.iter().map(|&x| fr.ptv(x)).collect::<Vec<_>>(), fr.vecv(nr));
        }
        for (i, &p) in pts.iter().enumerate() {
            if ctx.vrng.random() < 0.75 {
                let k = if ctx.vrng.random() < 0.65 { 1 } else { 2 };
                for _ in 0..k {
                    self.emit_leaf(ctx, p, nrm[i], (1.0 - 0.5 * i as f64 / n as f64) * 0.75f64.powi(depth as i32));
                }
            }
        }
    }

    fn emit_leaf(&self, ctx: &mut Ctx, p: V, nrm: V, sc: f64) {
        let fr = self.fr;
        let rng = &mut ctx.vrng;
        let sz = rng.uniform(0.09, 0.18) * sc.max(0.45);
        let mut nl = norm(add(nrm, [rng.gauss(0.0, 0.45), rng.gauss(0.25, 0.4), rng.gauss(0.0, 0.45)]));
        if dot(nl, nrm) < 0.3 {
            nl = nrm;
        }
        let a = rng.uniform(0.0, std::f64::consts::TAU);
        let e1 = norm(cross(nl, [a.cos(), a.sin(), 0.37]));
        if len(e1) < 0.5 {
            return;
        }
        let e2 = cross(nl, e1);
        let mut c = add(p, scale(nrm, rng.uniform(0.015, 0.05)));
        c = add(c, add(scale(e1, rng.gauss(0.0, 0.04)), scale(e2, rng.gauss(0.0, 0.04))));
        const SHAPE: [(f64, f64); 5] = [(0.0, 1.0), (0.55, 0.35), (0.42, -0.3), (-0.42, -0.3), (-0.55, 0.35)];
        let pts: Vec<V> = SHAPE.iter().map(|&(x, y)| fr.ptv(add(c, add(scale(e1, x * sz), scale(e2, y * sz))))).collect();
        let mat = if rng.random() < 0.65 { RMat::Leaf } else { RMat::LeafDark };
        ctx.mesh.poly(mat, &pts, fr.vecv(nl));
    }
}

/// A moss segment between two points: a hexahedron with planar faces.
fn moss_segment(faces: &mut Vec<LFace>, p: [f64; 6], q: [f64; 6], cap0: bool, cap1: bool) {
    let [x0, y0, c0, w0, t0, _] = p;
    let [x1, y1, c1, w1, t1, _] = q;
    let a = [[x0, y0, c0 - w0], [x1, y1, c1 - w1], [x1, y1, c1 + w1], [x0, y0, c0 + w0]];
    let b = [[x0, y0 + t0, c0 - w0], [x1, y1 + t1, c1 - w1], [x1, y1 + t1, c1 + w1], [x0, y0 + t0, c0 + w0]];
    faces.push((b.to_vec(), [0.0, 1.0, 0.0]));
    faces.push((vec![a[0], a[1], b[1], b[0]], [0.0, 0.0, -1.0]));
    faces.push((vec![a[3], a[2], b[2], b[3]], [0.0, 0.0, 1.0]));
    if cap0 {
        faces.push((vec![a[0], a[3], b[3], b[0]], [-1.0, 0.0, 0.0]));
    }
    if cap1 {
        faces.push((vec![a[1], a[2], b[2], b[1]], [1.0, 0.0, 0.0]));
    }
}
