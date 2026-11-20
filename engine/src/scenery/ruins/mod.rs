//! Procedural ruins: a church and a castle, built wall by wall from
//! columns of solid intervals (nothing floats), as smooth stone or as
//! individual bricks, with windows, piers, debris piles, moss and vines.
//! Port of `ruins.py` (see `RUINS_IMPLEMENTATION.md`).
//!
//! The generator makes plain polygons (`geom::Mesh`); `make_ruin_with`
//! turns them into an `Asset`: one `Facet` per visible face, drawn by the
//! skinner in the chosen ASCII style, opaque `solids` from the wall cores,
//! vine leaves as sprites and colliders for the walking player.

pub mod geom;
pub mod scene;
pub mod wall;

use super::asset::{Asset, Facet, Sprite};
use super::params::{p, ParamDesc, Values};
use super::style::Mat;
use crate::math::Vec3;
use geom::*;
use scene::{finish_scene, Ground, Pier};
use std::f64::consts::PI;
use wall::{Kind as OKind, Op, Wall, INF};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RuinKind {
    Church,
    Castle,
}

impl RuinKind {
    pub const ALL: [RuinKind; 2] = [RuinKind::Church, RuinKind::Castle];
    pub fn name(self) -> &'static str {
        match self {
            RuinKind::Church => "church",
            RuinKind::Castle => "castle",
        }
    }
}

/// Everything one build needs: options, separate random streams (so
/// toggling an option doesn't reshuffle the rest), the mesh and the ground.
pub struct Ctx {
    pub rng: Rng,
    pub drng: Rng,
    pub vrng: Rng,
    pub prng: Rng,
    pub mesh: Mesh,
    pub bricks: bool,
    pub brick_len: f64,
    pub course: f64,
    pub gap: f64,
    pub joint_depth: f64,
    pub jitter: f64,
    pub damage: f64,
    pub intact_arches: f64,
    pub rubble: f64,
    pub glass: bool,
    pub glass_chance: f64,
    pub weathering: f64,
    pub vines: f64,
    pub moss: f64,
    /// Mullion pieces that fell: (wall, s, length, thickness).
    pub fallen: Vec<(usize, f64, f64, f64)>,
    pub ground: Option<Ground>,
    pub n_pillars: usize,
}

/// The options a ruin is built with.
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub bricks: bool,
    pub damage: f64,
    pub intact_arches: f64,
    pub rubble: f64,
    pub weathering: f64,
    pub moss: f64,
    pub vines: f64,
    pub glass: bool,
    pub pillars: bool,
    // church
    pub length: f64,
    pub width: f64,
    pub height: f64,
    pub tower_height: f64,
    pub bay: f64,
    // castle
    pub size: f64,
    pub wall_height: f64,
    pub tower_radius: f64,
    pub keep_size: f64,
    pub keep_height: f64,
    pub keep: bool,
}

impl Default for Options {
    fn default() -> Options {
        Options {
            bricks: true,
            damage: 0.6,
            intact_arches: 0.15,
            rubble: 1.0,
            weathering: 0.6,
            moss: 0.5,
            vines: 0.5,
            glass: true,
            pillars: true,
            length: 24.0,
            width: 12.0,
            height: 7.0,
            tower_height: 16.0,
            bay: 4.0,
            size: 36.0,
            wall_height: 9.0,
            tower_radius: 4.2,
            keep_size: 12.0,
            keep_height: 18.0,
            keep: true,
        }
    }
}

impl Options {
    /// Keep sizes in a range the layouts can handle.
    fn clamped(mut self) -> Options {
        self.length = self.length.max(10.0);
        self.width = self.width.max(6.0);
        self.height = self.height.max(3.5);
        self.tower_height = self.tower_height.max(self.height + 4.0);
        self.bay = self.bay.max(2.5);
        self.tower_radius = self.tower_radius.max(2.5);
        self.size = self.size.max(4.0 * self.tower_radius + 18.0);
        self.wall_height = self.wall_height.max(5.0);
        self.keep_size = self.keep_size.min(self.size - 2.0 * self.tower_radius - 10.0).max(7.0);
        self.keep_height = self.keep_height.max(10.0);
        self
    }
}

