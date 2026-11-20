//! After the walls: piers, debris piled with a height map so nothing
//! floats, then moss and vines (port of the scene pass in `ruins.py`).

use super::geom::*;
use super::wall::Wall;
use super::Ctx;

/// Height map used to stack debris, plus cells blocked by walls and piers.
pub struct Ground {
    x0: f64,
    z0: f64,
    cell: f64,
    nx: usize,
    nz: usize,
    h: Vec<f64>,
    blocked: Vec<bool>,
}

impl Ground {
    pub fn new(x0: f64, z0: f64, x1: f64, z1: f64) -> Ground {
        let cell = 0.15;
        let nx = ((x1 - x0) / cell) as usize + 1;
        let nz = ((z1 - z0) / cell) as usize + 1;
        Ground { x0, z0, cell, nx, nz, h: vec![0.0; nx * nz], blocked: vec![false; nx * nz] }
    }

    /// Cells under a rotated rectangle (half sizes hx along yaw, hz across),
    /// or None if it leaves the map.
    pub fn cells(&self, cx: f64, cz: f64, yaw: f64, hx: f64, hz: f64) -> Option<Vec<usize>> {
        let (c, s, cell) = (yaw.cos(), yaw.sin(), self.cell);
        let (ex, ez) = (c.abs() * hx + s.abs() * hz, s.abs() * hx + c.abs() * hz);
        let i0 = ((cx - ex - self.x0) / cell).floor() as i64;
        let i1 = ((cx + ex - self.x0) / cell).floor() as i64;
        let j0 = ((cz - ez - self.z0) / cell).floor() as i64;
        let j1 = ((cz + ez - self.z0) / cell).floor() as i64;
        if i0 < 0 || j0 < 0 || i1 >= self.nx as i64 || j1 >= self.nz as i64 {
            return None;
        }
        let mut out = Vec::new();
        for j in j0..=j1 {
            let pz = self.z0 + (j as f64 + 0.5) * cell - cz;
            for i in i0..=i1 {
                let px = self.x0 + (i as f64 + 0.5) * cell - cx;
                if (px * c + pz * s).abs() <= hx && (pz * c - px * s).abs() <= hz {
                    out.push(j as usize * self.nx + i as usize);
                }
            }
        }
        if out.is_empty() {
            out.push(((cz - self.z0) / cell) as usize * self.nx + ((cx - self.x0) / cell) as usize);
        }
        Some(out)
    }

    pub fn free(&self, cells: Option<&[usize]>) -> bool {
        cells.is_some_and(|c| !c.iter().any(|&k| self.blocked[k]))
    }
    fn support(&self, cells: &[usize]) -> f64 {
        cells.iter().map(|&k| self.h[k]).fold(f64::NEG_INFINITY, f64::max)
    }
    pub fn block(&mut self, cells: Option<&[usize]>) {
        for &k in cells.unwrap_or(&[]) {
            self.blocked[k] = true;
        }
    }
    fn raise_to(&mut self, cells: &[usize], y: f64) {
        for &k in cells {
            if self.h[k] < y {
                self.h[k] = y;
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Debris {
    Chunk,
    Block,
    Grit,
}

/// One loose piece: (parts, footprint length, footprint depth, height).
fn debris_piece(ctx: &mut Ctx, kind: Debris) -> (Vec<Part>, f64, f64, f64) {
    let rng = &mut ctx.prng;
    if ctx.bricks {
        let (bl, ch, g) = (ctx.brick_len, ctx.course, ctx.gap);
        let depth = (0.45f64).min(bl * 0.6);
        let mats = [RMat::Brick, RMat::Brick, RMat::BrickDark, RMat::BrickLight];
        match kind {
            Debris::Chunk => {
                // a few bricks still mortared together
                let (nx, ny) = (rng.randint(2, 3) as usize, rng.randint(1, 2) as usize);
                let mut parts = Vec::new();
                for j in 0..ny {
                    for i in 0..nx {
                        let s0 = -(nx as f64) * bl / 2.0 + i as f64 * bl + (j % 2) as f64 * bl / 2.0;
                        parts.push(Part { mat: rng.choice(&mats), poly: box2d(s0 + g / 2.0, s0 + bl - g / 2.0, j as f64 * ch + g / 2.0, (j + 1) as f64 * ch - g / 2.0), t0: -depth / 2.0, t1: depth / 2.0 });
                    }
                }
                let dx = (ny - 1) as f64 * bl / 4.0; // centre the staggered rows on the footprint
                for p in &mut parts {
                    for q in &mut p.poly {
                        q.0 -= dx;
                    }
                }
                return (parts, nx as f64 * bl + (ny - 1) as f64 * bl / 2.0, depth, ny as f64 * ch);
            }
            Debris::Block => {
                let ln = bl * rng.choice(&[0.4, 0.6, 1.0, 1.0]);
                let part = Part { mat: rng.choice(&mats), poly: box2d(-ln / 2.0, ln / 2.0, 0.0, ch - g), t0: -depth / 2.0, t1: depth / 2.0 };
                return (vec![part], ln, depth, ch);
            }
            Debris::Grit => {
                let sz = rng.uniform(0.05, 0.16);
                let mat = rng.choice(&[RMat::Rubble, RMat::BrickDark]);
                let poly = vec![(-sz / 2.0, 0.0), (sz / 2.0, 0.0), (rng.uniform(-0.3, 0.3) * sz, sz * rng.uniform(0.4, 0.8))];
                return (vec![Part { mat, poly, t0: -sz * 0.4, t1: sz * 0.4 }], sz, sz * 0.8, sz * 0.8);
            }
        }
    }
    let (sx, sy, sz) = match kind {
        Debris::Chunk => (rng.uniform(0.5, 1.1), rng.uniform(0.3, 0.6), rng.uniform(0.4, 0.8)),
        Debris::Block => {
            let sx = rng.uniform(0.2, 0.5);
            (sx, sx * rng.uniform(0.45, 0.8), sx * rng.uniform(0.6, 1.2))
        }
        Debris::Grit => {
            let sx = rng.uniform(0.05, 0.14);
            let (sy, sz) = (sx * rng.uniform(0.4, 0.8), sx * rng.uniform(0.6, 1.1));
            let poly = vec![(-sx / 2.0, 0.0), (sx / 2.0, 0.0), (rng.uniform(-0.3, 0.3) * sx, sy)];
            return (vec![Part { mat: RMat::Rubble, poly, t0: -sz / 2.0, t1: sz / 2.0 }], sx, sz, sy);
        }
    };
    let (a, b) = (rng.uniform(0.0, 0.3) * sx, rng.uniform(0.0, 0.3) * sx); // broken, wedge-like faces
    let poly = vec![(-sx / 2.0, 0.0), (sx / 2.0, 0.0), (sx / 2.0 - a, sy * rng.uniform(0.6, 1.0)), (-sx / 2.0 + b, sy)];
    (vec![Part { mat: RMat::Rubble, poly, t0: -sz / 2.0, t1: sz / 2.0 }], sx, sz, sy)
}

/// Rest a rigid piece on the ground or on the pile under it. False if the
/// spot is blocked (a wall, a standing pier).
#[allow(clippy::too_many_arguments)]
fn drop_piece(ctx: &mut Ctx, x: f64, z: f64, yaw: f64, parts: &[Part], sx: f64, sz: f64, tilt_ground: f64, tilt_pile: f64, embed: f64, point_top: bool) -> bool {
    let ground = ctx.ground.as_mut().expect("ground");
    let Some(cells) = ground.cells(x, z, yaw, sx / 2.0, sz / 2.0) else { return false };
    if parts.is_empty() || !ground.free(Some(&cells)) {
        return false;
    }
    let sup = ground.support(&cells);
    let t = if sup > 0.02 { tilt_pile } else { tilt_ground };
    let (rx, rz) = (ctx.prng.uniform(-t, t), ctx.prng.uniform(-t, t));
    let mut top = emit_rigid(&mut ctx.mesh, x, z, yaw, rx, rz, sup, parts, embed);
    if point_top {
        // pointed little pieces: only their base counts
        top = sup + 0.2 * parts.iter().flat_map(|p| p.poly.iter().map(|q| q.1)).fold(0.0, f64::max);
    }
    ctx.ground.as_mut().unwrap().raise_to(&cells, sup.max(top));
    true
}

#[allow(clippy::too_many_arguments)]
fn drop_default(ctx: &mut Ctx, x: f64, z: f64, yaw: f64, parts: &[Part], sx: f64, sz: f64, point_top: bool) -> bool {
    drop_piece(ctx, x, z, yaw, parts, sx, sz, 0.05, 0.15, 0.015, point_top)
}

/// Drop fallen pieces near the walls they came from.
fn place_debris(ctx: &mut Ctx, walls: &[Wall]) {
    let amt = ctx.rubble;
    if amt <= 0.0 {
        return;
    }
    let fallen = std::mem::take(&mut ctx.fallen);
    for (wi, s, length, tm) in fallen {
        // broken window mullions
        let w = &walls[wi];
        let pieces = if length < 1.2 || ctx.prng.random() < 0.4 { vec![length] } else { vec![length * 0.55, length * 0.45] };
        for ln in pieces {
            let side = ctx.prng.sign();
            let ds = ctx.prng.gauss(0.0, 0.3);
            let dt = ctx.prng.uniform(0.3, 1.4);
            let p = w.fr.pt(s + ds, 0.0, side * (w.t / 2.0 + dt));
            let yaw = ctx.prng.uniform(0.0, std::f64::consts::TAU);
            let part = Part { mat: RMat::WindowStone, poly: box2d(-ln / 2.0, ln / 2.0, 0.0, tm), t0: -tm / 2.0, t1: tm / 2.0 };
            drop_piece(ctx, p[0], p[2], yaw, &[part], ln, tm, 0.04, 0.15, 0.0, false);
        }
    }
    let mut src: Vec<(f64, usize, f64, f64, f64)> = Vec::new();
    for (wi, w) in walls.iter().enumerate() {
        for (v, s0, s1, lost) in w.debris_sources() {
            src.push((v, wi, s0, s1, lost));
        }
    }
    let total: f64 = src.iter().map(|s| s.0).sum();
    if total <= 0.0 {
        return;
    }
    let mut cum = Vec::with_capacity(src.len());
    let mut acc = 0.0;
    for s in &src {
        acc += s.0;
        cum.push(acc);
    }
    // big first, so small pieces settle on top
    for (kind, count, spread_k) in [
        (Debris::Chunk, ((total * 0.6 * amt) as usize).min(320), 0.8),
        (Debris::Block, ((total * 2.5 * amt) as usize).min(2200), 1.1),
        (Debris::Grit, ((total * 4.5 * amt) as usize).min(2600), 1.0),
    ] {
        for _ in 0..count {
            let u = ctx.prng.uniform(0.0, total);
            let (_, wi, s0, s1, lost) = src[cum.partition_point(|&c| c < u).min(src.len() - 1)];
            let s = ctx.prng.uniform(s0, s1);
            let side = ctx.prng.sign();
            let (parts, sx, sz, _) = debris_piece(ctx, kind);
            let yaw = ctx.prng.uniform(0.0, std::f64::consts::TAU);
            let spread = (0.35 + 0.22 * lost) * spread_k * if ctx.prng.random() < 0.2 { 3.0 } else { 1.0 };
            let w = &walls[wi];
            let mut dist = w.t / 2.0 + 0.08 + 0.5 * sx.max(sz) + ctx.prng.expovariate(1.0 / spread);
            for _ in 0..3 {
                let p = w.fr.pt(s, 0.0, side * dist);
                if drop_default(ctx, p[0], p[2], yaw, &parts, sx, sz, kind == Debris::Grit) {
                    break;
                }
                dist += 0.4;
            }
        }
    }
}

/// One course of a square pier in pier coordinates (u0, u1, w0, w1, v0, v1):
/// two bricks side by side, turned every other course, round a mortar core;
/// or one stone block per course in solid mode.
fn pier_course(ctx: &mut Ctx, k: usize, p: f64, ch: f64) -> Vec<(RMat, [f64; 6])> {
    let rng = &mut ctx.prng;
    let (w0, w1) = (k as f64 * ch, (k + 1) as f64 * ch);
    if !ctx.bricks {
        let (ou, ov) = (rng.gauss(0.0, 0.01), rng.gauss(0.0, 0.01));
        return vec![(RMat::Stone, [-p / 2.0 + ou, p / 2.0 + ou, w0, w1, -p / 2.0 + ov, p / 2.0 + ov])];
    }
    let (g, jd) = (ctx.gap, ctx.joint_depth);
    let mut parts = Vec::new();
    for (a0, a1) in [(-p / 2.0, -g / 2.0), (g / 2.0, p / 2.0)] {
        let m = rng.choice(&[RMat::Brick, RMat::Brick, RMat::Brick, RMat::BrickDark, RMat::BrickLight]);
        if k.is_multiple_of(2) {
            parts.push((m, [-p / 2.0, p / 2.0, w0 + g / 2.0, w1 - g / 2.0, a0, a1]));
        } else {
            parts.push((m, [a0, a1, w0 + g / 2.0, w1 - g / 2.0, -p / 2.0, p / 2.0]));
        }
    }
    parts.push((RMat::Mortar, [-p / 2.0 + jd, p / 2.0 - jd, (w0 - g / 2.0).max(0.0), w1 - g / 2.0 - 0.004, -p / 2.0 + jd, p / 2.0 - jd]));
    parts
}

/// A fallen pier piece: (is the capital, its courses, length, x, z, yaw).
type Fall = (bool, Vec<usize>, f64, f64, f64, f64);

/// A square masonry pier on a stone plinth, intact, broken off or toppled
/// (the fallen part lies in a line of chunks, still mortared together).
fn build_pillar(ctx: &mut Ctx, x: f64, z: f64, p: f64, h: f64, allowed: (f64, f64, f64, f64)) -> bool {
    let w = ctx.weathering;
    let base = ctx.ground.as_ref().unwrap().cells(x, z, 0.0, p / 2.0 + 0.25, p / 2.0 + 0.25);
    if !ctx.ground.as_ref().unwrap().free(base.as_deref()) {
        return false;
    }
    ctx.ground.as_mut().unwrap().block(base.as_deref());
    let (ph, cap_h) = (0.3, 0.25);
    let b = p / 2.0 + 0.08;
    ctx.mesh.new_piece();
    emit_box(&mut ctx.mesh, RMat::ArchStone, &WORLD, x - b, x + b, 0.0, ph, z - b, z + b);
    let ch = if ctx.bricks { ctx.course } else { 0.45 };
    let nk = (((h - ph - cap_h) / ch) as usize).max(4);
    let courses: Vec<Vec<(RMat, [f64; 6])>> = (0..nk).map(|k| pier_course(ctx, k, p, ch)).collect();
    let u = ctx.prng.random();
    let state = if u < 0.15 { 0 } else if u < 0.6 { 1 } else { 2 }; // intact, stump, fallen
    let keep = match state {
        0 => nk,
        1 => ctx.prng.randint(2, nk as i64 - 1) as usize,
        _ => ctx.prng.randint(0, 2) as usize,
    };
    for (k, course) in courses.iter().enumerate().take(keep) {
        let ragged = k == keep - 1 && state != 0;
        for &(mat, [u0, u1, w0, w1, v0, v1]) in course {
            if ragged && mat != RMat::Mortar && ctx.prng.random() < 0.3 + 0.3 * w {
                continue; // knocked off the broken top
            }
            let tilt = if ragged { 0.02 + 0.06 * w * ctx.prng.random() } else { 0.003 };
            let r = rot_matrix(ctx.prng.gauss(0.0, tilt), ctx.prng.gauss(0.0, tilt * 0.5), ctx.prng.gauss(0.0, tilt));
            let faces = prism_faces(&box2d(x + u0, x + u1, ph + w0, ph + w1), z + v0, z + v1, false, false);
            let pivot = [x + 0.5 * (u0 + u1), ph + w0, z + 0.5 * (v0 + v1)];
            ctx.mesh.new_piece();
            emit_faces(&mut ctx.mesh, mat, &WORLD, &faces, Some(&r), pivot, [0.0; 3]);
        }
    }
    if state == 0 {
        let c = p / 2.0 + 0.06;
        let y = ph + nk as f64 * ch;
        ctx.mesh.new_piece();
        emit_box(&mut ctx.mesh, RMat::ArchStone, &WORLD, x - c, x + c, y, y + cap_h, z - c, z + c);
        return true;
    }
    let mut rest: Vec<usize> = (keep..nk).collect();
    let mut pieces: Vec<(bool, Vec<usize>, f64)> = Vec::new(); // (is cap, courses, length)
    while !rest.is_empty() {
        let n = (ctx.prng.randint(2, 4) as usize).min(rest.len());
        let ks: Vec<usize> = rest.drain(..n).collect();
        let ln = ks.len() as f64 * ch;
        pieces.push((false, ks, ln));
    }
    if ctx.prng.random() < 0.7 {
        pieces.push((true, Vec::new(), p + 0.12));
    }
    let (ax0, az0, ax1, az1) = allowed;
    let mut plan: Option<Vec<Fall>> = None;
    for _ in 0..20 {
        // find a direction with room to fall
        let th = ctx.prng.uniform(0.0, std::f64::consts::TAU);
        let mut d = p / 2.0 + ctx.prng.uniform(0.15, 0.5);
        let mut trial = Vec::new();
        let mut ok = true;
        for (j, (cap, ks, ln)) in pieces.iter().enumerate() {
            let along = d + ln / 2.0;
            let lat = ctx.prng.gauss(0.0, 0.06 * (j + 1) as f64);
            let px = x + th.cos() * along - th.sin() * lat;
            let pz = z + th.sin() * along + th.cos() * lat;
            let yaw = th + ctx.prng.gauss(0.0, 0.15);
            let cells = ctx.ground.as_ref().unwrap().cells(px, pz, yaw, ln / 2.0 + 0.02, p / 2.0 + 0.1);
            let ends_in = [-1.0, 1.0].iter().all(|&sg| {
                let (qx, qz) = (px + sg * yaw.cos() * ln / 2.0, pz + sg * yaw.sin() * ln / 2.0);
                ax0 <= qx && qx <= ax1 && az0 <= qz && qz <= az1
            });
            if !ctx.ground.as_ref().unwrap().free(cells.as_deref()) || !ends_in {
                ok = false;
                break;
            }
            trial.push((*cap, ks.clone(), *ln, px, pz, yaw));
            d = along + ln / 2.0 + ctx.prng.uniform(0.05, 0.35) * (1.0 + 0.4 * j as f64);
        }
        if ok {
            plan = Some(trial);
            break;
        }
    }
    let Some(plan) = plan else { return true }; // no room: the fallen part was carted away
    for (cap, ks, ln, px, pz, yaw) in &plan {
        let (mut px, mut pz, mut ln) = (*px, *pz, *ln);
        let parts = if *cap {
            let c = p / 2.0 + 0.06;
            vec![Part { mat: RMat::ArchStone, poly: box2d(-c, c, 0.0, cap_h), t0: -c, t1: c }]
        } else {
            // courses lying on their side, still bonded
            let mut parts = Vec::new();
            for (j, &k) in ks.iter().enumerate() {
                for &(mat, [u0, u1, w0, w1, v0, v1]) in &courses[k] {
                    if ctx.bricks && mat != RMat::Mortar && (j == 0 || j == ks.len() - 1) && ctx.prng.random() < 0.15 + 0.2 * w {
                        continue; // broken ends lose a brick or two
                    }
                    let s0 = j as f64 * ch + (w0 - k as f64 * ch) - ln / 2.0;
                    let s1 = j as f64 * ch + (w1 - k as f64 * ch) - ln / 2.0;
                    parts.push(Part { mat, poly: box2d(s0, s1, u0 + p / 2.0, u1 + p / 2.0), t0: v0, t1: v1 });
                }
            }
            if !parts.is_empty() {
                // fit the footprint to what is left
                let lo = parts.iter().flat_map(|q| q.poly.iter().map(|v| v.0)).fold(f64::INFINITY, f64::min);
                let hi = parts.iter().flat_map(|q| q.poly.iter().map(|v| v.0)).fold(f64::NEG_INFINITY, f64::max);
                let mid = 0.5 * (lo + hi);
                for q in &mut parts {
                    for v in &mut q.poly {
                        v.0 -= mid;
                    }
                }
                px += yaw.cos() * mid;
                pz += yaw.sin() * mid;
                ln = hi - lo;
            }
            parts
        };
        drop_piece(ctx, px, pz, *yaw, &parts, ln, p, 0.05, 0.08, 0.01, false);
    }
    let n = if ctx.bricks { ctx.prng.randint(2, 6) } else { ctx.prng.randint(1, 3) };
    for _ in 0..n {
        // loose bits
        let i = (ctx.prng.random() * plan.len() as f64) as usize % plan.len();
        let (px, pz) = (plan[i].3, plan[i].4);
        let (parts, sx, sz, _) = debris_piece(ctx, Debris::Block);
        let (dx, dz) = (ctx.prng.gauss(0.0, 0.6), ctx.prng.gauss(0.0, 0.6));
        let yaw = ctx.prng.uniform(0.0, std::f64::consts::TAU);
        drop_default(ctx, px + dx, pz + dz, yaw, &parts, sx, sz, false);
    }
    true
}

/// (x, z, size, height, allowed rectangle x0, z0, x1, z1)
pub type Pier = (f64, f64, f64, f64, (f64, f64, f64, f64));

/// After the walls are built: piers, debris piles, moss and vines.
pub fn finish_scene(ctx: &mut Ctx, walls: &mut [Wall], piers: &[Pier]) {
    let (mut xs, mut zs) = (Vec::new(), Vec::new());
    for w in walls.iter() {
        for s in [0.0, w.l] {
            let p = w.fr.pt(s, 0.0, 0.0);
            xs.push(p[0]);
            zs.push(p[2]);
        }
    }
    for &(_, _, _, _, (ax0, az0, ax1, az1)) in piers {
        xs.extend([ax0, ax1]);
        zs.extend([az0, az1]);
    }
    let m = 8.0;
    let min = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let max = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mut ground = Ground::new(min(&xs) - m, min(&zs) - m, max(&xs) + m, max(&zs) + m);
    for w in walls.iter() {
        w.block_footprint(&mut ground);
    }
    ctx.ground = Some(ground);
    for &(x, z, r, h, allowed) in piers {
        if build_pillar(ctx, x, z, r, h, allowed) {
            ctx.n_pillars += 1;
        }
    }
    place_debris(ctx, walls);
    for w in walls.iter_mut() {
        w.emit_moss(ctx);
        w.emit_vines(ctx);
    }
}