impl Ctx {
    pub fn new(o: &Options, seed: u64, brick: (f64, f64)) -> Ctx {
        Ctx {
            rng: Rng::new(seed),
            drng: Rng::new(seed.wrapping_mul(7).wrapping_add(3)),
            vrng: Rng::new(seed.wrapping_mul(11).wrapping_add(5)),
            prng: Rng::new(seed.wrapping_mul(13).wrapping_add(7)),
            mesh: Mesh::new(),
            bricks: o.bricks,
            brick_len: brick.0.max(0.1),
            course: brick.1.max(0.05),
            gap: 0.02,
            joint_depth: 0.03,
            jitter: 0.01,
            damage: o.damage.clamp(0.0, 1.0),
            intact_arches: o.intact_arches.clamp(0.0, 1.0),
            rubble: o.rubble.max(0.0),
            glass: o.glass,
            glass_chance: 0.8,
            weathering: o.weathering.clamp(0.0, 1.0),
            vines: o.vines.max(0.0),
            moss: o.moss.max(0.0),
            fallen: Vec::new(),
            ground: None,
            n_pillars: 0,
        }
    }
}

fn op() -> Op {
    Op::default()
}

// --------------------------------------------------------------------- church

fn build_church(a: &Options, ctx: &mut Ctx) -> (Vec<Wall>, Vec<Pier>) {
    let (l, w, h, ht) = (a.length, a.width, a.height, a.tower_height);
    let t = 0.8;
    let tw = (w * 0.42).clamp(3.6, 5.5); // tower size (centre lines)
    let nb = ((l / a.bay).round() as usize).max(2);
    let bay = l / nb as f64;
    let gable = w * 0.4;
    let mut walls = Vec::new();

    // long walls run through the corners, end walls sit between them
    let (ls, st) = (l + t, tw + t);
    let mut north = Wall::new((-w / 2.0, -l / 2.0 - t / 2.0), (-w / 2.0, l / 2.0 + t / 2.0), t, Profile::new(vec![(0.0, ht), (st, ht), (st, h), (ls, h)]));
    north.keep(tw - 0.1, st + 0.1, INF); // where the tower's back wall joins
    let mut south = Wall::new((w / 2.0, -l / 2.0 - t / 2.0), (w / 2.0, l / 2.0 + t / 2.0), t, flat_profile(ls, h));
    let ww = (1.5f64).min(bay * 0.38);
    for (wall, start) in [(&mut north, st + 0.5), (&mut south, 0.0)] {
        for kb in 0..nb {
            let s = (kb as f64 + 0.5) * bay + t / 2.0;
            if s - ww / 2.0 >= start {
                wall.add_opening(s, ww, (1.8f64).min(h * 0.26), Op { lights: if ww >= 1.2 { 2 } else { 1 }, ..op() });
            }
        }
    }
    north.add_opening(st / 2.0, 1.1, 0.0, Op { kind: OKind::Door, spring: Some(2.2), ring: 0.3, strong: true, ..op() });
    for ds in [-0.75, 0.75] {
        north.add_opening(st / 2.0 + ds, 0.7, ht - 3.8, Op { ring: 0.25, glass: false, margin: 0.5, ..op() });
    }

    let lf = w - t;
    let mut front = Wall::new((-w / 2.0 + t / 2.0, -l / 2.0), (w / 2.0 - t / 2.0, -l / 2.0), t, gable_profile(lf, h, gable)).caps(false, false).end_len(0.4);
    let mut back = Wall::new((-w / 2.0 + t / 2.0, l / 2.0), (w / 2.0 - t / 2.0, l / 2.0), t, gable_profile(lf, h, gable)).caps(false, false).end_len(0.4);
    if let Some(d) = front.add_opening(lf / 2.0, (2.6f64).min(w * 0.22), 0.0, Op { kind: OKind::Door, spring: Some((2.8f64).min(h * 0.4)), ring: 0.45, strong: true, ..op() }) {
        let top = front.openings[d].ext_apex();
        front.add_opening(lf / 2.0, (1.8f64).min(w * 0.15), top + 0.9, Op { lights: 2, margin: 0.6, ..op() });
    }
    let ew = (5.0f64).min(lf * 0.42);
    back.add_opening(lf / 2.0, ew, (1.5f64).max(h * 0.3), Op { lights: if ew >= 2.6 { 3 } else { 2 }, k: 0.8, ring: 0.45, margin: 0.6, strong: true, ..op() });

    let mut arcades = Vec::new();
    if w >= 9.0 {
        // nave arcades: rows of pointed arches between nave and aisles
        let (xa, la, pw) = (w / 4.0, l - t, 0.95);
        let ring = (0.45f64).min(pw / 2.0 - 0.08);
        for side in [-1.0, 1.0] {
            let mut arc = Wall::new((side * xa, -l / 2.0 + t / 2.0), (side * xa, l / 2.0 - t / 2.0), 0.9, flat_profile(la, h)).caps(false, false).end_len(0.5);
            for kb in 0..nb {
                let a0 = (kb as f64 * bay - t / 2.0 + pw / 2.0).max(ring + 0.45);
                let b0 = ((kb + 1) as f64 * bay - t / 2.0 - pw / 2.0).min(la - ring - 0.45);
                arc.add_opening(0.5 * (a0 + b0), b0 - a0, 0.0, Op { kind: OKind::Arcade, ring, ..op() });
            }
            arcades.push(arc);
            let sx = side * xa + w / 2.0 - t / 2.0;
            front.keep(sx - 0.65, sx + 0.65, INF);
            back.keep(sx - 0.65, sx + 0.65, INF);
        }
    }
    walls.extend([north, south, front, back]);
    walls.extend(arcades);

    let xt = -w / 2.0 - tw;
    let mut tower = vec![
        Wall::new((xt, -l / 2.0 - t / 2.0), (xt, -l / 2.0 + tw + t / 2.0), t, flat_profile(tw + t, ht)).damage(0.7),
        Wall::new((xt + t / 2.0, -l / 2.0), (-w / 2.0 - t / 2.0, -l / 2.0), t, flat_profile(tw - t, ht)).caps(false, false).end_len(0.3).damage(0.7),
        Wall::new((xt + t / 2.0, -l / 2.0 + tw), (-w / 2.0 - t / 2.0, -l / 2.0 + tw), t, flat_profile(tw - t, ht)).caps(false, false).end_len(0.3).damage(0.7),
    ];
    for wall in &mut tower {
        let c = wall.l / 2.0;
        for ds in [-0.75, 0.75] {
            wall.add_opening(c + ds, 0.7, ht - 3.8, Op { ring: 0.25, glass: false, margin: 0.5, ..op() });
        }
        wall.add_opening(c, 0.55, ht * 0.42, Op { spring: Some(ht * 0.42 + 1.3), ring: 0.25, glass: false, ..op() });
    }
    walls.extend(tower);

    let mut piers = Vec::new();
    if a.pillars {
        // ruined cloister on the south side
        let c = (l * 0.38).clamp(5.0, 9.0);
        let (xa0, xa1) = (w / 2.0 + t / 2.0 + 0.8, w / 2.0 + t / 2.0 + c);
        let lc = (l - 2.0).min(c * 1.6);
        let allowed = (w / 2.0 + t / 2.0 + 0.35, -lc / 2.0 - 4.5, xa1 + 5.0, lc / 2.0 + 4.5);
        let (r, ph) = (ctx.brick_len.clamp(0.5, 1.2), (3.6f64).min(h * 0.6));
        let nz = ((lc / 2.6).round() as usize).max(2);
        for i in 0..=nz {
            piers.push((xa1, -lc / 2.0 + lc * i as f64 / nz as f64, r, ph, allowed));
        }
        let nxp = (((xa1 - xa0 - 1.3) / 2.6).round() as usize).max(1);
        for zc in [-lc / 2.0, lc / 2.0] {
            for i in 0..nxp {
                piers.push((xa0 + 1.3 + (xa1 - xa0 - 1.3) * i as f64 / nxp as f64, zc, r, ph, allowed));
            }
        }
    }
    (walls, piers)
}

// --------------------------------------------------------------------- castle

fn build_castle(a: &Options, ctx: &mut Ctx) -> (Vec<Wall>, Vec<Pier>) {
    let (s, hc, ra) = (a.size, a.wall_height, a.tower_radius);
    let (tc, tt, mh) = (2.2, 1.8, 1.0);
    let ht = hc + 4.0;
    let half = s / 2.0;
    let mut walls: Vec<Wall> = Vec::new();

    // Octagonal tower; segments share damage values at the corners.
    #[allow(clippy::too_many_arguments)]
    let ring = |walls: &mut Vec<Wall>, ctx: &mut Ctx, cx: f64, cz: f64, rad: f64, t: f64, h: f64, blocked: &[(f64, f64)], door: Option<(f64, f64)>, levels: &[f64]| {
        let dmg = 0.75;
        let n = 8usize;
        let rc = rad / (PI / n as f64).cos();
        let e = 0.5 * t * (PI / n as f64).tan();
        let verts: Vec<P2> = (0..n)
            .map(|k| {
                let a = PI / n as f64 + 2.0 * PI * k as f64 / n as f64;
                (cx + rc * a.cos(), cz + rc * a.sin())
            })
            .collect();
        let amount = ctx.damage * dmg;
        let node: Vec<f64> = (0..n).map(|_| (1.0 - amount * (0.2 + 0.8 * ctx.rng.random())).max(0.05)).collect();
        for k in 0..n {
            let ((x0, z0), (x1, z1)) = (verts[k], verts[(k + 1) % n]);
            let dl = (x1 - x0).hypot(z1 - z0);
            let (dx, dz) = ((x1 - x0) / dl, (z1 - z0) / dl);
            let ls = dl + 2.0 * e;
            // a segment's hidden end reaches into its neighbour, so that much
            // of each end keeps the shared corner height
            let a_ext = 2.0 * PI / n as f64;
            let reach = e + e * a_ext.cos() + 0.5 * t * a_ext.sin() + 0.1;
            let mut w = Wall::new((x0 - dx * e, z0 - dz * e), (x1 + dx * e, z1 + dz * e), t, crenel_profile(ls, h, mh, reach))
                .caps(false, false)
                .ends((node[k], node[(k + 1) % n]), reach)
                .damage(dmg)
                .clear((reach, reach));
            w.miter = e;
            let ang = 2.0 * PI * (k + 1) as f64 / n as f64;
            let (nx, nz) = (ang.cos(), ang.sin());
            if blocked.iter().any(|&(bx, bz)| nx * bx + nz * bz > 0.9) {
            } else if door.is_some_and(|d| nx * d.0 + nz * d.1 > 0.9) {
                let dw = (1.3f64).min(ls - 2.0 * reach - 0.45);
                if dw >= 0.8 {
                    w.add_opening(ls / 2.0, dw, 0.0, Op { kind: OKind::Door, spring: Some(2.2), ring: 0.2, strong: true, ..op() });
                }
            } else {
                for &y in levels {
                    w.add_opening(ls / 2.0, 0.3, y, Op { kind: OKind::Slit, spring: Some(y + 1.3), k: 0.5, ring: 0.15, intact: Some(false), margin: 0.4, ..op() });
                }
            }
            walls.push(w);
        }
    };

    let r2 = 0.5f64.sqrt();
    for (cx, cz) in [(-half, -half), (half, -half), (half, half), (-half, half)] {
        let (sx, sz) = (if cx > 0.0 { -1.0 } else { 1.0 }, if cz > 0.0 { -1.0 } else { 1.0 });
        ring(&mut walls, ctx, cx, cz, ra, tt, ht, &[(sx, 0.0), (0.0, sz)], Some((sx * r2, sz * r2)), &[2.0, ht * 0.55]);
    }
    let (gate_w, ring_g, rg, tg) = (3.6, 0.5, 3.0, 1.6);
    let gx = gate_w / 2.0 + ring_g + tg / 2.0 + rg + 0.15;
    for sx in [-1.0, 1.0] {
        ring(&mut walls, ctx, sx * gx, half, rg, tg, hc + 3.0, &[(1.0, 0.0), (-1.0, 0.0)], Some((0.0, -1.0)), &[2.0, (hc + 3.0) * 0.55]);
    }

    let curtain = |walls: &mut Vec<Wall>, ctx: &mut Ctx, p0: P2, p1: P2, gate: bool| {
        let lw = (p1.0 - p0.0).hypot(p1.1 - p0.1);
        let f = (ctx.rng.uniform(0.5, 1.0), ctx.rng.uniform(0.5, 1.0));
        let mut w = Wall::new(p0, p1, tc, crenel_profile(lw, hc, mh, 0.9)).ends(f, 1.2);
        if gate {
            w.add_opening(lw / 2.0, gate_w, 0.0, Op { kind: OKind::Door, spring: Some((3.8f64).min(hc * 0.45)), k: 0.75, ring: ring_g, strong: true, ..op() });
        } else {
            let n = ((lw / 7.0).floor() as usize).max(1);
            for i in 0..n {
                w.add_opening((i as f64 + 0.5) * lw / n as f64, 0.3, 2.2, Op { kind: OKind::Slit, spring: Some(3.5), k: 0.5, ring: 0.15, intact: Some(false), ..op() });
            }
        }
        walls.push(w);
    };
    curtain(&mut walls, ctx, (-half + ra, -half), (half - ra, -half), false);
    curtain(&mut walls, ctx, (half, -half + ra), (half, half - ra), false);
    curtain(&mut walls, ctx, (-half, half - ra), (-half, -half + ra), false);
    if half - ra > gx + rg + 2.0 {
        curtain(&mut walls, ctx, (-half + ra, half), (-gx - rg, half), false);
        curtain(&mut walls, ctx, (gx + rg, half), (half - ra, half), false);
    }
    curtain(&mut walls, ctx, (-gx + rg, half), (gx - rg, half), true);

    if a.keep {
        let (k, hk, tk) = (a.keep_size, a.keep_height, 2.2);
        let kz = -half + tc / 2.0 + 2.5 + k / 2.0;
        let c = [(-k / 2.0, kz - k / 2.0), (k / 2.0, kz - k / 2.0), (k / 2.0, kz + k / 2.0), (-k / 2.0, kz + k / 2.0)];
        for i in 0..4 {
            // pinwheel corners: each wall runs through one corner
            let ((ax, az), (bx, bz)) = (c[i], c[(i + 1) % 4]);
            let (dx, dz) = ((bx - ax) / k, (bz - az) / k);
            let mut w = Wall::new((ax + dx * tk / 2.0, az + dz * tk / 2.0), (bx + dx * tk / 2.0, bz + dz * tk / 2.0), tk, crenel_profile(k, hk, mh, tk + 0.3))
                .caps(false, true)
                .end_len(tk)
                .damage(0.8)
                .clear((0.15, tk + 0.15));
            if i == 2 {
                w.add_opening(k / 2.0, 1.6, 0.0, Op { kind: OKind::Door, spring: Some(2.6), ring: 0.4, strong: true, ..op() });
            } else {
                w.add_opening(k / 2.0, 0.3, 2.5, Op { kind: OKind::Slit, spring: Some(3.8), k: 0.5, ring: 0.15, intact: Some(false), ..op() });
            }
            for sp in [k * 0.3, k * 0.7] {
                w.add_opening(sp, 1.0, hk * 0.36, Op { spring: Some(hk * 0.36 + 1.6), k: 0.8, ring: 0.3, ..op() });
            }
            w.add_opening(k / 2.0, 1.5, hk * 0.62, Op { spring: Some(hk * 0.62 + 2.0), lights: 2, k: 0.8, ..op() });
            walls.push(w);
        }
    }

    let mut piers = Vec::new();
    if a.pillars {
        // colonnade of a vanished great hall along the east wall
        let xc = half - tc / 2.0 - 6.0;
        let allowed = (-half + tc / 2.0 + 0.6, -half + tc / 2.0 + 0.6, half - tc / 2.0 - 0.6, half - tc / 2.0 - 0.6);
        let (z0, z1) = (-half + ra + 4.0, half - ra - 4.0);
        let nz = (((z1 - z0) / 3.2).round() as usize).max(2);
        for i in 0..=nz {
            piers.push((xc, z0 + (z1 - z0) * i as f64 / nz as f64, ctx.brick_len.clamp(0.5, 1.2), (5.5f64).min(hc * 0.6), allowed));
        }
    }
    (walls, piers)
}

/// The finished polygons of a ruin and the walls' colliders.
pub struct Built {
    pub mesh: Mesh,
    pub colliders: Vec<[f64; 3]>,
}

/// Build a ruin's polygons.
pub fn build(kind: RuinKind, seed: u64, o: &Options) -> Built {
    let o = o.clamped();
    let brick = match kind {
        RuinKind::Church => (0.6, 0.3),
        RuinKind::Castle => (0.9, 0.45),
    };
    let mut ctx = Ctx::new(&o, seed.wrapping_mul(1000).wrapping_add(kind as u64), brick);
    let (mut walls, piers) = match kind {
        RuinKind::Church => build_church(&o, &mut ctx),
        RuinKind::Castle => build_castle(&o, &mut ctx),
    };
    for (i, w) in walls.iter_mut().enumerate() {
        w.build(&mut ctx, i);
    }
    finish_scene(&mut ctx, &mut walls, &piers);
    let mut colliders: Vec<[f64; 3]> = walls.iter().flat_map(|w| w.colliders()).collect();
    for &(x, z, r, _, _) in &piers {
        colliders.push([x, z, r * 0.6]);
    }
    Built { mesh: ctx.mesh, colliders }
}

// ---------------------------------------------------------------- parameters

/// The settings a ruin can change (the object brush's sliders).
pub fn ruin_params(kind: RuinKind) -> Vec<ParamDesc> {
    let mut v = vec![
        p("style", "ASCII style (A-D)", 0.0, 3.0, 1.0, 0.0),
        p("bricks", "individual bricks", 0.0, 1.0, 1.0, 1.0),
        p("damage", "damage", 0.0, 1.0, 0.05, 0.6),
        p("arches", "arches kept", 0.0, 1.0, 0.05, 0.15),
        p("rubble", "rubble", 0.0, 3.0, 0.1, 1.0),
        p("weathering", "weathering", 0.0, 1.0, 0.05, 0.6),
        p("moss", "moss", 0.0, 2.0, 0.1, 0.5),
        p("vines", "vines", 0.0, 2.0, 0.1, 0.5),
        p("glass", "stained glass", 0.0, 1.0, 1.0, 1.0),
        p("pillars", "pillars", 0.0, 1.0, 1.0, 1.0),
    ];
    match kind {
        RuinKind::Church => v.extend([
            p("length", "length (m)", 10.0, 48.0, 1.0, 24.0),
            p("width", "width (m)", 6.0, 24.0, 1.0, 12.0),
            p("height", "wall height (m)", 3.5, 14.0, 0.5, 7.0),
            p("tower", "tower height (m)", 7.5, 30.0, 0.5, 16.0),
            p("bay", "bay (m)", 2.5, 8.0, 0.5, 4.0),
        ]),
        RuinKind::Castle => v.extend([
            p("size", "size (m)", 28.0, 72.0, 1.0, 36.0),
            p("wallheight", "wall height (m)", 5.0, 16.0, 0.5, 9.0),
            p("towerradius", "tower radius (m)", 2.5, 7.0, 0.1, 4.2),
            p("keepsize", "keep size (m)", 7.0, 24.0, 0.5, 12.0),
            p("keepheight", "keep height (m)", 10.0, 30.0, 0.5, 18.0),
            p("keep", "keep", 0.0, 1.0, 1.0, 1.0),
        ]),
    }
    v
}

fn options_from(kind: RuinKind, v: &Values) -> Options {
    let mut o = Options {
        bricks: v.get("bricks") > 0.5,
        damage: v.get("damage") as f64,
        intact_arches: v.get("arches") as f64,
        rubble: v.get("rubble") as f64,
        weathering: v.get("weathering") as f64,
        moss: v.get("moss") as f64,
        vines: v.get("vines") as f64,
        glass: v.get("glass") > 0.5,
        pillars: v.get("pillars") > 0.5,
        ..Options::default()
    };
    match kind {
        RuinKind::Church => {
            o.length = v.get("length") as f64;
            o.width = v.get("width") as f64;
            o.height = v.get("height") as f64;
            o.tower_height = v.get("tower") as f64;
            o.bay = v.get("bay") as f64;
        }
        RuinKind::Castle => {
            o.size = v.get("size") as f64;
            o.wall_height = v.get("wallheight") as f64;
            o.tower_radius = v.get("towerradius") as f64;
            o.keep_size = v.get("keepsize") as f64;
            o.keep_height = v.get("keepheight") as f64;
            o.keep = v.get("keep") > 0.5;
        }
    }
    o
}

pub fn make_ruin(seed: u32, kind: RuinKind) -> Asset {
    let d = ruin_params(kind);
    make_ruin_with(seed, kind, &Values::new(&d, &[]))
}

pub fn make_ruin_with(seed: u32, kind: RuinKind, v: &Values) -> Asset {
    let o = options_from(kind, v);
    let built = build(kind, seed as u64, &o);
    to_asset(kind, built, v.int("style").min(3) as u8)
}

/// A short ruined brick wall with a window, rubble, moss and a vine: a
/// sample to compare the ASCII styles up close (the "ruins" gallery).
pub fn wall_sample(seed: u32, style: u8) -> Asset {
    let o = Options::default();
    let mut ctx = Ctx::new(&o, seed as u64 * 1000 + 5, (0.6, 0.3));
    let mut w = Wall::new((-2.75, 0.0), (2.75, 0.0), 0.8, flat_profile(5.5, 3.8)).ends((0.95, 0.5), 0.8);
    w.add_opening(2.75, 1.2, 1.1, Op { lights: 2, intact: Some(true), ..op() });
    let mut walls = vec![w];
    walls[0].build(&mut ctx, 0);
    finish_scene(&mut ctx, &mut walls, &[]);
    let colliders = walls[0].colliders();
    to_asset(RuinKind::Church, Built { mesh: ctx.mesh, colliders }, style)
}

fn v3(p: V) -> Vec3 {
    Vec3::new(p[0] as f32, p[1] as f32, p[2] as f32)
}

/// Polygons -> asset: drawn faces, opaque solids, leaves as sprites.
fn to_asset(kind: RuinKind, b: Built, style: u8) -> Asset {
    let mut a = Asset::new(format!("ruin_{}", kind.name()));
    a.face_style = style;
    for f in &b.mesh.faces {
        if !f.show {
            continue;
        }
        let n = v3(f.n);
        let pts: Vec<Vec3> = f.pts.iter().map(|&p| v3(p)).collect();
        if matches!(f.mat, RMat::Leaf | RMat::LeafDark) {
            // a vine leaf: one leaf glyph, flat on the leaf
            let k = pts.len() as f32;
            let c = pts.iter().fold(Vec3::ZERO, |s, &p| s + p) * (1.0 / k);
            let axis = super::asset::unit(pts[0] - c);
            let size = (pts[0] - c).length() * 1.6;
            let mat = if f.mat == RMat::Leaf { Mat::PlantLeaf } else { Mat::LeafBox };
            a.sprites.push(Sprite { pos: c, axis, normal: n, size, mat, thin: 1.0 });
            continue;
        }
        let (mat, unit) = match f.mat {
            RMat::Brick | RMat::BrickDark | RMat::BrickLight => (Mat::Brick, true),
            RMat::ArchStone | RMat::WindowStone | RMat::PillarStone | RMat::Rubble => (Mat::Masonry, true),
            RMat::Stone | RMat::Lead | RMat::Mortar => (Mat::Masonry, false),
            RMat::Moss => (Mat::Moss, false),
            RMat::Vine => (Mat::Twig, false),
            m if m.is_glass() => (Mat::Glass, false),
            _ => (Mat::Masonry, false),
        };
        a.faces.push(Facet { pts, normal: n, color: f.mat.color(), mat, piece: f.piece, unit });
    }
    for poly in &b.mesh.occ {
        let p0 = v3(poly[0]);
        for i in 1..poly.len() - 1 {
            a.solids.push([p0, v3(poly[i]), v3(poly[i + 1])]);
        }
    }
    a.colliders = b.colliders.iter().map(|c| [c[0] as f32, c[1] as f32, c[2] as f32]).collect();
    a
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(m: &Mesh, f: impl Fn(&Face) -> bool) -> usize {
        m.faces.iter().filter(|x| f(x)).count()
    }

    #[test]
    fn both_ruins_build_in_bricks_and_in_stone() {
        for kind in RuinKind::ALL {
            for bricks in [true, false] {
                let t0 = std::time::Instant::now();
                let b = build(kind, 42, &Options { bricks, ..Options::default() });
                let shown = count(&b.mesh, |f| f.show);
                eprintln!(
                    "{} bricks={bricks}: {} faces ({shown} shown), {} occluders, {} pieces, {} colliders, {:.0} ms",
                    kind.name(),
                    b.mesh.faces.len(),
                    b.mesh.occ.len(),
                    b.mesh.pieces,
                    b.colliders.len(),
                    t0.elapsed().as_secs_f64() * 1e3
                );
                assert!(shown > 500, "a ruin has walls");
                assert!(b.mesh.faces.iter().all(|f| f.pts.iter().all(|p| p.iter().all(|v| v.is_finite()))));
                if bricks {
                    assert!(count(&b.mesh, |f| matches!(f.mat, RMat::Brick | RMat::BrickDark | RMat::BrickLight)) > 1000);
                } else {
                    assert!(count(&b.mesh, |f| f.mat == RMat::Stone) > 100);
                }
                assert!(!b.colliders.is_empty());
            }
        }
    }

    #[test]
    fn nothing_floats_wall_intervals_reach_the_ground() {
        // Every surviving interval is connected to the ground: check that no
        // wall face (not debris, moss, vines) lies entirely high above
        // everything below it, by the flood fill invariant on columns.
        let o = Options { bricks: false, ..Options::default() };
        let mut ctx = Ctx::new(&o, 7, (0.6, 0.3));
        let (mut walls, _) = build_church(&o, &mut ctx);
        for (i, w) in walls.iter_mut().enumerate() {
            w.build(&mut ctx, i);
        }
        for w in &walls {
            for (i, c) in w.cols.iter().enumerate() {
                for iv in &c.ivs {
                    if iv[0] <= 1e-6 && iv[1] <= 1e-6 {
                        continue;
                    }
                    let touches = |k: usize, right: bool| {
                        w.cols.get(k).is_some_and(|n| {
                            n.ivs.iter().any(|b| {
                                let (lo, hi) = if right { (iv[1].max(b[0]), iv[3].min(b[2])) } else { (iv[0].max(b[1]), iv[2].min(b[3])) };
                                hi - lo > 0.04
                            })
                        })
                    };
                    assert!(touches(i + 1, true) || (i > 0 && touches(i - 1, false)), "a raised interval rests on a neighbour");
                }
            }
        }
    }

    #[test]
    fn the_same_seed_builds_the_same_ruin() {
        let a = build(RuinKind::Church, 3, &Options::default());
        let b = build(RuinKind::Church, 3, &Options::default());
        assert_eq!(a.mesh.faces.len(), b.mesh.faces.len());
        let c = build(RuinKind::Church, 4, &Options::default());
        assert_ne!(a.mesh.faces.len(), c.mesh.faces.len());
    }

    #[test]
    fn extremes_do_not_crash() {
        for kind in RuinKind::ALL {
            for (damage, rubble, green) in [(0.0, 0.0, 0.0), (1.0, 3.0, 2.0)] {
                let o = Options { damage, rubble, moss: green, vines: green, ..Options::default() };
                let b = build(kind, 11, &o);
                assert!(!b.mesh.faces.is_empty());
            }
        }
        let small = Options { length: 10.0, width: 6.0, height: 3.5, size: 10.0, ..Options::default() };
        build(RuinKind::Church, 1, &small);
        build(RuinKind::Castle, 1, &small);
    }
}
